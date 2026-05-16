import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";
import { applyDerivedKiroCacheUsage, estimateInputTokens, estimateKiroOutputTokens } from "../utils/usageTracking.js";

const KIRO_CONTEXT_WINDOWS = {
  auto: 200000,
  "claude-opus-4.7": 1000000,
  "claude-opus-4.6": 1000000,
  "claude-opus-4.5": 200000,
  "claude-sonnet-4.6": 1000000,
  "claude-sonnet-4.5": 200000,
  "claude-sonnet-4.0": 200000,
  "claude-sonnet-4": 200000,
  "claude-haiku-4.5": 200000,
  "deepseek-3.2": 128000,
  "minimax-m2.5": 200000,
  "minimax-m2.1": 200000,
  "glm-5": 200000,
  "qwen3-coder-next": 256000
};

const KIRO_DEFAULT_MAX_PAYLOAD_BYTES = 580 * 1024;
const KIRO_MIN_CURRENT_MESSAGE_CHARS = 256;

function getKiroPayloadSizeBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function trimKiroPayloadToFit(payload, maxBytes, log) {
  const trimmedPayload = JSON.parse(JSON.stringify(payload));
  const trimmedHistory = trimmedPayload.conversationState?.history;
  const currentMessage = trimmedPayload?.conversationState?.currentMessage?.userInputMessage;
  const originalCurrentContent = currentMessage?.content || "";
  let removedMessages = 0;
  let currentMessageTrimmed = false;
  let bytes = getKiroPayloadSizeBytes(trimmedPayload);

  while (Array.isArray(trimmedHistory) && trimmedHistory.length > 0 && bytes > maxBytes) {
    trimmedHistory.shift();
    removedMessages++;
    bytes = getKiroPayloadSizeBytes(trimmedPayload);
  }

  if (bytes > maxBytes && typeof originalCurrentContent === "string" && originalCurrentContent.length > KIRO_MIN_CURRENT_MESSAGE_CHARS) {
    let keepChars = Math.max(KIRO_MIN_CURRENT_MESSAGE_CHARS, Math.floor(originalCurrentContent.length * 0.9));
    while (bytes > maxBytes && keepChars > KIRO_MIN_CURRENT_MESSAGE_CHARS) {
      currentMessage.content = `${originalCurrentContent.slice(0, keepChars)}\n\n[Truncated by gateway: original prompt exceeded Kiro payload limit.]`;
      currentMessageTrimmed = true;
      bytes = getKiroPayloadSizeBytes(trimmedPayload);
      keepChars = Math.max(KIRO_MIN_CURRENT_MESSAGE_CHARS, Math.floor(keepChars * 0.85));
    }
  }

  if (removedMessages > 0 || currentMessageTrimmed) {
    log?.warn?.("KIRO_PAYLOAD", "Trimmed oversized Kiro payload", {
      maxBytes,
      finalBytes: bytes,
      removedMessages,
      currentMessageTrimmed
    });
  }

  return {
    payload: trimmedPayload,
    trimmed: removedMessages > 0 || currentMessageTrimmed,
    bytes,
    removedMessages,
    currentMessageTrimmed
  };
}

function getKiroContextWindow(model) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  return KIRO_CONTEXT_WINDOWS[normalizedModel] || 200000;
}

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor() {
    super("kiro", PROVIDERS.kiro);
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4()
    };

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response with retry support
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model, stream, 0);
    const transformedBody = this.transformRequest(model, body, stream, credentials);
    const payloadLimit = Number(process.env.KIRO_MAX_PAYLOAD_BYTES || KIRO_DEFAULT_MAX_PAYLOAD_BYTES);
    const { payload: requestBody, bytes: payloadBytes, trimmed, removedMessages, currentMessageTrimmed } = trimKiroPayloadToFit(transformedBody, payloadLimit, log);
    
    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    let retryAttempts = 0;

    while (true) {
      const headers = this.buildHeaders(credentials, stream);
      const serializedBody = JSON.stringify(requestBody);

      log?.debug?.("KIRO_REQUEST", "Prepared Kiro upstream request", {
        payloadBytes,
        payloadLimit,
        trimmed,
        removedMessages,
        currentMessageTrimmed,
        historyLength: requestBody?.conversationState?.history?.length || 0,
        hasProfileArn: !!requestBody?.profileArn,
        hasAccessToken: !!credentials?.accessToken,
        authMethod: credentials?.providerSpecificData?.authMethod || null,
        region: credentials?.providerSpecificData?.region || null,
        usesOidcRefresh: !!(credentials?.providerSpecificData?.clientId && credentials?.providerSpecificData?.clientSecret)
      });
      
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: serializedBody,
        signal
      }, proxyOptions);

      if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN) {
        log?.warn?.("KIRO_AUTH", "Kiro upstream auth rejected request", {
          status: response.status,
          hasAccessToken: !!credentials?.accessToken,
          authMethod: credentials?.providerSpecificData?.authMethod || null,
          region: credentials?.providerSpecificData?.region || null,
          hasClientId: !!credentials?.providerSpecificData?.clientId,
          hasClientSecret: !!credentials?.providerSpecificData?.clientSecret,
          hasProfileArn: !!requestBody?.profileArn,
          payloadBytes
        });
      }

      // Check if should retry based on status code
      const { attempts: maxRetries, delayMs } = resolveRetryEntry(retryConfig[response.status]);
      if (!response.ok && maxRetries > 0 && retryAttempts < maxRetries) {
        retryAttempts++;
        log?.debug?.("RETRY", `${response.status} retry ${retryAttempts}/${maxRetries} after ${delayMs / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        return { response, url, headers, transformedBody: requestBody };
      }

      // Success - transform and return
      // For Kiro, we need to transform the binary EventStream to SSE
      // Create a TransformStream to convert binary to SSE text
      const transformedResponse = this.transformEventStreamToSSE(response, model, requestBody);
      return { response: transformedResponse, url, headers, transformedBody: requestBody };
    }
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout
   */
  transformEventStreamToSSE(response, model, requestBody = null) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const state = {
      endDetected: false,
      finishEmitted: false,
      hasToolCalls: false,
      toolCallIndex: 0,
      seenToolIds: new Map()
    };

    const ensureUsage = () => {
      if (!state.usage?.prompt_tokens && requestBody) {
        const estimatedInputTokens = state.contextUsagePercentage > 0
          ? Math.floor(state.contextUsagePercentage * getKiroContextWindow(model) / 100)
          : estimateInputTokens(requestBody);
        const estimatedOutputTokens = estimateKiroOutputTokens(state.fullContent || "");
        state.usage = {
          ...(state.usage || {}),
          prompt_tokens: estimatedInputTokens,
          completion_tokens: estimatedOutputTokens,
          total_tokens: estimatedInputTokens + estimatedOutputTokens,
          estimated: true
        };
      }

      if (state.usage) {
        state.usage = applyDerivedKiroCacheUsage(model, state.usage);
      }
    };

    const emitFinishChunk = (controller) => {
      if (state.finishEmitted) return;
      state.finishEmitted = true;
      ensureUsage();

      const finishChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
        }]
      };

      if (state.usage) {
        finishChunk.usage = state.usage;
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
    };

    const maybeEmitFinishChunk = (controller) => {
      if (!state.endDetected) return;
      if (!state.hasMeteringEvent && !state.usage?.prompt_tokens) return;
      emitFinishChunk(controller);
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;

        // Parse events from buffer
        let iterations = 0;
        const maxIterations = 1000;
        while (buffer.length >= 16 && iterations < maxIterations) {
          iterations++;
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const totalLength = view.getUint32(0, false);

          if (totalLength < 16 || totalLength > buffer.length || buffer.length < totalLength) break;

          const eventData = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);

          const event = parseEventFrame(eventData);
          if (!event) continue;

          const eventType = event.headers[":event-type"] || "";
          
          // Track total content length for token estimation
          if (!state.totalContentLength) state.totalContentLength = 0;
          if (!state.fullContent) state.fullContent = "";
          if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

          // Handle assistantResponseEvent
          if (eventType === "assistantResponseEvent" && event.payload?.content) {
            const content = event.payload.content;
            state.totalContentLength += content.length;
            state.fullContent += content;
            
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: chunkIndex === 0
                  ? { role: "assistant", content }
                  : { content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle codeEvent
          if (eventType === "codeEvent" && event.payload?.content) {
            state.fullContent += event.payload.content;
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { content: event.payload.content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle toolUseEvent
          if (eventType === "toolUseEvent" && event.payload) {
            state.hasToolCalls = true;
            const toolUse = event.payload;
            const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

            for (const singleToolUse of toolUses) {
              const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
              const toolName = singleToolUse.name || "";
              const toolInput = singleToolUse.input;

              let toolIndex;
              const isNewTool = !state.seenToolIds.has(toolCallId);

              if (isNewTool) {
                toolIndex = state.toolCallIndex++;
                state.seenToolIds.set(toolCallId, toolIndex);
                if (toolName) {
                  state.fullContent += toolName;
                }

                const startChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                      tool_calls: [{
                        index: toolIndex,
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: toolName,
                          arguments: ""
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              } else {
                toolIndex = state.seenToolIds.get(toolCallId);
              }

              if (toolInput !== undefined) {
                let argumentsStr;

                if (typeof toolInput === 'string') {
                  argumentsStr = toolInput;
                } else if (typeof toolInput === 'object') {
                  argumentsStr = JSON.stringify(toolInput);
                } else {
                  continue;
                }

                if (argumentsStr) {
                  state.fullContent += argumentsStr;
                }

                const argsChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: {
                          arguments: argumentsStr
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
          }

          // Handle messageStopEvent
          if (eventType === "messageStopEvent") {
            state.endDetected = true;
            maybeEmitFinishChunk(controller);
          }

          // Handle contextUsageEvent to extract contextUsagePercentage
          if (eventType === "contextUsageEvent" && event.payload?.contextUsagePercentage) {
            state.contextUsagePercentage = event.payload.contextUsagePercentage;
            // Mark that we received context usage event
            state.hasContextUsage = true;
            maybeEmitFinishChunk(controller);
          }

          // Handle meteringEvent - mark that we received it
          if (eventType === "meteringEvent") {
            const metering = event.payload?.meteringEvent || event.payload;
            const creditsUsed = Number(metering?.usage);
            if (Number.isFinite(creditsUsed) && creditsUsed > 0) {
              state.usage = {
                ...(state.usage || {}),
                credits_used: creditsUsed
              };
            }
            state.hasMeteringEvent = true;
            maybeEmitFinishChunk(controller);
          }

          // Handle metricsEvent for token usage
          if (eventType === "metricsEvent") {
            // Extract usage data from metricsEvent payload
            const metrics = event.payload?.metricsEvent || event.payload;
            if (metrics && typeof metrics === 'object') {
              const inputTokens = metrics.inputTokens || 0;
              const outputTokens = metrics.outputTokens || 0;
              
              if (inputTokens > 0 || outputTokens > 0) {
                state.usage = {
                  ...(state.usage || {}),
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens
                };
              }
            }
            maybeEmitFinishChunk(controller);
          }
        }

        if (iterations >= maxIterations) {
          console.warn("[Kiro] Max iterations reached in event parsing");
        }
      },

      flush(controller) {
        // Emit finish chunk if not already sent
        if (!state.finishEmitted) {
          emitFinishChunk(controller);
        }

        // Send final done message
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    });

    // Pipe response body through transform stream
    if (!response.body) {
      return new Response("data: [DONE]\n\n", { status: response.status, headers: { "Content-Type": "text/event-stream" } });
    }
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
        proxyOptions
      );

      return result;
    } catch (error) {
      log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`);
      return null;
    }
  }
}

/**
 * Parse AWS EventStream frame
 */
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    const headersLength = view.getUint32(4, false);

    // Parse headers
    const headers = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) { // String type
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = new TextDecoder().decode(data.slice(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = new TextDecoder().decode(data.slice(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        // Log parse error for debugging
        console.warn(`[Kiro] Failed to parse payload: ${parseError.message} | payload: ${payloadStr.substring(0, 100)}`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch {
    return null;
  }
}

export default KiroExecutor;

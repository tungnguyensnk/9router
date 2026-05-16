import { describe, it, expect } from "vitest";

import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";
import { convertKiroToOpenAI } from "../../open-sse/translator/response/kiro-to-openai.js";

function encodeHeader(name, value) {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset++] = nameBytes.length;
  nameBytes.copy(header, offset);
  offset += nameBytes.length;
  header[offset++] = 7;
  header.writeUInt16BE(valueBytes.length, offset);
  offset += 2;
  valueBytes.copy(header, offset);
  return header;
}

function createKiroFrame(eventType, payload) {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = payload == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(0, 8);
  headers.copy(frame, 12);
  payloadBytes.copy(frame, 12 + headers.length);
  return new Uint8Array(frame);
}

async function readSseLines(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.startsWith("data: ") ? part.slice(6) : part);
}

describe("kiro flow", () => {
  it("executor emits a single finish chunk with usage when stop arrives before usage events", async () => {
    const executor = new KiroExecutor();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(createKiroFrame("assistantResponseEvent", { content: "hello from kiro" }));
        controller.enqueue(createKiroFrame("messageStopEvent", {}));
        controller.enqueue(createKiroFrame("contextUsageEvent", { contextUsagePercentage: 25 }));
        controller.enqueue(createKiroFrame("meteringEvent", { usage: 1.5 }));
        controller.close();
      }
    });

    const response = new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
    const transformed = executor.transformEventStreamToSSE(response, "claude-sonnet-4.5", {
      conversationState: {
        currentMessage: {
          userInputMessage: { content: "hi", modelId: "claude-sonnet-4.5" }
        },
        history: []
      }
    });

    const lines = await readSseLines(transformed);
    const finishChunks = lines
      .filter(line => line !== "[DONE]")
      .map(line => JSON.parse(line))
      .filter(chunk => chunk.choices?.[0]?.finish_reason);

    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0].usage?.credits_used).toBe(1.5);
    expect(finishChunks[0].usage?.prompt_tokens).toBeGreaterThan(0);
  });

  it("buildKiroPayload respects request max token settings", () => {
    const payload = buildKiroPayload("claude-sonnet-4.5", {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1234,
      temperature: 0.2
    }, true, {});

    expect(payload.inferenceConfig.maxTokens).toBe(1234);
    expect(payload.inferenceConfig.temperature).toBe(0.2);
  });

  it("kiro response translator keeps stable tool call indexes across multiple tools", () => {
    const state = { model: "kiro" };

    const chunk = convertKiroToOpenAI({
      _eventType: "toolUseEvent",
      toolUseEvent: [
        { toolUseId: "call_1", name: "first", input: { a: 1 } },
        { toolUseId: "call_2", name: "second", input: { b: 2 } }
      ]
    }, state);

    expect(chunk.choices[0].delta.tool_calls).toHaveLength(2);
    expect(chunk.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(chunk.choices[0].delta.tool_calls[1].index).toBe(1);
  });
});

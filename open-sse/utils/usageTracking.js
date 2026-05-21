/**
 * Token Usage Tracking - Extract, normalize, estimate and log token usage
 */

import { saveRequestUsage, appendRequestLog } from "@/lib/usageDb.js";
import { FORMATS } from "../translator/formats.js";

// ANSI color codes
export const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

// Buffer tokens to prevent context errors
const BUFFER_TOKENS = 2000;

const KIRO_SONNET_CREDITS_PER_MILLION = {
  input: 4,
  output: 62.5,
  cached: 0.4
};

const KIRO_OPUS_CREDITS_PER_MILLION = {
  input: 6.75,
  output: 105,
  cached: 0.675
};

const KIRO_MODEL_COST_MULTIPLIERS = {
  auto: 1.0,
  "claude-opus-4.7": 2.2,
  "claude-opus-4.6": 2.2,
  "claude-opus-4.5": 2.2,
  "claude-sonnet-4.6": 1.3,
  "claude-sonnet-4.5": 1.3,
  "claude-sonnet-4.0": 1.3,
  "claude-sonnet-4": 1.3,
  "claude-haiku-4.5": 0.4,
  "deepseek-3.2": 0.25,
  "minimax-m2.5": 0.25,
  "glm-5": 0.5,
  "minimax-m2.1": 0.15,
  "qwen3-coder-next": 0.05
};

function getKiroCreditProfile(model) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  if (normalizedModel.startsWith("claude-opus-")) {
    return KIRO_OPUS_CREDITS_PER_MILLION;
  }

  const multiplier = KIRO_MODEL_COST_MULTIPLIERS[normalizedModel];
  if (!multiplier || multiplier <= 0) {
    return KIRO_SONNET_CREDITS_PER_MILLION;
  }

  const scale = multiplier / 1.3;
  return {
    input: KIRO_SONNET_CREDITS_PER_MILLION.input * scale,
    output: KIRO_SONNET_CREDITS_PER_MILLION.output * scale,
    cached: KIRO_SONNET_CREDITS_PER_MILLION.cached * scale
  };
}

export function applyDerivedKiroCacheUsage(model, usage) {
  if (!usage || typeof usage !== "object") return usage;

  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const creditsUsed = Number(usage.credits_used);

  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(creditsUsed)) {
    return usage;
  }

  if (promptTokens <= 0 || creditsUsed <= 0) return usage;
  if ((usage.cached_tokens || usage.cache_read_input_tokens || 0) > 0) return usage;

  const profile = getKiroCreditProfile(model);
  const predictedCredits =
    (promptTokens * profile.input / 1000000) +
    (completionTokens * profile.output / 1000000);

  const savedCredits = predictedCredits - creditsUsed;
  if (!Number.isFinite(savedCredits) || savedCredits <= 0) {
    return usage;
  }

  const savingsPerMillionCachedTokens = profile.input - profile.cached;
  if (!Number.isFinite(savingsPerMillionCachedTokens) || savingsPerMillionCachedTokens <= 0) {
    return usage;
  }

  const cachedTokens = Math.floor(savedCredits * 1000000 / savingsPerMillionCachedTokens);
  if (!Number.isFinite(cachedTokens) || cachedTokens <= 0) {
    return usage;
  }

  const boundedCachedTokens = Math.min(promptTokens, cachedTokens);
  return {
    ...usage,
    cached_tokens: boundedCachedTokens,
    cache_read_input_tokens: boundedCachedTokens,
    prompt_tokens_details: {
      ...(usage.prompt_tokens_details || {}),
      cached_tokens: boundedCachedTokens
    }
  };
}

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Add buffer tokens to usage to prevent context errors
 * @param {object} usage - Usage object (any format)
 * @returns {object} Usage with buffer added
 */
export function addBufferToUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;

  const result = { ...usage };

  // Claude format
  if (result.input_tokens !== undefined) {
    result.input_tokens += BUFFER_TOKENS;
  }

  // OpenAI format
  if (result.prompt_tokens !== undefined) {
    result.prompt_tokens += BUFFER_TOKENS;
  }

  // Calculate or update total_tokens
  if (result.total_tokens !== undefined) {
    result.total_tokens += BUFFER_TOKENS;
  } else if (result.prompt_tokens !== undefined && result.completion_tokens !== undefined) {
    // Calculate total_tokens if not exists
    result.total_tokens = result.prompt_tokens + result.completion_tokens;
  }

  return result;
}

export function filterUsageForFormat(usage, targetFormat) {
  if (!usage || typeof usage !== "object") return usage;

  // Helper to pick only defined fields from usage
  const pickFields = (fields) => {
    const filtered = {};
    for (const field of fields) {
      if (usage[field] !== undefined) {
        filtered[field] = usage[field];
      }
    }
    return filtered;
  };

  // Define allowed fields for each format
  const formatFields = {
    [FORMATS.CLAUDE]: [
      'input_tokens', 'output_tokens', 
      'cache_read_input_tokens', 'cache_creation_input_tokens',
      'estimated'
    ],
    [FORMATS.GEMINI]: [
      'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount',
      'cachedContentTokenCount', 'thoughtsTokenCount',
      'estimated'
    ],
    [FORMATS.OPENAI_RESPONSES]: [
      'input_tokens', 'output_tokens',
      'input_tokens_details', 'output_tokens_details',
      'estimated'
    ],
    // OpenAI format (default for OPENAI, CODEX, KIRO, etc.)
    default: [
      'prompt_tokens', 'completion_tokens', 'total_tokens',
      'cached_tokens', 'reasoning_tokens',
      'credits_used',
      'prompt_tokens_details', 'completion_tokens_details',
      'estimated'
    ]
  };

  // Get fields for target format
  let fields = formatFields[targetFormat];
  
  // Use same fields for similar formats
  if (targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.ANTIGRAVITY) {
    fields = formatFields[FORMATS.GEMINI];
  } else if (targetFormat === FORMATS.OPENAI_RESPONSE) {
    fields = formatFields[FORMATS.OPENAI_RESPONSES];
  } else if (!fields) {
    fields = formatFields.default;
  }

  return pickFields(fields);
}

/**
 * Normalize usage object - ensure all values are valid numbers
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const normalized = {};
  const assignNumber = (key, value) => {
    if (value === undefined || value === null) return;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  };

  assignNumber("prompt_tokens", usage?.prompt_tokens);
  assignNumber("completion_tokens", usage?.completion_tokens);
  assignNumber("total_tokens", usage?.total_tokens);
  assignNumber("cache_read_input_tokens", usage?.cache_read_input_tokens);
  assignNumber("cache_creation_input_tokens", usage?.cache_creation_input_tokens);
  assignNumber("cached_tokens", usage?.cached_tokens);
  assignNumber("reasoning_tokens", usage?.reasoning_tokens);
  assignNumber("credits_used", usage?.credits_used);

  // Preserve nested details objects for OpenAI format forwarding
  if (usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    normalized.prompt_tokens_details = usage.prompt_tokens_details;
  }
  if (usage?.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    normalized.completion_tokens_details = usage.completion_tokens_details;
  }
  if (usage?.estimated !== undefined) {
    normalized.estimated = Boolean(usage.estimated);
  }

  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

/**
 * Check if usage has valid token data
 * Valid = has at least one token field with value > 0
 * Invalid = empty object {}, null, undefined, no token fields, or all zeros
 */
export function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object") return false;

  // Check for any known token field with value > 0
  const tokenFields = [
    "prompt_tokens", "completion_tokens", "total_tokens",  // OpenAI
    "input_tokens", "output_tokens",                        // Claude
    "promptTokenCount", "candidatesTokenCount"              // Gemini
  ];

  for (const field of tokenFields) {
    if (typeof usage[field] === "number" && usage[field] > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Extract usage from any format (Claude, OpenAI, Gemini, Responses API)
 */
export function extractUsage(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  // Claude format (message_delta event)
  if (chunk.type === "message_delta" && chunk.usage && typeof chunk.usage === "object") {
    return normalizeUsage({
      prompt_tokens: chunk.usage.input_tokens || 0,
      completion_tokens: chunk.usage.output_tokens || 0,
      cache_read_input_tokens: chunk.usage.cache_read_input_tokens,
      cache_creation_input_tokens: chunk.usage.cache_creation_input_tokens
    });
  }

  // OpenAI Responses API format (response.completed or response.done)
  if ((chunk.type === "response.completed" || chunk.type === "response.done") && chunk.response?.usage && typeof chunk.response.usage === "object") {
    const usage = chunk.response.usage;
    const cachedTokens = usage.input_tokens_details?.cached_tokens;
    return normalizeUsage({
      prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
      cached_tokens: cachedTokens,
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
      prompt_tokens_details: cachedTokens ? { cached_tokens: cachedTokens } : undefined
    });
  }

  // OpenAI format (also covers DeepSeek which uses prompt_cache_hit_tokens)
  if (chunk.usage && typeof chunk.usage === "object" && chunk.usage.prompt_tokens !== undefined) {
    return normalizeUsage({
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens || 0,
      cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.prompt_cache_hit_tokens,
      credits_used: chunk.usage.credits_used,
      reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
      prompt_tokens_details: chunk.usage.prompt_tokens_details,
      completion_tokens_details: chunk.usage.completion_tokens_details
    });
  }

  // Gemini format (Antigravity)
  // Antigravity wraps usageMetadata inside response: { response: { usageMetadata: {...} } }
  const usageMeta = chunk.usageMetadata || chunk.response?.usageMetadata;
  if (usageMeta && typeof usageMeta === "object") {
    return normalizeUsage({
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      total_tokens: usageMeta.totalTokenCount,
      cached_tokens: usageMeta.cachedContentTokenCount,
      reasoning_tokens: usageMeta.thoughtsTokenCount
    });
  }

  // Ollama NDJSON format (raw from provider, before translation)
  // Ollama sends: {"model":"...","done":true,"prompt_eval_count":N,"eval_count":M}
  if (chunk.done === true && typeof chunk.prompt_eval_count === "number") {
    return normalizeUsage({
      prompt_tokens: chunk.prompt_eval_count || 0,
      completion_tokens: chunk.eval_count || 0,
      total_tokens: (chunk.prompt_eval_count || 0) + (chunk.eval_count || 0)
    });
  }

  return null;
}

/**
 * Estimate input tokens from request body
 * Calculate total body size for more accurate estimation
 */
export function estimateInputTokens(body) {
  if (!body || typeof body !== "object") return 0;

  try {
    // Calculate total body size (includes messages, tools, system, thinking config, etc.)
    const bodyStr = JSON.stringify(body);
    const totalChars = bodyStr.length;

    // Estimate: ~4 chars per token (rough average across all tokenizers)
    return Math.ceil(totalChars / 4);
  } catch (err) {
    // Fallback if stringify fails
    return 0;
  }
}

/**
 * Estimate output tokens from content length
 */
export function estimateOutputTokens(contentLength) {
  if (!contentLength || contentLength <= 0) return 0;
  return Math.max(1, Math.floor(contentLength / 4));
}

function countAnthropicTokens(text) {
  if (!text) return 0;

  const source = String(text);
  const chunks = source.match(/\p{L}+|\p{N}{1,3}|\s+|[^\s\p{L}\p{N}]/gu) || [];
  let total = 0;

  for (const chunk of chunks) {
    if (!chunk) continue;

    if (/^\s+$/u.test(chunk)) {
      total += Math.ceil(chunk.length / 4);
      continue;
    }

    if (/^\p{L}+$/u.test(chunk)) {
      total += Math.ceil(chunk.length / 4);
      continue;
    }

    if (/^\p{N}{1,3}$/u.test(chunk)) {
      total += 1;
      continue;
    }

    total += 1;
  }

  return Math.max(1, total);
}

export function estimateKiroOutputTokens(outputText) {
  if (!outputText) return 0;
  try {
    return countAnthropicTokens(outputText);
  } catch {
    return estimateOutputTokens(String(outputText).length);
  }
}

/**
 * Format usage object based on target format
 * @param {number} inputTokens - Input/prompt tokens
 * @param {number} outputTokens - Output/completion tokens
 * @param {string} targetFormat - Target format from FORMATS
 */
export function formatUsage(inputTokens, outputTokens, targetFormat) {
  // Claude format uses input_tokens/output_tokens
  if (targetFormat === FORMATS.CLAUDE) {
    return addBufferToUsage({ 
      input_tokens: inputTokens, 
      output_tokens: outputTokens, 
      estimated: true 
    });
  }

  // Default: OpenAI format (works for openai, gemini, responses, etc.)
  return addBufferToUsage({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated: true
  });
}

/**
 * Estimate full usage when provider doesn't return it
 * @param {object} body - Request body for input token estimation
 * @param {number} contentLength - Content length for output token estimation
 * @param {string} targetFormat - Target format from FORMATS constant
 */
export function estimateUsage(body, contentLength, targetFormat = FORMATS.OPENAI, options = {}) {
  const provider = options?.provider;
  const outputText = options?.outputText || "";

  if (provider === "kiro") {
    return formatUsage(
      estimateInputTokens(body),
      estimateKiroOutputTokens(outputText),
      targetFormat
    );
  }

  return formatUsage(
    estimateInputTokens(body),
    estimateOutputTokens(contentLength),
    targetFormat
  );
}

/**
 * Log usage with cache info (green color)
 */
export function logUsage(provider, usage, model = null, connectionId = null, apiKey = null) {
  if (!usage || typeof usage !== "object") return;

  const p = provider?.toUpperCase() || "UNKNOWN";

  // Support both formats:
  // - OpenAI: prompt_tokens, completion_tokens
  // - Claude: input_tokens, output_tokens
  const inTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
  const outTokens = usage?.completion_tokens || usage?.output_tokens || 0;
  const accountPrefix = connectionId ? connectionId.slice(0, 8) + "..." : "unknown";

  let msg = `[${getTimeString()}] 📊 ${COLORS.green}[USAGE] ${p} | in=${inTokens} | out=${outTokens} | account=${accountPrefix}${COLORS.reset}`;

  // Add estimated flag if present
  if (usage.estimated) {
    msg += ` ${COLORS.yellow}(estimated)${COLORS.reset}`;
  }

  // Add cache info if present (unified from different formats)
  const cacheRead = usage.cache_read_input_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens;
  if (cacheRead) msg += ` | cache_read=${cacheRead}`;

  const cacheCreation = usage.cache_creation_input_tokens;
  if (cacheCreation) msg += ` | cache_create=${cacheCreation}`;

  const reasoning = usage.reasoning_tokens;
  if (reasoning) msg += ` | reasoning=${reasoning}`;

  const creditsUsed = usage.credits_used;
  if (creditsUsed) msg += ` | credits=${creditsUsed}`;

  console.log(msg);

  // Save to usage DB
  const tokens = {
    prompt_tokens: inTokens,
    completion_tokens: outTokens,
    cache_read_input_tokens: cacheRead || 0,
    cache_creation_input_tokens: cacheCreation || 0,
    reasoning_tokens: reasoning || 0,
    credits_used: creditsUsed || 0,
    estimated: Boolean(usage.estimated)
  };
  saveRequestUsage({ model, provider, connectionId, tokens, apiKey: apiKey || undefined }).catch(() => { });
  appendRequestLog({ model, provider, connectionId, tokens, status: "200 OK" }).catch(() => { });
}

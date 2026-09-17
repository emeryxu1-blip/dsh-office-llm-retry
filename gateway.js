import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const OFFICE_PROVIDER_ID = "myhexin-office";
export const API_KEY_REFERENCE = "MYHEXIN_OFFICE_API_KEY";
export const GATEWAY_BASE_URL = "https://aigw-office.myhexin.com/ai-gateway";
export const OFFICE_LISTING_URL = `${GATEWAY_BASE_URL}/models`;
export const OFFICE_CHAT_URL = `${GATEWAY_BASE_URL}/v1/chat/completions`;
export const OFFICE_INFERENCE_BASE_URL = `${GATEWAY_BASE_URL}/v1`;
export const OFFICE_PROVIDER_TEMPLATE = Object.freeze({
  displayName: "MyHexin Office",
  apiKeyEnv: API_KEY_REFERENCE,
  api: "openai-completions",
  baseURL: OFFICE_INFERENCE_BASE_URL,
  timeoutMs: 600_000,
  streamIdleTimeoutMs: 600_000,
  defaultInput: Object.freeze(["text"]),
});
const DEFAULT_LISTING_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_CONCURRENCY = 8;
const DEFAULT_PROBE_ATTEMPTS = 2;
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FAILED_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const PROBE_MAX_TOKENS = 256;
const EFFORT_PROBE_MAX_TOKENS = 1;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
const FAILED_FINISH_REASONS = new Set(["error", "failed", "aborted", "cancelled", "canceled"]);
const REASONING_EFFORT_LEVELS = Object.freeze([
  { id: "off", wires: ["none", "off"] },
  { id: "minimal", wires: ["minimal"] },
  { id: "low", wires: ["low"] },
  { id: "medium", wires: ["medium"] },
  { id: "high", wires: ["high"] },
  { id: "xhigh", wires: ["xhigh"] },
  { id: "max", wires: ["max", "ultra"] },
]);

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeReasoningEfforts(value) {
  if (value === false) return false;
  const result = {};
  if (Array.isArray(value)) {
    const offered = new Set(value);
    for (const level of REASONING_EFFORT_LEVELS) {
      const wire = level.wires.find((candidate) => offered.has(candidate));
      if (wire !== undefined) result[level.id] = wire;
    }
  } else {
    const mapping = asRecord(value);
    if (mapping === undefined) return undefined;
    for (const level of REASONING_EFFORT_LEVELS) {
      const wire = mapping[level.id];
      if (level.wires.includes(wire)) result[level.id] = wire;
      if (level.id === "off" && wire === null) result.off = null;
    }
  }
  return Object.keys(result).some((level) => level !== "off") ? result : undefined;
}

function metadataReasoningEfforts(entry) {
  for (const key of ["reasoningEfforts", "reasoning_efforts", "supported_reasoning_efforts"]) {
    const result = normalizeReasoningEfforts(entry[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}
async function readBounded(response, limit, label) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`${label} response exceeded ${limit} bytes`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel(`${label} response exceeded ${limit} bytes`);
        throw new Error(`${label} response exceeded ${limit} bytes`);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchTextWithTimeout(fetchImpl, url, init, timeoutMs, limit, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    const text = await readBounded(response, limit, label);
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw new Error(`${label} request failed`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function advertisedModels(payload) {
  if (!Array.isArray(asRecord(payload)?.data)) throw new Error("office model listing has no data array");
  const seen = new Set();
  const models = [];
  for (const raw of payload.data) {
    const entry = asRecord(raw);
    const id = nonEmptyString(entry?.id);
    if (id === undefined || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = nonEmptyString(entry?.name);
    const reasoningEfforts = metadataReasoningEfforts(entry);
    const input = Array.isArray(entry.input) && entry.input.length > 0
      && entry.input.every((kind) => kind === "text" || kind === "image")
      ? [...new Set(entry.input)] : undefined;
    models.push({ id, ...(name === undefined ? {} : { name }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      ...(input === undefined ? {} : { input }) });
  }
  return models;
}

async function listOfficeModels(fetchImpl, apiKey, timeoutMs) {
  let response;
  let text;
  try {
    ({ response, text } = await fetchTextWithTimeout(fetchImpl, OFFICE_LISTING_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    }, timeoutMs, MAX_LISTING_BYTES, "office model listing"));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (!response.ok) {
    throw new Error(`office model listing answered HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error("office model listing did not answer with JSON", { cause: error });
  }
  try {
    return advertisedModels(payload);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (typeof block === "string") return block;
    const record = asRecord(block);
    return nonEmptyString(record?.text) ?? nonEmptyString(record?.content) ?? "";
  }).join("");
}

function inspectCompletionPayload(payload, state) {
  const body = asRecord(payload);
  if (body === undefined) return { ok: false, reason: "completion event is not an object" };
  if (body.error !== undefined || body.type === "error") return { ok: false, reason: "completion returned an error event" };
  if (!Array.isArray(body.choices)) return { ok: true };
  for (const rawChoice of body.choices) {
    const choice = asRecord(rawChoice);
    if (choice === undefined) continue;
    const delta = asRecord(choice.delta);
    const message = asRecord(choice.message);
    const output = [
      contentText(delta?.content),
      contentText(delta?.reasoning_content),
      contentText(delta?.reasoning),
      contentText(message?.content),
      contentText(message?.reasoning_content),
      contentText(message?.reasoning),
      contentText(choice.text),
    ].join("");
    if (output.length > 0) {
      state.sawOutput = true;
      state.output += output;
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      const reason = String(choice.finish_reason).toLowerCase();
      if (FAILED_FINISH_REASONS.has(reason)) return { ok: false, reason: `completion finished with ${reason}` };
      state.sawTerminal = true;
    }
  }
  return { ok: true };
}

function ssePayloads(text) {
  const payloads = [];
  let data = [];
  const flush = () => {
    if (data.length > 0) payloads.push(data.join("\n"));
    data = [];
  };
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  flush();
  return payloads;
}

function inspectProbeBody(text, contentType, nonce) {
  const state = { sawOutput: false, sawTerminal: false, sawDone: false, output: "" };
  const trimmed = text.trim();
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:")) {
    const events = ssePayloads(text);
    if (events.length === 0) return { available: false, reason: "completion stream contained no data events" };
    for (const event of events) {
      if (event.trim() === "[DONE]") {
        state.sawDone = true;
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(event);
      } catch {
        return { available: false, reason: "completion stream contained invalid JSON" };
      }
      const inspected = inspectCompletionPayload(payload, state);
      if (!inspected.ok) return { available: false, reason: inspected.reason };
    }
  } else {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { available: false, reason: "completion response was neither SSE nor JSON" };
    }
    const inspected = inspectCompletionPayload(payload, state);
    if (!inspected.ok) return { available: false, reason: inspected.reason };
    // A valid non-streaming choice is already a terminal response even when a
    // gateway omits finish_reason.
    if (Array.isArray(asRecord(payload)?.choices)) state.sawTerminal = true;
  }
  if (!state.sawOutput) return { available: false, reason: "completion produced no text or reasoning" };
  if ((contentType.includes("text/event-stream") || trimmed.startsWith("data:")) && (!state.sawTerminal || !state.sawDone)) {
    return { available: false, reason: "completion stream did not finish cleanly through [DONE]" };
  }
  if (!state.sawTerminal && !state.sawDone) return { available: false, reason: "completion never reached a terminal event" };
  if (!state.output.includes(nonce)) return { available: false, reason: "completion did not echo the random probe token" };
  return { available: true };
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000) + Math.floor(Math.random() * 100);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now()) + Math.floor(Math.random() * 100);
  }
  return 250 * (2 ** attempt) + Math.floor(Math.random() * 150);
}

async function retryWithinBudget(response, attempt, remaining, signal) {
  const waitMs = retryDelayMs(response, attempt);
  if (waitMs >= remaining - 100) return false;
  await delay(waitMs, undefined, { signal });
  return true;
}

async function probeOfficeModel(fetchImpl, apiKey, model, timeoutMs, randomToken, signal) {
  const started = Date.now();
  for (let attempt = 0; attempt < DEFAULT_PROBE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return { available: false, reason: `probe timed out after ${timeoutMs}ms` };
    const nonce = randomToken();
    let response;
    let text;
    try {
      ({ response, text } = await fetchTextWithTimeout(fetchImpl, OFFICE_CHAT_URL, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-trace-id": `dsh-${randomUUID()}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: `Reply with exactly ${nonce}` }],
        }),
      }, remaining, MAX_PROBE_BYTES, `office model probe for ${JSON.stringify(model)}`));
    } catch (error) {
      const retryRemaining = timeoutMs - (Date.now() - started);
      if (attempt + 1 < DEFAULT_PROBE_ATTEMPTS && await retryWithinBudget(undefined, attempt, retryRemaining, signal)) {
        continue;
      }
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const retryableStatus = response.status === 429 || response.status >= 500;
    if (!response.ok) {
      const retryRemaining = timeoutMs - (Date.now() - started);
      if (attempt + 1 < DEFAULT_PROBE_ATTEMPTS && retryableStatus
        && await retryWithinBudget(response, attempt, retryRemaining, signal)) {
        continue;
      }
      return { available: false, reason: `HTTP ${response.status}` };
    }
    return inspectProbeBody(text, response.headers.get("content-type") ?? "", nonce);
  }
  return { available: false, reason: "probe exhausted its retry budget" };
}

function completionErrorMessage(text) {
  try {
    const body = asRecord(JSON.parse(text));
    return nonEmptyString(asRecord(body?.error)?.message) ?? nonEmptyString(body?.message) ?? text;
  } catch {
    return text;
  }
}

export function disclosedReasoningEfforts(text) {
  const message = completionErrorMessage(text);
  const marker = /valid(?: reasoning)? levels?\s*(?::|are)\s*/iu.exec(message);
  if (marker === null) return undefined;
  const tail = message.slice(marker.index + marker[0].length);
  const segment = tail.split(
    /(?:no fallback model group|received model group|available model group fallbacks|error doing the fallback|\r?\n)/iu,
    1,
  )[0] ?? tail;
  const tokens = new Set(segment.toLowerCase().match(/[a-z][a-z0-9_-]*/gu) ?? []);
  const efforts = {};
  for (const level of REASONING_EFFORT_LEVELS) {
    const wire = level.wires.find((candidate) => tokens.has(candidate));
    if (wire !== undefined) efforts[level.id] = wire;
  }
  return efforts;
}

async function probeOfficeReasoningEfforts(fetchImpl, apiKey, model, timeoutMs, signal) {
  const started = Date.now();
  for (let attempt = 0; attempt < DEFAULT_PROBE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      return { reasoningEfforts: false, reason: `effort probe timed out after ${timeoutMs}ms` };
    }
    let response;
    let text;
    try {
      ({ response, text } = await fetchTextWithTimeout(fetchImpl, OFFICE_CHAT_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-trace-id": `dsh-effort-${randomUUID()}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: EFFORT_PROBE_MAX_TOKENS,
          reasoning_effort: `dsh-invalid-${randomUUID()}`,
          messages: [{ role: "user", content: "Reply with exactly OK" }],
        }),
      }, remaining, MAX_PROBE_BYTES, `office reasoning-effort probe for ${JSON.stringify(model)}`));
    } catch (error) {
      const retryRemaining = timeoutMs - (Date.now() - started);
      if (attempt + 1 < DEFAULT_PROBE_ATTEMPTS && await retryWithinBudget(undefined, attempt, retryRemaining, signal)) {
        continue;
      }
      return {
        reasoningEfforts: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { reasoningEfforts: false, denied: true, reason: `HTTP ${response.status}` };
    }
    const disclosed = response.status >= 400 && response.status < 500
      ? disclosedReasoningEfforts(text) : undefined;
    if (disclosed !== undefined) {
      const hasPositiveLevel = Object.keys(disclosed).some((level) => level !== "off");
      return hasPositiveLevel
        ? { reasoningEfforts: disclosed }
        : { reasoningEfforts: false, reason: "gateway disclosed no selectable reasoning level" };
    }

    const retryableStatus = response.status === 429 || [502, 503, 504].includes(response.status);
    const retryRemaining = timeoutMs - (Date.now() - started);
    if (attempt + 1 < DEFAULT_PROBE_ATTEMPTS && retryableStatus
      && await retryWithinBudget(response, attempt, retryRemaining, signal)) {
      continue;
    }
    return {
      reasoningEfforts: false,
      reason: response.ok
        ? "gateway accepted an invalid effort without disclosing supported levels"
        : `HTTP ${response.status} without a supported-level disclosure`,
    };
  }
  return { reasoningEfforts: false, reason: "effort probe exhausted its retry budget" };
}

async function mapConcurrent(items, concurrency, work, onProgress, progressType = "probe", signal) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      signal?.throwIfAborted();
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index], index);
      } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        results[index] = progressType === "probe"
          ? { available: false, reason }
          : { reasoningEfforts: false, reason };
      }
      completed += 1;
      onProgress?.({
        type: progressType,
        completed,
        total: items.length,
        model: items[index].id,
        available: progressType === "probe"
          ? results[index].available
          : results[index].reasoningEfforts !== false,
      });
    }
  };
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function readCapabilityCache(cachePath, credentialDigest, now, maxAgeMs) {
  if (cachePath === undefined) return {};
  try {
    const info = await stat(cachePath);
    if (info.size > MAX_LISTING_BYTES || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) return {};
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    if (cache.version !== 1 || cache.endpoint !== GATEWAY_BASE_URL || cache.credentialDigest !== credentialDigest) return {};
    const entries = Object.create(null);
    for (const [id, raw] of Object.entries(asRecord(cache.models) ?? {})) {
      const record = asRecord(raw);
      if (record === undefined || !Number.isFinite(record.checkedAt)) continue;
      const age = now - record.checkedAt;
      const allowedAge = record.reason === undefined ? maxAgeMs : Math.min(maxAgeMs, FAILED_CACHE_MAX_AGE_MS);
      if (age < 0 || age >= allowedAge) continue;
      const reasoningEfforts = normalizeReasoningEfforts(record.reasoningEfforts);
      if (reasoningEfforts === undefined) continue;
      entries[id] = { checkedAt: record.checkedAt, reasoningEfforts,
        ...(record.denied === true ? { denied: true } : {}),
        ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 200) } : {}),
      };
    }
    return entries;
  } catch {
    // A missing, stale, or corrupt cache is never evidence of capabilities.
    return {};
  }
}

async function writeCapabilityCache(cachePath, credentialDigest, models) {
  if (cachePath === undefined) return;
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, endpoint: GATEWAY_BASE_URL, credentialDigest, models }, null, 2), {
      mode: 0o600, flag: "wx",
    });
    await rename(temporary, cachePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Read the pinned Office gateway catalog without touching settings or defaults.
 * Capabilities come only from explicit metadata, validation errors, or a bounded
 * cache bound to this endpoint and credential. Full echo requests are opt-in.
 */
export async function discoverOfficeGatewayCatalog(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("Office gateway credential is missing");
  const baseFetch = options.fetch ?? globalThis.fetch;
  const fetchImpl = (url, init) => {
    options.signal?.throwIfAborted();
    return baseFetch(url, { ...init, signal: options.signal === undefined ? init.signal
      : AbortSignal.any([init.signal, options.signal]) });
  };
  const listingTimeoutMs = options.listingTimeoutMs ?? DEFAULT_LISTING_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeConcurrency = options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  for (const [name, value] of Object.entries({ listingTimeoutMs, probeTimeoutMs, cacheMaxAgeMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  }
  if (!Number.isSafeInteger(probeConcurrency) || probeConcurrency < 1 || probeConcurrency > 32) {
    throw new Error("probeConcurrency must be an integer between 1 and 32");
  }
  const now = options.now ?? Date.now;
  const credentialDigest = createHash("sha256").update(apiKey).digest("hex");
  const cached = await readCapabilityCache(options.cachePath, credentialDigest, now(), cacheMaxAgeMs);
  options.onProgress?.({ type: "listing" });
  const advertised = await listOfficeModels(fetchImpl, apiKey, listingTimeoutMs);
  options.onProgress?.({ type: "listed", total: advertised.length });
  const availability = options.verifyAvailability === true
    ? await mapConcurrent(advertised, probeConcurrency, (entry) => probeOfficeModel(fetchImpl, apiKey, entry.id,
      probeTimeoutMs, options.randomToken ?? (() => randomBytes(18).toString("base64url")), options.signal), options.onProgress, "probe", options.signal)
    : advertised.map(() => ({ available: true }));
  const entries = advertised.filter((_entry, index) => availability[index]?.available === true);
  options.onProgress?.({ type: "effort-listed", total: entries.length });
  const effortResults = await mapConcurrent(entries, probeConcurrency, async (entry) => {
    if (entry.reasoningEfforts !== undefined) return { reasoningEfforts: entry.reasoningEfforts, checkedAt: now() };
    if (Object.hasOwn(cached, entry.id)) return cached[entry.id];
    if (options.verifyEfforts === false) return { reasoningEfforts: false, reason: "reasoning levels are unverified" };
    return { ...await probeOfficeReasoningEfforts(fetchImpl, apiKey, entry.id, probeTimeoutMs, options.signal), checkedAt: now() };
  }, options.onProgress, "effort-probe", options.signal);
  options.signal?.throwIfAborted();
  const cacheModels = Object.fromEntries(entries.flatMap((entry, index) => {
    const result = effortResults[index];
    return result?.checkedAt === undefined ? [] : [[entry.id, result]];
  }));
  let cacheWritten = false;
  try {
    await writeCapabilityCache(options.cachePath, credentialDigest, cacheModels);
    cacheWritten = options.cachePath !== undefined;
  } catch {
    // Read-only homes still get the current catalog; caching is optional.
  }
  const models = entries.flatMap((entry, index) => {
    const effort = effortResults[index];
    if (effort?.denied === true) return [];
    return [{ id: entry.id, name: entry.name ?? entry.id,
      ...(entry.input === undefined ? {} : { input: entry.input }),
      reasoningEfforts: effort?.reasoningEfforts ?? false,
    }];
  });
  const failures = advertised.flatMap((entry, index) => availability[index]?.available === true ? [] : [{
    id: entry.id, reason: availability[index]?.reason ?? "unknown probe failure",
  }]);
  const effortFailures = entries.flatMap((entry, index) => effortResults[index]?.reason === undefined ? [] : [{
    id: entry.id, reason: effortResults[index].reason,
  }]);
  for (const [index, entry] of entries.entries()) {
    if (effortResults[index]?.denied) failures.push({ id: entry.id, reason: effortResults[index].reason });
  }
  return { provider: { ...OFFICE_PROVIDER_TEMPLATE, models }, advertised: advertised.length, available: models.length,
    failures, effortFailures, effortCapable: models.filter((entry) => entry.reasoningEfforts !== false).length, cacheWritten };
}

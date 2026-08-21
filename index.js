import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-llm-retry-capped";
export const inject = ["agents"];

const DEFAULTS = Object.freeze({
  maxRetries: 200,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
});

function validateConfig(input) {
  const config = { ...DEFAULTS, ...(input ?? {}) };
  for (const key of Object.keys(input ?? {})) {
    if (!(key in DEFAULTS)) throw new Error(`${name}: unknown key "${key}"`);
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new Error(`${name}: maxRetries must be a non-negative safe integer`);
  }
  if (!Number.isFinite(config.initialDelayMs) || config.initialDelayMs <= 0) {
    throw new Error(`${name}: initialDelayMs must be a positive finite number`);
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs <= 0 || config.initialDelayMs > config.maxDelayMs) {
    throw new Error(`${name}: maxDelayMs must be positive and at least initialDelayMs`);
  }
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new Error(`${name}: jitterRatio must be between 0 and 1`);
  }
  return Object.freeze(config);
}

function delayFor(config, retry, random) {
  const exponential = Math.min(config.initialDelayMs * 2 ** Math.min(retry - 1, 1024), config.maxDelayMs);
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
  return Math.min(exponential * jitter, config.maxDelayMs);
}

function wait(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    function abort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function policyKey(config) {
  return JSON.stringify([name, config.maxRetries, config.initialDelayMs, config.maxDelayMs, config.jitterRatio]);
}

function retryCount(session, turn, step, provider, key) {
  return session.events.reduce((count, event) => {
    const data = event.type === "llm/retry" ? event.data : undefined;
    return data?.turn === turn && data?.step === step && data?.provider === provider && data?.policyKey === key
      ? Math.max(count, data.retry ?? 0)
      : count;
  }, 0);
}

export function apply(ctx, rawConfig = {}, internals = {}) {
  const config = validateConfig(rawConfig);
  const random = internals.random ?? Math.random;
  const lifetime = new AbortController();
  const active = new Set();
  const track = (promise) => {
    const tracked = promise.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  };
  const key = policyKey(config);

  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    if (lifetime.signal.aborted || signal.aborted) return next();
    const previous = retryCount(agent.session, turn, step, provider, key);
    if (previous >= config.maxRetries) return next();
    const retry = previous + 1;
    const retryId = agent.session.events.findLast((event) => event.type === "llm/retry" && event.data.policyKey === key && event.data.turn === turn && event.data.step === step)?.data.retryId ?? randomUUID();
    const providerDelay = failure?.providerRetryAfterMs;
    const delayMs = Number.isFinite(providerDelay) && providerDelay > 0 && providerDelay <= config.maxDelayMs
      ? providerDelay
      : delayFor(config, retry, random);
    const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
    agent.session.append("llm/retry", {
      retryId, turn, step, provider, mode: "normal", policyKey: key,
      retry, maxRetries: config.maxRetries, delayMs, failure,
    });
    if (!await wait(delayMs, fusedSignal)) return;
    agent.session.append("llm/retry-started", { retryId, turn, step, retry });
    return { kind: "retry" };
  }

  const dispose = ctx.on("agent/request-error", (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next));
  });
  ctx.effect(() => async () => {
    dispose();
    lifetime.abort(new Error(`${name} disposed`));
    await Promise.allSettled([...active]);
  }, `${name}: abort and drain active recovery`);
}

export const Config = z.object({
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(200),
  initialDelayMs: z.number().min(Number.MIN_VALUE).default(500),
  maxDelayMs: z.number().min(Number.MIN_VALUE).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
});

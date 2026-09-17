import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { discoverOfficeGatewayCatalog, OFFICE_PROVIDER_ID, API_KEY_REFERENCE, OFFICE_INFERENCE_BASE_URL } from "./gateway.js";

// Keep the entry identity stable so existing Cordis patches upgrade in place.
export const name = "dsh-llm-retry-capped";
export const inject = ["settings", "llm", "credentials"];
export const SETTINGS_NAMESPACE = "dsh-office-llm-retry";
const PROVIDER_NAMESPACE = "llm-pi-ai";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OFFICE_ENDPOINTS = new Set(["https://aimemodeldev.myhexin.com/litellm/v1", OFFICE_INFERENCE_BASE_URL]);
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  "EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED", "PI_AI_ERROR",
]);

const GATEWAY_DEFAULTS = Object.freeze({
  enabled: false,
  verifyEfforts: true,
  verifyAvailability: false,
  refreshIntervalMs: 900_000,
});
const DEFAULTS = Object.freeze({
  provider: OFFICE_PROVIDER_ID,
  maxRetries: 200,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  gateway: GATEWAY_DEFAULTS,
});

export function validateConfig(input = {}) {
  const config = { ...DEFAULTS, ...input, gateway: { ...GATEWAY_DEFAULTS, ...input.gateway } };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) throw new Error(`${name}: unknown key "${key}"`);
  }
  for (const key of Object.keys(input.gateway ?? {})) {
    if (!(key in GATEWAY_DEFAULTS)) throw new Error(`${name}: unknown gateway key "${key}"`);
  }
  if (config.provider !== OFFICE_PROVIDER_ID) throw new Error(`${name}: provider must be "${OFFICE_PROVIDER_ID}"`);
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new Error(`${name}: maxRetries must be a non-negative safe integer`);
  }
  for (const key of ["initialDelayMs", "maxDelayMs"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > MAX_TIMER_DELAY_MS) {
      throw new Error(`${name}: ${key} must be a positive timer-safe number`);
    }
  }
  if (config.initialDelayMs > config.maxDelayMs) throw new Error(`${name}: maxDelayMs must be at least initialDelayMs`);
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new Error(`${name}: jitterRatio must be between 0 and 1`);
  }
  if (!Array.isArray(config.retryableCodes) || config.retryableCodes.some((code) => typeof code !== "string" || !code.trim())) {
    throw new Error(`${name}: retryableCodes must contain non-empty failure codes`);
  }
  for (const key of ["enabled", "verifyEfforts", "verifyAvailability"]) {
    if (typeof config.gateway[key] !== "boolean") throw new Error(`${name}: gateway.${key} must be boolean`);
  }
  if (!Number.isSafeInteger(config.gateway.refreshIntervalMs) || config.gateway.refreshIntervalMs < 0 || config.gateway.refreshIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name}: gateway.refreshIntervalMs must be a non-negative timer-safe integer`);
  }
  return Object.freeze({ ...config, retryableCodes: Object.freeze([...new Set(config.retryableCodes)]), gateway: Object.freeze(config.gateway) });
}

export function officeRetryPolicy(config) {
  return {
    mode: "normal",
    maxRetries: config.maxRetries,
    retryableCodes: [...config.retryableCodes],
    backoff: { initialDelayMs: config.initialDelayMs, maxDelayMs: config.maxDelayMs, jitterRatio: config.jitterRatio },
  };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identity = (provider) => provider ? [provider.api, provider.baseURL?.replace(/\/+$/, ""), provider.apiKeyEnv] : null;
export function isOfficeProvider(provider) {
  return provider?.api === "openai-completions"
    && provider.apiKeyEnv === API_KEY_REFERENCE
    && OFFICE_ENDPOINTS.has(provider.baseURL?.replace(/\/+$/, ""));
}

/** Own only one provider's fields; DSH's native retry executor owns recovery. */
export function createOfficeController(ctx, getConfig, internals = {}) {
  const discover = internals.discover ?? discoverOfficeGatewayCatalog;
  let stopped = false;
  let pending;
  let activeDiscovery;

  async function synchronize(discoverModels) {
    const config = validateConfig(getConfig());
    const section = ctx.settings.get(PROVIDER_NAMESPACE);
    if (!section || stopped) return;
    const existing = section.providers?.[config.provider];
    if (existing && !isOfficeProvider(existing)) return;
    let discovered;
    let credential;
    const credentials = ctx.get?.("credentials");
    if (discoverModels && config.gateway.enabled) {
      const ref = existing?.apiKeyEnv ?? API_KEY_REFERENCE;
      const apiKey = (await credentials?.resolve(ref))?.value;
      credential = apiKey;
      if (apiKey && !stopped) {
        const controller = new AbortController();
        activeDiscovery = controller;
        ctx.logger.info?.("Office gateway: loading the model catalog.");
        try {
          discovered = await discover({
            apiKey,
            signal: controller.signal,
            verifyEfforts: config.gateway.verifyEfforts,
            verifyAvailability: config.gateway.verifyAvailability,
            onProgress(progress) {
              if (progress.type === "listed" && config.gateway.verifyAvailability) {
                ctx.logger.info?.(`Office gateway: checking inference availability for ${progress.total} advertised models.`);
              }
              if (progress.type === "effort-listed" && config.gateway.verifyEfforts) {
                ctx.logger.info?.(`Office gateway: checking Effort capabilities for ${progress.total} eligible models.`);
              }
            },
            ...(ctx.settings.documentPath ? { cachePath: join(dirname(ctx.settings.documentPath), "cache", "office-gateway-capabilities.json") } : {}),
          });
          if (controller.signal.aborted) return;
        } catch {
          // Never expose request/response bodies, authorization headers or keys.
          if (!controller.signal.aborted) ctx.logger.warn("Office gateway discovery failed; keeping the last saved company catalog.");
        } finally {
          if (activeDiscovery === controller) activeDiscovery = undefined;
        }
      }
    }
    if (discovered && (await credentials?.resolve(API_KEY_REFERENCE))?.value !== credential) return;
    // Do not install a late catalog after disposal or a settings change.
    if (stopped || !same(config, validateConfig(getConfig()))) return;
    const latest = ctx.settings.get(PROVIDER_NAMESPACE)?.providers?.[config.provider];
    if (!latest && !discovered) return;
    // A removed or repurposed route, or a rotated key, invalidates old discovery.
    if (!same(identity(existing), identity(latest))) return;
    const revision = ctx.settings.describe?.().find((entry) => entry.ns === PROVIDER_NAMESPACE)?.revision;
    const reportSummary = () => {
      if (discovered) ctx.logger.info?.(`Office gateway: synchronization complete (advertised=${discovered.advertised ?? discovered.provider.models.length}, available=${discovered.available ?? discovered.provider.models.length}, effortCapable=${discovered.effortCapable ?? discovered.provider.models.filter((model) => model.reasoningEfforts && model.reasoningEfforts !== false).length}).`);
    };
    // DSH rejects an empty hand-declared catalog. Remove only this route until
    // a later successful discovery advertises an authorized model again.
    if (discovered?.provider?.models?.length === 0) {
      if (latest && !stopped) await ctx.settings.mutate(PROVIDER_NAMESPACE, [{ op: "unset", path: ["providers", config.provider] }], revision);
      reportSummary();
      return;
    }
    const fields = { retryPolicy: officeRetryPolicy(config) };
    if (discovered) {
      Object.assign(fields, discovered.provider);
      fields.retryPolicy = officeRetryPolicy(config);
      // Keep this route's reference, even if the stock template names another.
      fields.apiKeyEnv = latest?.apiKeyEnv ?? API_KEY_REFERENCE;
    }
    const ops = Object.entries(fields)
      .filter(([key, value]) => !same(latest?.[key], value))
      .map(([key, value]) => ({ op: "set", path: ["providers", config.provider, key], value }));
    if (ops.length && !stopped) await ctx.settings.mutate(PROVIDER_NAMESPACE, ops, revision);
    reportSummary();
  }

  return {
    refresh(discoverModels = true) {
      if (stopped) return Promise.resolve();
      // Model discovery never overlaps, including credential and timer changes.
      const operation = (pending ?? Promise.resolve()).catch(() => {}).then(() => stopped ? undefined : synchronize(discoverModels));
      pending = operation;
      return operation.finally(() => { if (pending === operation) pending = undefined; });
    },
    cancelDiscovery() { activeDiscovery?.abort(); },
    async dispose() {
      stopped = true;
      activeDiscovery?.abort();
      await pending?.catch(() => {});
    },
  };
}

export function apply(ctx, rawConfig = {}, internals = {}) {
  const entry = validateConfig(rawConfig);
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: entry, validate: validateConfig });
  const controller = createOfficeController(ctx, () => scope.get(), internals);
  let timer;
  let namespaceTimer;
  const refresh = (models = true) => controller.refresh(models).catch(() => {
    ctx.logger.warn("Office provider update failed; the current DSH settings are unchanged.");
  });
  function schedule() {
    clearInterval(timer);
    const config = validateConfig(scope.get());
    if (config.gateway.enabled && config.gateway.refreshIntervalMs > 0) {
      timer = setInterval(() => { void refresh(); }, config.gateway.refreshIntervalMs);
      timer.unref?.();
    }
  }
  function initializeWhenProviderSettingsExist() {
    if (ctx.settings.get(PROVIDER_NAMESPACE) !== undefined) {
      void refresh();
      return;
    }
    // Settings.register emits no namespace-registration event. Wait only for
    // this local dependency; this timer never makes a gateway request itself.
    namespaceTimer = setTimeout(initializeWhenProviderSettingsExist, internals.namespaceRetryMs ?? 1000);
    namespaceTimer.unref?.();
  }
  const disposers = [
    scope.watch(() => { controller.cancelDiscovery(); schedule(); return refresh(); }),
    ctx.on("settings/updated", (namespace) => {
      if (namespace === PROVIDER_NAMESPACE) return refresh(false);
    }),
    ctx.on("credentials/reference-updated", (ref) => {
      const provider = ctx.settings.get(PROVIDER_NAMESPACE)?.providers?.[entry.provider];
      if (ref === (provider?.apiKeyEnv ?? API_KEY_REFERENCE)) {
        controller.cancelDiscovery();
        return refresh();
      }
    }),
  ];
  schedule();
  // Cordis 4 has no application `ready` event. Injected services are ready
  // before apply; a later adapter may still register its settings namespace.
  initializeWhenProviderSettingsExist();
  ctx.effect(() => async () => {
    clearInterval(timer);
    clearTimeout(namespaceTimer);
    for (const dispose of disposers) dispose();
    await controller.dispose();
  }, "office provider: stop discovery and drain updates");
}

export const Config = z.object({
  provider: z.const(OFFICE_PROVIDER_ID).default(OFFICE_PROVIDER_ID),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(200),
  initialDelayMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(500),
  maxDelayMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  gateway: z.object({
    enabled: z.boolean().default(false),
    verifyEfforts: z.boolean().default(true),
    verifyAvailability: z.boolean().default(false),
    refreshIntervalMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(900_000),
  }).default(GATEWAY_DEFAULTS),
});

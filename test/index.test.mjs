import assert from "node:assert/strict";
import test from "node:test";
import { apply, Config, createOfficeController, officeRetryPolicy, validateConfig } from "../index.js";

const clone = (value) => structuredClone(value);
const company = { api: "openai-completions", baseURL: "https://aimemodeldev.myhexin.com/litellm/v1", apiKeyEnv: "MYHEXIN_OFFICE_API_KEY", models: [{ id: "old-model" }], headers: { "X-User-Header": "preserved" } };
const official = { models: [{ id: "deepseek-v41-flash" }], retryPolicy: { mode: "normal", maxRetries: 5 } };
const discovered = { provider: { api: "openai-completions", baseURL: "https://aigw-office.myhexin.com/ai-gateway/v1", apiKeyEnv: "MYHEXIN_OFFICE_API_KEY", models: [{ id: "new-model", reasoningEfforts: { low: "low", high: "high" } }] } };

function harness({ route = company, key, getResult = async () => clone(discovered) } = {}) {
  const sections = { "llm-pi-ai": { providers: { other: { untouched: true }, ...(route ? { "myhexin-office": clone(route) } : {}) } }, "llm-deepseek": clone(official), agents: { default: "deepseek-official/deepseek-v41-flash" } };
  const writes = [];
  const warnings = [];
  const calls = [];
  const events = new Map();
  const effects = [];
  const credential = { value: key };
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get(name) { return name === "credentials" ? { resolve: async () => credential.value ? { value: credential.value } : undefined } : undefined; },
    settings: {
      documentPath: "/tmp/test-dsh/settings.json",
      get: (ns) => clone(sections[ns]),
      register(ns, schema, { base, validate }) {
        const initial = schema(base);
        validate(initial);
        sections[ns] = initial;
        return { get: () => clone(sections[ns]), watch: () => () => {} };
      },
      async mutate(ns, ops) {
        writes.push({ ns, ops });
        for (const { op, path, value } of ops) {
          let current = sections[ns];
          for (const part of path.slice(0, -1)) current = current[part] ??= {};
          if (op === "unset") delete current[path.at(-1)];
          else current[path.at(-1)] = clone(value);
        }
        events.get("settings/updated")?.(ns);
      },
    },
    on(event, callback) { events.set(event, callback); return () => events.delete(event); },
    effect(factory) { effects.push(factory()); },
  };
  const internals = { discover: async (options) => { calls.push(options); return getResult(); } };
  return { ctx, sections, writes, warnings, calls, events, credential, internals, dispose: async () => { for (const effect of effects) await effect(); } };
}

test("schema uses company scope and safe opt-in discovery defaults", () => {
  const config = validateConfig(Config({}));
  assert.equal(config.provider, "myhexin-office");
  assert.equal(config.maxRetries, 200);
  assert.equal(config.gateway.enabled, false);
  assert.throws(() => validateConfig({ provider: "deepseek-official" }), /provider must/);
  assert.throws(() => validateConfig({ maxDelayMs: 2 ** 31 }), /timer-safe/);
  assert.throws(() => validateConfig({ initialDelayMs: 100, maxDelayMs: 50 }), /at least/);
  assert.throws(() => validateConfig({ maxRetries: -1 }), /non-negative/);
  assert.throws(() => validateConfig({ unknown: true }), /unknown key/);
});

test("without a company route and opt-in, installation is inert", async () => {
  const h = harness({ route: null, key: "test-only-secret" });
  const controller = createOfficeController(h.ctx, () => ({}), h.internals);
  await controller.refresh();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.calls, []);
  await controller.dispose();
});

test("native capped retry policy affects only the company provider and is idempotent", async () => {
  const h = harness();
  const before = clone(h.sections);
  const config = validateConfig({ maxRetries: 2 });
  const controller = createOfficeController(h.ctx, () => config, h.internals);
  await controller.refresh();
  await controller.refresh();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].ops.map((op) => op.path), [["providers", "myhexin-office", "retryPolicy"]]);
  assert.deepEqual(h.sections["llm-pi-ai"].providers["myhexin-office"].retryPolicy, officeRetryPolicy(config));
  assert.deepEqual(h.sections["llm-deepseek"], before["llm-deepseek"]);
  assert.deepEqual(h.sections.agents, before.agents);
  assert.deepEqual(h.sections["llm-pi-ai"].providers.other, before["llm-pi-ai"].providers.other);
  assert.deepEqual(h.calls, []);
  await controller.dispose();
});

test("discovery needs an explicit opt-in and a resolved company credential", async () => {
  const h = harness({ route: null });
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  await controller.refresh();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.calls, []);
  await controller.dispose();
});

test("gateway capabilities replace only the company catalog and preserve other user settings", async () => {
  const h = harness({ key: "test-only-secret" });
  const before = clone(h.sections);
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  await controller.refresh();
  const result = h.sections["llm-pi-ai"].providers["myhexin-office"];
  assert.deepEqual(result.models, discovered.provider.models);
  assert.equal(result.baseURL, discovered.provider.baseURL);
  assert.equal(result.apiKeyEnv, company.apiKeyEnv);
  assert.deepEqual(result.headers, company.headers);
  assert.deepEqual(h.sections["llm-deepseek"], before["llm-deepseek"]);
  assert.deepEqual(h.sections.agents, before.agents);
  assert.equal(h.calls[0].cachePath, "/tmp/test-dsh/cache/office-gateway-capabilities.json");
  assert.equal(h.calls[0].verifyEfforts, true);
  assert.equal(JSON.stringify(h.writes).includes("test-only-secret"), false);
  await controller.dispose();
});

test("an unavailable gateway preserves the catalog and logs no request secrets", async () => {
  const h = harness({ key: "test-only-secret", getResult: async () => { throw new Error("authorization: Bearer test-only-secret"); } });
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  await controller.refresh();
  const result = h.sections["llm-pi-ai"].providers["myhexin-office"];
  assert.deepEqual(result.models, company.models);
  assert.equal(result.baseURL, company.baseURL);
  assert.equal(h.warnings.length, 1);
  assert.equal(JSON.stringify(h.warnings).includes("test-only-secret"), false);
  await controller.dispose();
});

test("a route removed during discovery is not restored", async () => {
  let release;
  const h = harness({ key: "test-only-secret", getResult: () => new Promise((resolve) => { release = resolve; }) });
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  const pending = controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  delete h.sections["llm-pi-ai"].providers["myhexin-office"];
  release(clone(discovered));
  await pending;
  assert.deepEqual(h.writes, []);
  await controller.dispose();
});

test("disposal prevents a delayed discovery result from changing settings", async () => {
  let release;
  const h = harness({ key: "test-only-secret", getResult: () => new Promise((resolve) => { release = resolve; }) });
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  const pending = controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const disposed = controller.dispose();
  release(clone(discovered));
  await Promise.all([pending, disposed]);
  assert.deepEqual(h.writes, []);
});

test("plugin uses DSH settings and leaves request-error recovery entirely native", async () => {
  const h = harness();
  apply(h.ctx, {}, h.internals);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.has("agent/request-error"), false);
  assert.equal(h.writes.length, 1);
  await h.dispose();
});

test("a repurposed company-named route is never changed or probed", async () => {
  for (const change of [{ baseURL: "https://api.deepseek.com" }, { apiKeyEnv: "DEEPSEEK_API_KEY" }, { api: "anthropic-messages" }]) {
    const h = harness({ route: { ...company, ...change }, key: "test-only-secret" });
    const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
    await controller.refresh();
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
    await controller.dispose();
  }
});

test("endpoint, credential reference and key changes discard in-flight discovery", async () => {
  for (const change of ["endpoint", "reference", "key"]) {
    let release;
    const h = harness({ key: "first-test-key", getResult: () => new Promise((resolve) => { release = resolve; }) });
    const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
    const pending = controller.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    if (change === "endpoint") h.sections["llm-pi-ai"].providers["myhexin-office"].baseURL = "https://other.invalid/v1";
    if (change === "reference") h.sections["llm-pi-ai"].providers["myhexin-office"].apiKeyEnv = "DIFFERENT_KEY";
    if (change === "key") h.credential.value = "rotated-test-key";
    release(clone(discovered));
    await pending;
    assert.deepEqual(h.writes, [], change);
    await controller.dispose();
  }
});

test("dispose cancels the discovery request through its signal", async () => {
  const h = harness({ key: "test-only-secret" });
  h.internals.discover = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  const pending = controller.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.dispose();
  await pending;
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.warnings, []);
});

test("an empty authorized catalog removes only the company route and can recover", async () => {
  let result = { provider: { ...discovered.provider, models: [] } };
  const h = harness({ key: "test-only-secret", getResult: async () => clone(result) });
  const before = clone(h.sections);
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true } }), h.internals);
  await controller.refresh();
  assert.equal(h.sections["llm-pi-ai"].providers["myhexin-office"], undefined);
  assert.deepEqual(h.sections["llm-pi-ai"].providers.other, before["llm-pi-ai"].providers.other);
  assert.deepEqual(h.sections["llm-deepseek"], before["llm-deepseek"]);
  assert.deepEqual(h.sections.agents, before.agents);
  result = discovered;
  await controller.refresh();
  assert.deepEqual(h.sections["llm-pi-ai"].providers["myhexin-office"].models, discovered.provider.models);
  await controller.dispose();
});

test("Cordis 4 starts opt-in discovery without a ready event or a timer", async () => {
  const h = harness({ key: "test-only-secret" });
  apply(h.ctx, { gateway: { enabled: true, refreshIntervalMs: 0 } }, h.internals);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.has("ready"), false);
  assert.deepEqual(h.sections["llm-pi-ai"].providers["myhexin-office"].models, discovered.provider.models);
  await h.dispose();
});

test("a later pi-ai namespace starts discovery even with periodic refresh disabled", async () => {
  const h = harness({ key: "test-only-secret" });
  const providerSettings = h.sections["llm-pi-ai"];
  delete h.sections["llm-pi-ai"];
  apply(h.ctx, { gateway: { enabled: true, refreshIntervalMs: 0 } }, { ...h.internals, namespaceRetryMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.calls.length, 0);
  h.sections["llm-pi-ai"] = providerSettings;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sections["llm-pi-ai"].providers["myhexin-office"].models, discovered.provider.models);
  await h.dispose();
});

test("disposal cancels the wait for a later provider namespace", async () => {
  const h = harness({ key: "test-only-secret" });
  const providerSettings = h.sections["llm-pi-ai"];
  delete h.sections["llm-pi-ai"];
  apply(h.ctx, { gateway: { enabled: true, refreshIntervalMs: 0 } }, { ...h.internals, namespaceRetryMs: 5 });
  await h.dispose();
  h.sections["llm-pi-ai"] = providerSettings;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.calls.length, 0);
});

test("discovery logs only phases and aggregate counts", async () => {
  const h = harness({ key: "test-only-secret" });
  const messages = [];
  h.ctx.logger.info = (message) => messages.push(message);
  h.internals.discover = async ({ onProgress }) => {
    onProgress({ type: "listed", total: 12 });
    onProgress({ type: "effort-listed", total: 4 });
    return { ...clone(discovered), advertised: 12, available: 4, effortCapable: 3 };
  };
  const controller = createOfficeController(h.ctx, () => ({ gateway: { enabled: true, verifyAvailability: true } }), h.internals);
  await controller.refresh();
  assert.equal(messages.length, 4);
  assert.match(messages.at(-1), /advertised=12, available=4, effortCapable=3/);
  assert.equal(JSON.stringify(messages).includes("test-only-secret"), false);
  assert.equal(JSON.stringify(messages).includes("new-model"), false);
  await controller.dispose();
});

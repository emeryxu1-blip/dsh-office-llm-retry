import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { officeRetryPolicy, validateConfig } from "../index.js";

// Point at an unpacked DSH node_modules directory for upstream integration QA.
const runtime = process.env.DSH_RUNTIME_MODULES;
const integration = { skip: !runtime };

async function nativeHarness() {
  const retry = await import(pathToFileURL(join(runtime, "@deepseek-ai/dsh-llm-retry/lib/index.js")));
  const llm = await import(pathToFileURL(join(runtime, "@deepseek-ai/dsh-llm/lib/index.js")));
  let listener;
  let cleanup;
  let projection;
  let state;
  const events = [];
  const session = {
    // New DSH sessions do not expose the old events array.
    get events() { throw new Error("legacy session.events access"); },
    append(type, data) { events.push({ type, data }); state = projection.apply(state, { type, data }); },
  };
  retry.apply({
    sessionProjections: {
      register(value) { projection = value; state = value.init(); },
      stateOf() { return state; },
    },
    on(type, fn) { assert.equal(type, "agent/request-error"); listener = fn; return () => {}; },
    effect(factory) { cleanup = factory(); },
    logger: { warn() {} },
  }, {}, { random: () => 0.5 });
  return { events, session, resolve: llm.resolveRetryPolicy, invoke: (payload, next = async () => undefined) => listener({ agent: { session }, turn: 1, step: 0, signal: new AbortController().signal, failure: { code: "TRANSPORT", message: "test" }, ...payload }, next), dispose: cleanup };
}

test("DSH native projection executor caps company retry at 200 while official retains factory five", integration, async () => {
  const h = await nativeHarness();
  const retryPolicy = h.resolve(officeRetryPolicy(validateConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 })), "office test");
  for (let retry = 1; retry <= 200; retry++) {
    assert.deepEqual(await h.invoke({ provider: "myhexin-office", retryPolicy }), { kind: "retry" });
  }
  assert.equal(await h.invoke({ provider: "myhexin-office", retryPolicy }), undefined);
  const officeEvents = h.events.filter((event) => event.type === "llm/retry");
  assert.equal(officeEvents.length, 200);
  assert.equal(officeEvents.at(-1).data.retry, 200);
  assert.equal(officeEvents.at(-1).data.maxRetries, 200);
  const official = h.resolve(undefined, "official test");
  assert.equal(official.maxRetries, 5);
  // Keep its factory count/codes, reduce only test wait time.
  const fastOfficial = { ...official, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 };
  for (let retry = 1; retry <= 5; retry++) {
    assert.deepEqual(await h.invoke({ provider: "deepseek-official", retryPolicy: fastOfficial }), { kind: "retry" });
  }
  assert.equal(await h.invoke({ provider: "deepseek-official", retryPolicy: fastOfficial }), undefined);
  await h.dispose();
});

test("native company retry preserves failure classification, cancellation and step resets", integration, async () => {
  const h = await nativeHarness();
  const retryPolicy = h.resolve(officeRetryPolicy(validateConfig({ maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1 })), "office test");
  assert.equal(await h.invoke({ provider: "myhexin-office", retryPolicy, failure: { code: "AUTH", message: "test" } }), undefined);
  assert.deepEqual(await h.invoke({ provider: "myhexin-office", retryPolicy }), { kind: "retry" });
  assert.equal(await h.invoke({ provider: "myhexin-office", retryPolicy }), undefined);
  h.session.append("step/start", {});
  const controller = new AbortController();
  const result = h.invoke({ provider: "myhexin-office", retryPolicy: { ...retryPolicy, initialDelayMs: 1000, maxDelayMs: 1000 }, signal: controller.signal });
  controller.abort();
  assert.equal(await result, undefined);
  assert.equal(h.events.filter((event) => event.type === "llm/retry-started").length, 1);
  await h.dispose();
});

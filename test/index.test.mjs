import assert from "node:assert/strict";
import test from "node:test";
import { apply, Config } from "../index.js";

function harness(events = []) {
  let listener;
  let cleanup;
  const ctx = {
    on(type, fn) {
      assert.equal(type, "agent/request-error");
      listener = fn;
      return () => { listener = undefined; };
    },
    effect(factory) {
      cleanup = factory();
    },
    logger: { warn() {} },
  };
  const session = { events, append(type, data) { events.push({ type, data }); } };
  const agent = { session };
  return { ctx, agent, invoke(payload, next = async () => undefined) { return listener({ agent, ...payload }, next); }, dispose: async () => cleanup?.() };
}

const failure = { code: "TRANSPORT", message: "Connection error" };

test("exposes a configurable maxRetries schema", () => {
  assert.ok(Config);
  assert.equal(typeof Config, "function");
});

test("retries every office failure and preserves the provider request boundary", async () => {
  const h = harness();
  apply(h.ctx, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, { random: () => 0.5 });
  assert.deepEqual(await h.invoke({ turn: 1, step: 0, provider: "myhexin-office", failure, signal: new AbortController().signal }), { kind: "retry" });
  assert.deepEqual(await h.invoke({ turn: 1, step: 0, provider: "myhexin-office", failure, signal: new AbortController().signal }), { kind: "retry" });
  let delegated = 0;
  assert.equal(await h.invoke({ turn: 1, step: 0, provider: "myhexin-office", failure, signal: new AbortController().signal }, async () => { delegated += 1; }), undefined);
  assert.equal(delegated, 1);
  assert.deepEqual(h.agent.session.events.filter((e) => e.type === "llm/retry").map((e) => e.data.retry), [1, 2]);
  assert.equal(h.agent.session.events.find((e) => e.type === "llm/retry").data.mode, "normal");
  assert.equal(h.agent.session.events.find((e) => e.type === "llm/retry").data.maxRetries, 2);
  assert.deepEqual(h.agent.session.events.filter((e) => e.type === "llm/retry-started").map((e) => e.data.retry), [1, 2]);
  await h.dispose();
});

test("caps retries at exactly 200 and retries a non-default failure code", async () => {
  const h = harness();
  apply(h.ctx, { maxRetries: 200, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 });
  for (let i = 1; i <= 200; i += 1) {
    assert.deepEqual(await h.invoke({ turn: 7, step: 2, provider: "myhexin-office", failure: { code: "INVALID_REQUEST", message: "bad wire" }, signal: new AbortController().signal }), { kind: "retry" });
  }
  let delegated = 0;
  assert.equal(await h.invoke({ turn: 7, step: 2, provider: "myhexin-office", failure, signal: new AbortController().signal }, async () => { delegated += 1; }), undefined);
  assert.equal(delegated, 1);
  assert.equal(h.agent.session.events.filter((e) => e.type === "llm/retry").length, 200);
  assert.equal(h.agent.session.events.filter((e) => e.type === "llm/retry-started").length, 200);
  await h.dispose();
});

test("retries every provider but not an aborted request", async () => {
  const h = harness();
  apply(h.ctx, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 });
  let delegated = 0;
  const next = async () => { delegated += 1; };
  assert.deepEqual(await h.invoke({ turn: 1, step: 0, provider: "other", failure, signal: new AbortController().signal }), { kind: "retry" });
  const controller = new AbortController();
  controller.abort();
  assert.equal(await h.invoke({ turn: 1, step: 0, provider: "myhexin-office", failure, signal: controller.signal }, next), undefined);
  assert.equal(delegated, 1);
  assert.equal(h.agent.session.events.filter((e) => e.type === "llm/retry").length, 1);
  await h.dispose();
});

test("cancelling backoff prevents retry-started", async () => {
  const h = harness();
  apply(h.ctx, { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 });
  const controller = new AbortController();
  const pending = h.invoke({ turn: 1, step: 0, provider: "myhexin-office", failure, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(h.agent.session.events.filter((e) => e.type === "llm/retry-started").length, 0);
  await h.dispose();
});

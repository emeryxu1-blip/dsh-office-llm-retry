import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverOfficeGatewayCatalog, disclosedReasoningEfforts,
  OFFICE_LISTING_URL, OFFICE_CHAT_URL, OFFICE_INFERENCE_BASE_URL,
} from "../gateway.js";

const apiKey = "fake-office-test-key";
const listed = (models) => new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } });
const disclosure = (levels, status = 400) => new Response(JSON.stringify({ error: {
  message: `Invalid reasoning_effort; valid levels: ${levels.join(", ")}No fallback model group found`,
} }), { status });
const jsonError = (status) => new Response(JSON.stringify({ error: { message: "denied or unavailable" } }), { status });

async function cacheFixture(t) {
  const home = await mkdtemp(join(tmpdir(), "office-capabilities-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return join(home, "capabilities.json");
}

test("new Office route enumerates exact validation levels and excludes unauthorized models", async () => {
  const calls = [];
  const result = await discoverOfficeGatewayCatalog({ apiKey, fetch: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
    if (init.method === "GET") return listed([{ id: "auto" }, { id: "private-model" }, { id: "plain" }]);
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 1);
    assert.equal(body.stream, false);
    assert.match(body.reasoning_effort, /^dsh-invalid-/u);
    if (body.model === "auto") return disclosure(["low", "medium", "high", "xhigh", "max"]);
    return jsonError(body.model === "private-model" ? 401 : 400);
  } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, OFFICE_LISTING_URL);
  assert.ok(calls.slice(1).every((call) => call.url === OFFICE_CHAT_URL));
  assert.equal(result.provider.baseURL, OFFICE_INFERENCE_BASE_URL);
  assert.equal(result.provider.apiKeyEnv, "MYHEXIN_OFFICE_API_KEY");
  assert.deepEqual(result.provider.models, [
    { id: "auto", name: "auto", reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
    { id: "plain", name: "plain", reasoningEfforts: false },
  ]);
  assert.equal(result.available, 2);
  assert.equal(result.advertised, 3);
  assert.deepEqual(result.failures, [{ id: "private-model", reason: "HTTP 401" }]);
});

test("missing credentials never sends a request", async () => {
  await assert.rejects(discoverOfficeGatewayCatalog({ fetch: () => { throw Error("must not fetch"); } }), /credential is missing/u);
});

test("explicit metadata avoids probing and no capability is inferred from a model name", async () => {
  const result = await discoverOfficeGatewayCatalog({ apiKey, verifyEfforts: false, fetch: async (_url, init) => {
    assert.equal(init.method, "GET");
    return listed([
      { id: "gpt-6-astra" },
      { id: "claude-opus-thinking", reasoning_efforts: ["none", "low", "high", "ultra"] },
      { id: "multimodal", reasoningEfforts: false, input: ["text", "image"] },
      { id: "bad-metadata", reasoningEfforts: { turbo: "turbo", high: "unverified" } },
      { id: "gpt-6-astra" },
    ]);
  } });
  assert.deepEqual(result.provider.models, [
    { id: "gpt-6-astra", name: "gpt-6-astra", reasoningEfforts: false },
    { id: "claude-opus-thinking", name: "claude-opus-thinking", reasoningEfforts: { off: "none", low: "low", high: "high", max: "ultra" } },
    { id: "multimodal", name: "multimodal", input: ["text", "image"], reasoningEfforts: false },
    { id: "bad-metadata", name: "bad-metadata", reasoningEfforts: false },
  ]);
  assert.deepEqual(result.provider.defaultInput, ["text"]);
});

test("a successful completion cannot supply a validation disclosure", async () => {
  const result = await discoverOfficeGatewayCatalog({ apiKey, fetch: async (_url, init) => init.method === "GET"
    ? listed([{ id: "ignores-invalid" }]) : disclosure(["low", "high"], 200) });
  assert.equal(result.provider.models[0].reasoningEfforts, false);
  assert.match(result.effortFailures[0].reason, /accepted an invalid effort/u);
});

test("transient overload retains the listed route but hides unverified efforts", async () => {
  let posts = 0;
  const result = await discoverOfficeGatewayCatalog({ apiKey, probeTimeoutMs: 100, fetch: async (_url, init) => {
    if (init.method === "GET") return listed([{ id: "busy" }]);
    posts += 1;
    return new Response("", { status: 429, headers: { "retry-after": "10" } });
  } });
  assert.equal(posts, 1);
  assert.deepEqual(result.provider.models, [{ id: "busy", name: "busy", reasoningEfforts: false }]);
});

test("cache avoids recurring probes and contains no API key", async (t) => {
  const cachePath = await cacheFixture(t);
  let posts = 0;
  const fetch = async (_url, init) => {
    if (init.method === "GET") return listed([{ id: "auto" }]);
    posts += 1;
    return disclosure(["low", "max"]);
  };
  const first = await discoverOfficeGatewayCatalog({ apiKey, cachePath, fetch, now: () => 1_000_000 });
  const second = await discoverOfficeGatewayCatalog({ apiKey, cachePath, fetch, now: () => 1_000_100 });
  assert.equal(posts, 1);
  assert.deepEqual(first.provider, second.provider);
  assert.equal(second.cacheWritten, true);
  const content = await readFile(cachePath, "utf8");
  assert.equal(content.includes(apiKey), false);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
});

test("cache is invalidated on credential rotation and endpoint changes", async (t) => {
  const cachePath = await cacheFixture(t);
  let posts = 0;
  const fetch = async (_url, init) => {
    if (init.method === "GET") return listed([{ id: "auto" }]);
    posts += 1;
    return disclosure(["low"]);
  };
  await discoverOfficeGatewayCatalog({ apiKey, cachePath, fetch });
  await discoverOfficeGatewayCatalog({ apiKey: "rotated-fake-key", cachePath, fetch });
  assert.equal(posts, 2);
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  cache.endpoint = "https://aimemodeldev.myhexin.com/litellm";
  await writeFile(cachePath, JSON.stringify(cache));
  await discoverOfficeGatewayCatalog({ apiKey: "rotated-fake-key", cachePath, fetch });
  assert.equal(posts, 3);
});

test("capability cache expires, unauthorized results expire sooner, and old models are not published", async (t) => {
  const cachePath = await cacheFixture(t);
  let current = 1_000_000;
  let modelIds = ["denied", "available"];
  let posts = 0;
  const fetch = async (_url, init) => {
    if (init.method === "GET") return listed(modelIds.map((id) => ({ id })));
    posts += 1;
    return JSON.parse(init.body).model === "denied" ? jsonError(403) : disclosure(["low"]);
  };
  const options = { apiKey, cachePath, fetch, now: () => current };
  await discoverOfficeGatewayCatalog(options);
  current += 300_001;
  await discoverOfficeGatewayCatalog(options);
  assert.equal(posts, 3);
  current += 86_400_000;
  modelIds = ["available"];
  const result = await discoverOfficeGatewayCatalog(options);
  assert.equal(posts, 4);
  assert.deepEqual(result.provider.models.map((entry) => entry.id), ["available"]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cachePath, "utf8")).models), ["available"]);
});

test("insecure and corrupt caches are ignored", async (t) => {
  const cachePath = await cacheFixture(t);
  let posts = 0;
  const options = { apiKey, cachePath, fetch: async (_url, init) => {
    if (init.method === "GET") return listed([{ id: "auto" }]);
    posts += 1;
    return disclosure(["high"]);
  } };
  await discoverOfficeGatewayCatalog(options);
  await chmod(cachePath, 0o644);
  await discoverOfficeGatewayCatalog(options);
  assert.equal(posts, 2);
  await writeFile(cachePath, "invalid json");
  await discoverOfficeGatewayCatalog(options);
  assert.equal(posts, 3);
});

test("listing failures cannot publish a stale capability cache", async (t) => {
  const cachePath = await cacheFixture(t);
  await assert.rejects(discoverOfficeGatewayCatalog({ apiKey, cachePath, fetch: async () => jsonError(401) }), /HTTP 401/u);
  await assert.rejects(readFile(cachePath), { code: "ENOENT" });
});

test("external cancellation aborts in-flight probes without continuing through the catalog", async () => {
  const controller = new AbortController();
  let posts = 0;
  const operation = discoverOfficeGatewayCatalog({ apiKey, signal: controller.signal, probeConcurrency: 1,
    fetch: async (_url, init) => {
      if (init.method === "GET") return listed([{ id: "first" }, { id: "second" }]);
      posts += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        controller.abort(new Error("plugin disposed"));
      });
    },
  });
  await assert.rejects(operation, /plugin disposed/u);
  assert.equal(posts, 1);
});

test("strict availability opts into bounded echo completions and excludes incomplete streams", async () => {
  let echoCalls = 0;
  let effortCalls = 0;
  const result = await discoverOfficeGatewayCatalog({ apiKey, verifyAvailability: true,
    randomToken: () => "test-unique-probe-token",
    fetch: async (_url, init) => {
      if (init.method === "GET") return listed([{ id: "works" }, { id: "incomplete" }]);
      const body = JSON.parse(init.body);
      if (body.reasoning_effort !== undefined) {
        effortCalls += 1;
        return disclosure(["high"]);
      }
      echoCalls += 1;
      assert.equal(body.max_tokens, 256);
      assert.equal(body.stream, true);
      const events = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "test-unique-probe-token" }, finish_reason: null }] })}`,
        "",
      ];
      if (body.model === "works") events.push(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        "", "data: [DONE]", "",
      );
      return new Response(events.join("\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(echoCalls, 2);
  assert.equal(effortCalls, 1);
  assert.deepEqual(result.provider.models, [{ id: "works", name: "works", reasoningEfforts: { high: "high" } }]);
  assert.equal(result.failures[0].id, "incomplete");
});

test("disclosure parser stops at fallback messages and rejects off-only levels", () => {
  assert.deepEqual(disclosedReasoningEfforts("valid levels: low, highNo fallback model group max"), { low: "low", high: "high" });
  assert.equal(disclosedReasoningEfforts("model gpt-6-astra supports deep thinking"), undefined);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as office from "../index.js";

const runtime = process.env.DSH_RUNTIME_MODULES;
const integration = { skip: !runtime };
const native = (name) => import(pathToFileURL(join(runtime, `@deepseek-ai/${name}/lib/index.js`)));
async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("native settings update did not settle");
}

test("native Loader/settings persist scoped discovery and live policies using rc.3 APIs", integration, async (t) => {
  const [{ boot, initProfile, readProfilePatches }, { default: Editor }, { default: Settings }, { default: Llm }, pi] = await Promise.all([
    native("dsh-app-boot"), native("dsh-config-editor"), native("dsh-settings"), native("dsh-llm"), native("dsh-llm-pi-ai"),
  ]);
  const home = await realpath(await mkdtemp(join(tmpdir(), "office-native-settings-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, "profiles", "test");
  initProfile(dir, ["test-office-bundle"]);
  const bundle = join(dir, "node_modules", "test-office-bundle");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(home, "package.json"), '{"name":"test-installation"}\n');
  await writeFile(join(bundle, "package.json"), JSON.stringify({ name: "test-office-bundle", version: "1.0.0", dsh: { bundle: { patch: "cordis.patch.yml" } } }));
  const otherRoute = { api: "openai-completions", baseURL: "https://unrelated.invalid/v1", models: [{ id: "other", reasoningEfforts: false }] };
  await writeFile(join(bundle, "cordis.patch.yml"), JSON.stringify([{ insert: [
    { id: "config-editor", name: "cordis:editor" },
    { id: "settings", name: "cordis:settings" },
    { id: "llm", name: "cordis:llm" },
    { id: "llm-pi-ai", name: "cordis:pi", config: { providers: { unrelated: otherRoute } } },
    { id: office.name, name: "cordis:office", config: { gateway: { enabled: true, refreshIntervalMs: 0 } } },
  ] }]));
  await writeFile(join(dir, "cordis.yml"), "[]\n");
  const profile = { name: "test", startedBundles: ["test-office-bundle"], dir, patchPath: join(dir, "cordis.patch.yml"), installAnchor: join(home, "package.json"), cwd: home, home, overlays: [] };
  let discoveries = 0;
  const ctx = await boot("test", join(dir, "cordis.yml"), readProfilePatches("test", profile), (ctx) => {
    ctx.provide("profileContext", profile);
    ctx.provide("appReady", { onReady: (listener) => { listener(); return () => {}; } });
    ctx.provide("credentials", { resolve: async () => ({ value: "test-only-secret" }) });
    Object.assign(ctx.loader.builtins, {
      editor: Editor, settings: Settings, llm: Llm, pi,
      office: { ...office, apply: (ctx, config) => office.apply(ctx, config, {
        namespaceRetryMs: 5,
        discover: async () => {
          discoveries++;
          return { provider: { api: "openai-completions", baseURL: "https://aigw-office.myhexin.com/ai-gateway/v1", apiKeyEnv: "MYHEXIN_OFFICE_API_KEY", models: [{ id: "office-test", reasoningEfforts: { low: "low", high: "high" } }] } };
        },
      }) },
    });
  });
  t.after(() => ctx.fiber.dispose());
  const descriptor = () => ctx.settings.describe().find((row) => row.ns === "llm-pi-ai");
  await eventually(() => descriptor()?.value.providers["myhexin-office"]?.retryPolicy?.maxRetries === 200);
  assert.equal(discoveries, 1);
  assert.deepEqual(descriptor().value.providers.unrelated, pi.Config({ providers: { unrelated: otherRoute } }).providers.get().unrelated);
  const fiber = [...ctx.loader.entries()].find((row) => row.options.id === office.name).fiber;
  await ctx.settings.update(office.name, { maxRetries: 7 });
  await eventually(() => descriptor().value.providers["myhexin-office"].retryPolicy.maxRetries === 7);
  assert.equal([...ctx.loader.entries()].find((row) => row.options.id === office.name).fiber, fiber);
  assert.deepEqual(descriptor().value.providers.unrelated, pi.Config({ providers: { unrelated: otherRoute } }).providers.get().unrelated);
  const beforeInvalid = await readFile(profile.patchPath, "utf8");
  await assert.rejects(ctx.settings.update(office.name, { initialDelayMs: 10_000, maxDelayMs: 1 }), /at least/);
  assert.equal(await readFile(profile.patchPath, "utf8"), beforeInvalid);
  assert.equal(beforeInvalid.includes("test-only-secret"), false);
});

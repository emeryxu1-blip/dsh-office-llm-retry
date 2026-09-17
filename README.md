# DSH Office Gateway and Retry Plugin

[中文说明](README.zh-CN.md)

Company gateway discovery and finite retries for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), tested with **DSH 0.1.5-rc.1**. Version 0.2.0 uses DSH's native provider retry policy and session projections. It has no Matrix Skin dependency, stylesheet, browser script, global launcher, or machine-specific path.

The plugin owns only `llm-pi-ai.providers.myhexin-office`. DeepSeek's official provider keeps its factory model list, Effort choices, and retry behavior. Other providers, the chosen default model, and existing conversations are unchanged.

## Install

Requires Node.js 20 or newer, DSH 0.1.5-rc.1 or newer compatible settings APIs, the standard `llm-pi-ai` adapter, and the built-in `llm-retry` plugin.

```bash
# Use DSH's plugin manager so it reconciles the bundle:
dsh plugin --profile web add -w /path/to/dsh-office-llm-retry
```

The package declares `dsh.bundle` with `cordis.patch.yml`. Keep **the native `llm-retry` enabled**. Remove the old `id: llm-retry / disabled: true` override when upgrading from 0.1.0. No custom `agent/request-error` handler remains. For a legacy manual installation, ensure the package is in the profile's `dependencies` (not only `devDependencies`) and its name is present in `dsh.profile.bundles`. Once the bundle supplies the entry, replace any old manual `insert` for `dsh-llm-retry-capped` with the ID-only configuration override shown below; two inserts would load the plugin twice. A plain `pnpm add` does not perform DSH bundle reconciliation.

## Enable company discovery

Store the company key through DSH's credential service under `MYHEXIN_OFFICE_API_KEY`; never put the key in this plugin or its settings. Edit the plugin entry in your profile patch:

```yaml
- id: dsh-llm-retry-capped
  config:
    provider: myhexin-office
    maxRetries: 200
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
    gateway:
      enabled: true
      verifyEfforts: true
      verifyAvailability: false
      refreshIntervalMs: 900000
```

Settings are also available under the `dsh-office-llm-retry` namespace. Without a company route, discovery opt-in, and an available company credential, installing this plugin does not create a company provider. Discovery defaults to disabled. An existing recognized company route still receives the scoped retry policy.

When enabled, the plugin reads the Office portal's current gateway:

- Catalog: `https://aigw-office.myhexin.com/ai-gateway/models`
- Inference: `https://aigw-office.myhexin.com/ai-gateway/v1/chat/completions`

It automatically migrates the recognized old `https://aimemodeldev.myhexin.com/litellm/v1` route. An existing route is managed only when its ID, endpoint, `openai-completions` protocol, and `MYHEXIN_OFFICE_API_KEY` reference match. A user who repurposes that route for another endpoint or credential is left alone. Endpoint, reference, or key changes invalidate an in-flight discovery.

## Models and Effort

Discovery runs asynchronously after launch. Startup logs report the catalog, availability and Effort phases, then aggregate counts; the dropdown updates after validation finishes. Late registration of the pi-ai settings namespace is awaited without network polling.

The catalog follows `/models`. Effort choices come from explicit model metadata or gateway validation, never from a model name. With `verifyEfforts: true`, the plugin uses bounded `max_tokens: 1` validation probes when metadata is absent. A gateway that accepts invalid input without explaining supported choices does not prove a capability: unknown Effort controls stay hidden. These probes can generate a minimal response on servers that ignore invalid input.

Capability results are cached without API keys next to the settings document in `cache/office-gateway-capabilities.json`. Confirmed results last 24 hours; uncertain or denied results are checked again sooner. Cache entries are tied to the endpoint and a credential hash. Listing happens on startup, company credential changes, and the configured refresh interval. `refreshIntervalMs: 0` disables periodic refresh. `verifyAvailability: true` additionally sends bounded completion probes (at most 256 output tokens per attempt) and excludes models that cannot complete inference. The default `false` checks listing and Effort/authorization evidence only, not end-to-end inference. To verify availability at startup without recurring inference probes, use `verifyAvailability: true` with `refreshIntervalMs: 0`. Such checks may consume a small amount of tokens per advertised model.

A failed catalog request preserves the last saved company catalog. Explicitly unauthorized models are excluded. An empty or entirely unauthorized catalog removes only the company route, because DSH cannot register an empty custom catalog; a later successful discovery recreates it. Credentials and the user's default model setting remain stored. If that default names an unavailable company model, choose an available model before sending.

## Retry policy

| Option | Default | Meaning |
|---|---:|---|
| `maxRetries` | `200` | Eligible retries after the first request; `0` disables company retries. |
| `initialDelayMs` | `500` | Initial exponential-backoff delay. |
| `maxDelayMs` | `10000` | Maximum delay; an excessive provider Retry-After falls back to DSH's terminal failure behavior. |
| `jitterRatio` | `0.1` | Symmetric jitter, from 0 to 1. |
| `retryableCodes` | See below | Failure codes accepted by the company policy. |

Defaults: `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `STREAM_CLOSED`, `PI_AI_ERROR`. Unlike 0.1.0, this version does not retry permanent authentication or configuration failures automatically and does not alter every provider. Additional failure codes can be configured explicitly. Retries can repeat input-token billing.

DSH's native retry executor handles durable retry counts, partial-stream recovery, cancellation, and plugin shutdown. There is one retry executor, so reaching 200 does not fall into a second retry budget. Removing this plugin stops future synchronization; its saved company provider configuration remains editable in DSH.

## Development

```bash
pnpm install
pnpm test
# Include integration against the actual installed DSH native retry executor:
DSH_RUNTIME_MODULES=/path/to/dsh/node_modules pnpm test
```

Tests cover provider isolation, credential and endpoint races, capability validation, caching, cancellation, empty catalogs, native projection retry limits, and the official five-retry default. The integration tests skip when `DSH_RUNTIME_MODULES` is omitted.

## License

MIT

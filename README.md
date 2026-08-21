# DSH Capped LLM Retry Plugin

[中文说明](README.zh-CN.md)

A provider-neutral retry plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It provides a configurable finite retry budget for model requests across **all configured providers**. It does not contain provider names, API endpoints, API keys, or gateway-specific logic.

## What it does

The plugin listens at DSH's `agent/request-error` boundary and retries the complete failed agent step. This covers failures:

- before the first response token;
- after partial streaming output;
- during later LLM steps in an ongoing dialogue;
- for every failure code, including transport/connection, timeout, server, rate-limit, protocol, and configuration failures.

Partial failed stream output is not promoted to durable assistant history. The next attempt reconstructs the request from durable session state, so the model receives the same prompt/history.

The retry count is configurable. **The default is 200 retries after the initial attempt**, for at most 201 provider calls. Each durable retry event includes the configured `maxRetries`, so the DSH UI displays the configured budget—for example `Retrying model request (1/200)`. When the configured retry budget is exhausted, the original failure is returned and the turn stops.

> Important: retries can repeat input-token billing. Permanent authentication or configuration failures may consume the full retry budget.

## Requirements

- Node.js 20 or newer
- DSH with the Cordis plugin loader
- `@deepseek-ai/schemastery` (installed automatically as a package dependency)
- One or more configured DSH provider routes

## Install

From your DSH profile directory:

```bash
pnpm add github:emeryxu1-blip/dsh-office-llm-retry
```

Or install a released package/local checkout through your package manager:

```bash
pnpm add dsh-office-llm-retry
pnpm add /path/to/dsh-office-llm-retry
```

The package declares a `dsh.bundle`, so DSH profile reconciliation can activate its `cordis.patch.yml` layer.

## Configure

Add the plugin to the profile's `cordis.patch.yml`. Disable the built-in DSH retry row so two retry handlers do not run together:

```yaml
- id: llm-retry
  disabled: true

- insert:
    - id: dsh-llm-retry-capped
      name: 'dsh-office-llm-retry'
      config:
        maxRetries: 200
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

No provider name, API URL, or API key is required. The plugin receives the provider identity from DSH for each failed request and applies the same retry policy to every provider.

### Configuration

| Option | Default | Description |
|---|---:|---|
| `maxRetries` | `200` | Number of retries after the initial request. Must be a non-negative integer. |
| `initialDelayMs` | `500` | Initial local backoff delay. |
| `maxDelayMs` | `10000` | Maximum local backoff delay and maximum accepted provider retry-after delay. |
| `jitterRatio` | `0.1` | Symmetric backoff jitter from 0 to 1. |

For example, to allow only 20 retries:

```yaml
config:
  maxRetries: 20
```

## Disable the built-in retry plugin

The standard DSH bundle already includes `@deepseek-ai/dsh-llm-retry`. It normally has a smaller provider-owned retry policy. If this plugin is used as the replacement for all providers, keep this row disabled:

```yaml
- id: llm-retry
  disabled: true
```

The disabled built-in entry may still appear in DSH Settings → Plugins because DSH displays configured Loader entries, including disabled entries. It does not execute.

## Cancellation and behavior

Backoff waits are cancelled when the request is aborted or the plugin is disposed. Retry records are durable, non-surface session events and are not inserted into the model prompt. The plugin does not wrap direct `ctx.llm.stream()` consumers; it operates at the agent-loop boundary where replay is safe.

## Development

```bash
pnpm install
pnpm test
```

## License

MIT

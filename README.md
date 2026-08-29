# smart-switch

[English] | [简体中文](./README.zh-CN.md)

Multi-app model provider switcher. Manage OpenAI-protocol and Anthropic-protocol
providers (base URL + API key + models) in one place and sync them into the config
files of your coding agents — like cc-switch, but for eight apps at once.

| App | Config written | Protocols |
|---|---|---|
| Claude Code | `~/.claude/settings.json` env block | anthropic |
| Codex CLI | `~/.codex/config.toml` + `auth.json` (Responses API only) | openai |
| Oh My Pi (omp) | `~/.omp/agent/models.yml` (comments preserved) | both |
| pi | `~/.pi/agent/models.json` + `settings.json` | both |
| prime-agent | `~/.prime/agent/models.json` + `settings.json` | both |
| opencode | `~/.config/opencode/opencode.json` | both |
| Hermes | `~/.hermes/config.yaml` + `.env` (comments preserved) | both |
| WorkBuddy | `~/.workbuddy/models.json` + `settings.json` | openai |

Model metadata — context window, max input/output tokens, reasoning/thinking levels,
image input, pricing — is enriched from [models.dev](https://models.dev) and pushed
into each app's config (`thinkingLevelMap` for pi/prime, `limit`/`attachment` for
opencode, `contextWindow`/`maxTokens` for omp, ...). Reseller `/v1/models` endpoints
carry no metadata; this closes that gap.

## Install

```bash
npm install -g smart-switch   # requires Node >= 22.12
```

## Quick start

```bash
# add a provider: interactive, or fully flagged with model discovery
smart-switch add
smart-switch add -y --id myproxy --protocol openai \
  --base-url https://api.example.com/v1 --api-key sk-... --discover

smart-switch use myproxy            # switch every detected app to this provider
smart-switch status                 # what each app currently points at
```

## Commands

```bash
smart-switch list                   # configured providers
smart-switch use myproxy -a codex,omp -m glm-5.2
smart-switch use myproxy --dry-run  # preview config diffs without writing
smart-switch sync                   # re-apply the active provider

smart-switch discover myproxy --sync    # refresh model list + metadata, push out
smart-switch models "glm-5.2"           # search the models.dev catalog
smart-switch refresh                    # re-fetch metadata for all providers

smart-switch prune myproxy          # remove provider entries from app configs
smart-switch remove myproxy --prune

# agent installation manager (like cc-switch's environment check)
smart-switch apps                   # installed vs latest version per agent
smart-switch install pi
smart-switch upgrade                # upgrade everything outdated
```

## Model discovery filters

`--discover` lists model ids from the provider's `/v1/models`, then enriches each id
from models.dev. Reseller lists are noisy; filters are persisted per provider and
re-applied on every `discover`:

```bash
# snapshot duplicates (gpt-5.2-latest, glm-4.7-250414, ...) are DROPPED by default
# whenever the bare id is also listed; snapshot-only models are kept as-is
smart-switch add -y --discover --exclude "*embedding*,*video*" --id myproxy ...
smart-switch add -y --discover --no-dedup ...            # keep duplicates
smart-switch discover myproxy --include "gpt-*,glm-*"    # update the persisted filter
smart-switch discover myproxy --no-filter                # clear it
```

Explicit `--models` entries and the default model are never filtered out.

## Notes

- Every modified config file is backed up first to `~/.config/smart-switch/backups/`.
- Provider store lives at `~/.config/smart-switch/config.json` (mode 0600).
- Codex only speaks the OpenAI Responses API; chat-completions-only endpoints
  cannot be used with Codex (the sync output warns about this).
- `~/.codex/config.toml` comments are not preserved (TOML round-trip); YAML
  configs (omp, hermes) keep comments.
- The apps manager (install/upgrade) currently targets macOS/Linux.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # node:test suite (filter semantics, adapter roundtrips)
npm run dev -- ...  # run from source via tsx
```

## License

MIT

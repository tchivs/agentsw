# smart-switch

Multi-app model provider switcher. Manage OpenAI-protocol and Anthropic-protocol
providers (base URL + API key + models) in one place and sync them into the config
files of your coding agents:

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

## Usage

```bash
# add a provider (interactive, or fully flagged)
smart-switch add
smart-switch add -y --id myproxy --protocol openai \
  --base-url https://api.example.com/v1 --api-key sk-... --discover

# --discover lists model ids from the provider's /v1/models,
# then enriches each id from models.dev

smart-switch list                  # configured providers
smart-switch use myproxy           # switch every detected app to this provider
smart-switch use myproxy -a codex,omp -m glm-5.2
smart-switch use myproxy --dry-run # preview config diffs without writing
smart-switch sync                  # re-apply the active provider
smart-switch status                # what each app currently points at

smart-switch discover myproxy --sync   # refresh model list + metadata, push out
smart-switch models "glm-5.2"          # search the models.dev catalog
smart-switch refresh                   # re-fetch metadata for all providers

smart-switch prune myproxy         # remove provider entries from app configs
smart-switch remove myproxy --prune

# agent installation manager
smart-switch apps                  # installed vs latest version per agent
smart-switch install pi
smart-switch upgrade               # upgrade everything outdated
```

## Notes

- Every modified config file is backed up first to `~/.config/smart-switch/backups/`.
- Provider store lives at `~/.config/smart-switch/config.json` (mode 0600).
- Codex only speaks the OpenAI Responses API; chat-completions-only endpoints
  cannot be used with Codex (the sync output warns about this).
- `~/.codex/config.toml` comments are not preserved (TOML round-trip); YAML
  configs (omp, hermes) keep comments.
- The apps manager (install/upgrade) currently targets macOS/Linux.

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-30

### Added

- First-run provider import: scan custom providers from Claude Code, Codex, omp,
  pi, prime-agent, opencode, Hermes and WorkBuddy configs; preview and multi-select
  candidates; merge duplicates by normalized base URL + wire protocol while
  preserving different protocols on the same host; union model ids/source apps;
  resolve inline/env-backed API keys; enrich imported models from models.dev.
  Available from the empty-store menu and `smart-switch import [--all]`.
- English / 简体中文 CLI i18n: first-run language selection, persisted menu
  preference, system-locale auto-detection, `SMART_SWITCH_LANG` and `--lang`
  overrides, plus localized help, provider add/import prompts, and core menu
  command output.

## [0.2.0] - 2026-08-30

### Added

- Interactive main menu on bare invocation — `npx smart-switch` (zero install) or
  `smart-switch` with no arguments: add/update a provider via guided prompts
  (protocol, base URL, API key, discover-or-manual model list), switch providers
  (with optional default-model override), status, list, sync, discover,
  remove, and agent version check/upgrade. Non-TTY bare invocation prints help.
- `.version` now reads package.json instead of a hardcoded literal.

## [0.1.1] - 2026-08-30

### Changed

- Release pipeline now publishes via npm OIDC trusted publishing (no token secrets).
- Bilingual docs (English / 简体中文), CHANGELOG, LICENSE, CI matrix (ubuntu/macos × Node 22/24).


## [0.1.0] - 2026-08-30

### Added

- Provider management: `add` (interactive or flagged), `list`, `remove`, `use`,
  `sync`, `status` across eight coding agents: Claude Code, Codex CLI, Oh My Pi,
  pi, prime-agent, opencode, Hermes (NousResearch), WorkBuddy (Tencent).
- OpenAI-protocol and Anthropic-protocol providers; per-app protocol gating
  (Codex is Responses-API/openai-only, Claude Code and WorkBuddy per their wire).
- models.dev integration: metadata enrichment (context window, input/output
  limits, reasoning effort levels, image input, pricing) pushed into each app's
  config — `thinkingLevelMap` for pi/prime, `limit`/`attachment`/`cost` for
  opencode, `contextWindow`/`maxTokens` for omp, capability flags for WorkBuddy.
- Model discovery: `add --discover` and `discover <id> [--sync]` list ids from
  the provider's `/v1/models` and re-enrich from models.dev, reporting upstream
  additions/removals.
- Discovery filters, persisted per provider: `--include`/`--exclude` globs and
  default snapshot-duplicate dropping (`-latest`, date suffixes) with
  `--no-dedup` opt-out; explicit models and the default model are never dropped.
- Agent installation manager: `apps` (installed vs latest via npm/PyPI/brew/
  GitHub releases), `install <app>`, `upgrade [apps...]`.
- Safety: timestamped backups of every modified config, atomic writes,
  YAML comment preservation (omp, hermes), `--dry-run` line-diff preview for
  `use`/`sync`, `prune <id>` / `remove --prune` cleanup.
- `models <query>` catalog search and `refresh` metadata re-fetch with 24h cache
  and offline fallback.
- Test suite (`node:test`): filter semantics and adapter apply/prune roundtrips.

[Unreleased]: https://github.com/tchivs/smart-switch/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tchivs/smart-switch/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tchivs/smart-switch/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tchivs/smart-switch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tchivs/smart-switch/releases/tag/v0.1.0

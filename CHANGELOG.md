# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/smart-switch/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/smart-switch/releases/tag/v0.1.0

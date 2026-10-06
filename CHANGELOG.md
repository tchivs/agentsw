# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `sync` refreshes the provider's model list (and re-enriches saved metadata) before writing the
  agent configs, so one command keeps both sides in step; `sync --no-refresh` writes the saved
  list without fetching. The menu's separate model-list action and its "also sync?" toggle are
  gone — the single **Sync a provider** action runs the same refresh-then-write path as the CLI.

### Added

- `sync --all` syncs every configured provider, and `--provider` now takes a comma-separated list
  (`sync -p alpha,beta`), so refreshing a machine's providers is one command instead of one per
  provider. The menu's **Sync providers** action is a multi-select with an "all" row; selecting
  nothing returns to the menu.

  Each provider is refreshed and written in turn, with the active provider last, so whatever
  "current" pointer an app keeps ends up where the store says it should. An app that names a single
  provider rather than a map — Claude Code's env block — is written once, for the active provider,
  and left untouched when none of the synced providers is the active one, because syncing is not
  switching. A provider whose endpoint cannot be reached is reported and skipped; the rest still
  sync and the run exits non-zero. `--json` reports a `providers` array plus the deduplicated union
  of the files touched; a single-provider sync keeps the payload it had.

### Fixed

- `sync --dry-run` no longer saves the refreshed model list. The refresh above ran before the
  dry-run scope opened, so previewing a sync wrote the freshly fetched list straight into the
  provider store — the one thing `--dry-run` promises not to do. The fetch still happens, so the
  preview matches what a real sync would write, but the list now stays in memory and `--json`
  reports it as `refreshed.saved: false`.

## [0.10.2] - 2026-10-04

### Fixed

- `use`, `sync` and `prune` no longer print a bare `ok <app>` line for an app that was already
  in sync. An empty change list was rendered as nothing at all, leaving a row of trailing
  whitespace that read as a truncated or failed result; it now says `unchanged`, which is what
  a repeated `sync` actually did.
- Codex states the Responses requirement only when the endpoint has not declared itself
  Responses-compatible. The caveat was printed unconditionally, so a provider the user had
  already marked `responses` — where there is nothing to warn about — warned anyway, and a
  fully successful sync looked like it had a problem.
- Syncing to a machine whose agent configs do not exist yet no longer prints a `backup: …` line
  when nothing was backed up. A transaction directory was created for every commit even when
  every planned file was new, so on a first run the output announced eight backups that held
  nothing but a manifest.

## [0.10.1] - 2026-10-03

### Fixed

- A models.dev row that omits `canonical_model_id` no longer counts as a second creator identity.
  models.dev leaves the field unset on the creator's own rows and on some reseller rows too, so a
  single silent row made an id every other row agreed on report as ambiguous and kept it — and
  every model sharing its basename — without metadata. Those rows now make no claim; a group where
  nothing declares an identity is still held to its listing ids, and ids listed under genuinely
  different declared identities still stay unresolved.
- A sync no longer deletes the limits an agent config already has for a model the store knows
  nothing about. Clearing an owned key the entry omits is only meaningful when the entry carries
  metadata at all — an id no catalog row matched arrives as a bare `{ id }`, so the absence said
  nothing and the deletion threw away what an earlier lookup filled in (or a person typed) on
  every miss.
- A failed AI Gateway request is retried once before falling back to the cache. The endpoint is
  reached over whatever route the machine has, where a cold handshake measures an order of
  magnitude slower than a warm one, so a stall or a reset is far likelier than a bad answer — and
  a single stall used to leave the run on stale metadata until the next successful fetch. Only
  the request is retried: a status, an oversize body or an unparseable catalog is the endpoint's
  answer, and a second request would only repeat it. `AGENTSW_DEBUG=1` reports why an attempt
  failed (the user-facing warning stays generic), and `AGENTSW_GATEWAY_TIMEOUT_MS` overrides the
  15-second whole-request budget.

## [0.10.0] - 2026-10-03

### Added

- Global `--json` prints exactly one credential-free document per run
  (`{"ok":true,"command":…,"version":…,"data":…}`, or `{"ok":false,…,"error":{"message":…}}` with
  exit code 1) and disables prompts and progress, so scripted runs never block on input.
  `--json --dry-run` lists the file paths a run would touch without ever emitting the staged
  configuration. Without `--json`, `models --provider <id> --metadata` keeps its bare object.
- Global `--quiet` suppresses progress, hints and warnings while keeping results and errors, and
  `--no-color` disables color (so does `NO_COLOR`; `--no-color` overrides `FORCE_COLOR`).
- Slow operations report progress on a TTY: protocol probing, model-list pagination (page and
  running model count), catalog and metadata lookups, Gateway loading, and per-app version
  checks. The line animates only when nothing else is borrowing it and disappears before
  results print; pipes and CI keep the previous single static line, and `AGENTSW_NO_PROGRESS=1`
  turns it off.
- `discover`/`add`/`quick`/`import` retry a failed discovery when interactive instead of losing
  the whole run, and a failing menu action reports the error and returns to the menu.
- Menu provider pickers and the removal scope select gained a "back to main menu" entry, and
  Ctrl-C inside a menu prompt abandons that action instead of quitting the application.

### Changed

- Tables size themselves to the terminal: long BASE URL, CONFIG and NAME cells are truncated
  with `…` while IDs and status columns stay intact, and numeric columns are right-aligned.
  Piped output is unchanged.
- Interactive cancellation is consistent: standalone prompts print `cancelled` and exit `130`;
  inside the menu they return to the menu. Errors are red and warnings yellow everywhere, and
  the remaining hardcoded English strings follow the interface language.
- `apps` and `upgrade` output, install hints and model-discovery messages are localized; every
  user-visible "next step" hint now goes to stderr so `--quiet` can drop it.

### Fixed

- A corrupt or unreadable models.dev cache no longer aborts `models`, `add`, `discover` or
  `refresh`: it is ignored and refetched, and a 200 response that is not catalog-shaped is
  rejected instead of being cached and failing every later run.
- `models --limit` values that are not positive integers (`--limit abc`, `--limit 0`, ...)
  fail with a clear error instead of dumping the whole catalog or one row.
- `discover` no longer reports a pinned default or small model that the provider stopped
  listing under "removed upstream" while keeping it anyway.
- Switching providers no longer inherits the previous provider's `model_reasoning_effort` in
  Codex, and opencode clears a provider's own small model once that provider stops defining one.
- The dsh adapter reads a wire declared on every model, as omp and pi already did, so such
  providers import instead of being skipped and keep their Responses wire on sync.
- Claude Code and Codex now honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; previously they always
  wrote `~/.claude` and `~/.codex`, so a relocated install was configured in the wrong place
  and `status`/`remove`/`rename` disagreed with `use`.
- The opencode adapter edits the file that actually exists, chooses between `opencode.json`,
  `opencode.jsonc` and `config.json` the way opencode does, and preserves comments — `rename`
  previously migrated `config.json` only in the default directory.
- A base URL whose path already ends in `/models` no longer becomes `/models/v1/models`, and
  model-list pagination stops after 100 pages instead of looping forever on an endpoint that
  keeps returning fresh cursors.
- A provider store containing a wrong-typed provider or model is now rejected at load with the
  file and provider id, instead of crashing later with an opaque `TypeError`.

### Changed

- All config paths come from one resolver (`src/app-paths.ts`) and are recomputed per command,
  so every adapter, `rename` and `remove` agree on the same files; `dsh` also honors
  `%LOCALAPPDATA%` on Windows.

## [0.9.2] - 2026-10-01

### Fixed

- Reseller model listings no longer lose their metadata. models.dev lists one model under many
  providers (29 rows for `glm-5.2`), each with its own provider-prefixed id, so a bare id taken from
  a reseller's `/v1/models` looked like dozens of conflicting models and was refused
  entirely — leaving pi/prime-agent configs without `reasoning` or `thinkingLevelMap`, i.e. no
  thinking level to adjust. Matching now groups rows by models.dev's `canonical_model_id` and
  takes the creator's own row, so context, output limits, reasoning and effort levels resolve;
  rows under genuinely different creator identities stay ambiguous, and Gateway agreement is
  compared in creator identity too.

- Adding the same endpoint and API key under a different `--id` or display name no longer creates a
  second provider. Account identity (normalized endpoint + protocol + credential) now outranks an
  explicit id in `add` and `quick-add`, matching what `import` already did; the existing provider is
  updated and the run says so. Protocol suffixes still apply to genuinely new accounts.
- Only the creator's own models.dev row supplies limits, prices and reasoning levels for a model that
  resellers also list. Gateways key their rows by the canonical model id and were being read as
  authoritative, so e.g. `deepseek-v4.1-flash` picked up a gateway's price.
- Model tables, `refresh` and provider output are localized, and models left without metadata are
  split into ids an explicit `--gateway-models` mapping can fix, ids whose creator has no models.dev
  row (AI Gateway fills those), and ids no creator lists at all — instead of one flat count.

## [0.9.1] - 2026-09-11

### Changed

- Example provider names, hosts and test fixtures no longer reference a real account.
  Git history, tags and the npm tarball were rewritten so the previous name appears nowhere
  in the repository or the published README.

## [0.9.0] - 2026-09-11

### Added

- Interactive menu app picker for `use`, `sync` and `discover --sync`: multi-select the agents
  to write, with an "all detected apps" row, detected agents listed first and undetected ones
  marked. The last selection is remembered in `syncTargets`, so the menu stops rewriting agents
  you left out; CLI `--apps` semantics are unchanged.

### Changed

- Report why a config file was rejected instead of hiding it: JSON/YAML/TOML parse failures now
  carry the file plus a position (YAML error code and line, JSON error offset, TOML line/column),
  and dry-run shows that detail rather than "configuration could not be previewed safely".
  Unclassified errors stay redacted wholesale.

### Fixed

- Never echo config source in parse errors. JSON, YAML and TOML parser messages quote the
  offending line, which can contain a credential; all three are now converted to
  content-free `SafeConfigError` messages.

## [0.8.0] - 2026-09-05

### Added

- Automatic AI Gateway model metadata supplementation with a separate 24-hour cache,
  exact model mappings, field-level provenance/conflicts and reference-only pricing.
- Per-provider `--metadata-mode <auto|on|off>` settings in add/quick/discover/import/refresh,
  a three-way menu selection, and `models --provider <id> --metadata` for credential-free
  audit JSON including the effective mode. Legacy enable/disable flags remain supported.

### Changed

- Default to automatic, models.dev-first enrichment without extra onboarding prompts.
  Query Gateway only for missing core parameters, refreshing existing supplemental fields,
  or verifying tracked identity conflicts; preserve explicit off and all omitted saved settings.
- Resolve unique, exact bare-name model IDs conservatively without changing wire IDs;
  ambiguous/custom names still require explicit aliases. Sync remains catalog-free.
- Preserve manual/legacy model values and extension fields during enrichment;
  refresh tracked automatic metadata without overwriting subsequent manual edits.
- Preserve selected default/small-model metadata when discovery omits those IDs.

## [0.7.2] - 2026-09-05

### Fixed

- Stage every adapter's multi-file changes before committing, preserve permissions,
  create private unique backups, and reject stale provider-store saves under a
  shared short-lived write lock. Dry-run output is redacted and never writes.
- Isolate generated credential references for distinct provider IDs; preserve
  shared/custom references, YAML aliases and complete multiline dotenv values.
- Disambiguate WorkBuddy account removal, allow credentialless local entries,
  verify active Codex credentials before global deletion, and apply target-specific
  literal/reference semantics during rename and import.
- Preserve existing options on repeated automatic onboarding, retain Responses
  routing and custom Codex fields, reject mixed effective model protocols, and
  maintain WorkBuddy endpoint paths and owned model lists across synchronization.
- Fetch complete model-list pagination before updating the store, preserve query
  parameters when constructing requests, distinguish non-v1 API identities, and
  prefer complete model-ID metadata matches over basename fallbacks.
- Keep help/version and agent-local management independent of malformed central
  configuration; validate selected targets before changing active-provider state.
- Correct SemVer precedence, probe Windows batch shims correctly, propagate failed
  installer pipelines, and report unknown/failed version checks rather than success.

### Changed

- Minimum Node.js is now **22.13.0**, where built-in SQLite no longer needs an
  experimental flag. CI includes the exact minimum and installed-package CLI
  smoke tests on Linux, macOS and Windows.
- Expanded command, account-isolation, transaction, discovery, platform and metadata
  regressions; clarified backup scope, non-interactive import and adapter integration docs.

## [0.7.1] - 2026-09-05

### Changed

- Interactive menu labels describe concrete actions, with contextual help for
  each choice in English and Simplified Chinese. Automatic provider setup is
  listed first; saved providers, agent configuration, syncing, and model-list
  updates are clearly distinguished.
- Removal choices and confirmations explain what is deleted and what stays,
  including the effect of later syncing after agent-only removal. Rename is
  labeled as changing the provider ID, not a custom display name.
- Rename and removal confirmations use explicit action labels and default to
  cancellation. Added bilingual menu and scope-confirmation regression tests.

## [0.7.0] - 2026-09-05

### Added

- Explicit `rename <id> <new-id>` with configuration-reference migration,
  preflight conflict checks, private backups, and `--dry-run`.
- `remove <id> --apps <apps>` removes agent-local providers, including entries
  never imported into agentsw, without deleting the central store or other apps.
- `list --apps <apps>` lists local provider IDs. The interactive menu now offers
  rename and scoped removal with previews and confirmation.

### Changed

- Automatically named providers use the full hostname plus protocol, including
  single-protocol endpoints. Explicit IDs and existing account names stay stable.
- Import deduplication distinguishes credentials and prefers explicit provider
  names over generated IDs for the same account.
- Provider removal validates all planned changes and backs up affected files
  before mutation, retaining the central entry if app cleanup fails preflight.

## [0.6.2] - 2026-09-05

### Fixed

- OMP now resolves YAML aliases with document context before syncing or pruning.
  Replacing an anchored model list no longer leaves dangling aliases in other
  providers; shared provider/model values and unrelated comments are retained.
- pi and prime-agent now read and edit JSONC configuration, including comments,
  trailing commas, and a UTF-8 BOM, without discarding unrelated fields or comments.
- pi/prime validate both model and settings files before writing either file;
  malformed configuration reports its path instead of leaving a partial sync.
- Added first-sync, repeated-sync, prune, dry-run, and malformed-config regression
  fixtures for initialized servers with YAML anchors and commented JSON files.

## [0.6.1] - 2026-09-05

### Fixed

- Corrected the overly broad `/v1` stripping introduced in 0.6.0. OpenAI
  clients append only `/responses` or `/chat/completions`, so omp, pi,
  prime-agent, DeepSeek Harness, OpenCode, and Hermes now retain versioned
  OpenAI base URLs while Anthropic SDK clients still avoid `/v1/v1/messages`.
- OpenCode now uses `@ai-sdk/openai` for Responses providers, keeps its
  Anthropic AI SDK base URL version, writes only complete `limit` objects, and
  continues to honor `OPENCODE_CONFIG_DIR` for shared configuration.
- Hermes now maps Responses providers to its `codex_responses` transport
  instead of sending reasoning/tool requests through chat completions.

## [0.6.0] - 2026-09-03

### Fixed

- **v1/v1 double-path bug**: target adapters now strip the trailing `/v1` (or
  `/v2`, `/v1beta`) from `baseUrl` when writing to apps whose own SDK appends
  `/v1/...` to the base URL (Claude Code, opencode, hermes, omp, pi, prime, dsh).
  Codex is the exception — it appends `/responses` directly, so it keeps `/v1`.
  This prevents `https://host/v1/v1/messages` style requests when a provider's
  stored `baseUrl` includes the API version segment.

## [0.5.5] - 2026-09-03

### Added

- AGENTS.md — repository guidelines for AI assistants: architecture, data flow,
  key directories, development commands, code conventions, and testing.

## [0.5.4] - 2026-09-03

### Fixed

- dsh detection: restore binary probe for global installs (`dsh --version`),
  with localVersion fallback for npx-only users. Also added a fast
  global-node_modules path check before the slow `npm ls -g` subprocess.

## [0.5.3] - 2026-09-03

### Fixed

- dsh detection: dsh has no global binary (it runs via `npx @deepseek-ai/dsh web`).
  The `apps` command now detects dsh via npx cache, global npm install, or the
  `~/.dsh` config directory instead of probing for a `dsh` binary in PATH.

## [0.5.2] - 2026-09-03

### Fixed

- Windows CI: skip Unix file-permission assertion for dsh credentials on
  win32 (chmod bits are not honored by NTFS).

## [0.5.1] - 2026-09-03

### Added

- Interactive menu now includes an "安装智能体" (install agent) option that
  lists all not-yet-installed agents and installs them via their official
  install commands.

## [0.5.0] - 2026-09-02

### Fixed

- `apps` / `upgrade` no longer leaks `/bin/sh: brew: not found` to the terminal on
  Linux when Homebrew is absent — the `brew info` probe now captures stderr
  instead of inheriting it.
- `apps` status no longer shows "up to date" when the installed version is
  unknown (`?`) or the latest version lookup failed (`?`). These now display
  "unknown" instead of falsely claiming the app is current.
- Model tables (`add`, `discover`, `models --provider`) now print a dim hint
  when some models have no models.dev metadata, so the `-` columns are clearly
  "uncataloged" rather than looking like a display bug.
- `add` with manual model entry no longer fails when the user leaves the model
  list blank — it now auto-discovers from the provider's `/v1/models` instead of
  erroring with "at least one model id is required". The prompt text also notes
  that leaving blank triggers auto-discovery.

### Added

- `agentsw quick` — one-command provider setup: pass only `--base-url` and
  `--api-key` (or just answer two prompts interactively), and agentsw probes
  the endpoint with both OpenAI (`Bearer`) and Anthropic (`x-api-key`) auth
  headers to auto-detect which protocol(s) it speaks. When both succeed, two
  providers are created with `-openai` / `-anthropic` suffixes; models are
  auto-discovered from `/v1/models` for each. The provider id is derived from
  the URL host when `--id` is omitted. Also available as "quick add" in the
  interactive menu.

- Windows support for provider synchronization and app state paths, native Windows
  install commands for the npm/Python-managed agents, Windows executable shim probing,
  and a Windows CI job.

## [0.4.0] - 2026-09-02

### Changed

- **Renamed to `agentsw`** (was `smart-switch`, which collided with home-automation
  switches and React switch components in every search). Binaries are `agentsw` and
  `asw`; the store moves to `~/.config/agentsw/`, the locale override becomes
  `AGENTSW_LANG`, and generated credential references become `AGENTSW_<ID>_API_KEY`.
  A clean cutover — the old name has no released users to migrate.

### Added

- DeepSeek Harness (`dsh`) adapter: writes the `llm-pi-ai` provider route and the
  `agent-default-model` selection into `$DSH_HOME/settings.yaml` (default `~/.dsh`),
  stores the key as a credential reference in `$DSH_HOME/.credentials.yaml` (mode 0600,
  pre-release flat documents migrated to the version 1 layout), imports existing routes,
  and joins the apps manager (`npm i -g @deepseek-ai/dsh`).

- OpenAI Responses wire support for omp/pi/prime/dsh providers: `openai-responses`
  (plus the Azure/Codex variants) is recognized on import — provider-level or
  declared on the models — persisted per provider and written back on sync. New
  `agentsw add --openai-api <completions|responses>`, also asked interactively.

- `import` also reads cc-switch's own provider store (`~/.cc-switch/cc-switch.db`,
  opened read-only, never written back): its Claude env blocks, Codex `config.toml`
  payloads and pi-family rows all become candidates, deduped against the same
  providers found in the agents' configs.

### Fixed

- Import no longer skips omp/pi/prime providers whose `api` is `openai-responses`;
  previously only `openai-completions` and `anthropic-messages` entries were seen,
  so responses-only reseller endpoints were invisible to agentsw.
- Import dedupe now spans the `/v1` segment: omp/pi/opencode keep it in the base URL
  while Codex leaves it off (the client appends it), so the same reseller used to be
  imported twice — `sub` and `sub-2`. One endpoint is now one provider, and the
  variant naming the API version is the one stored.
- Sync no longer drops provider-level keys agentsw does not model when
  rewriting an existing provider entry — omp/pi/prime (`authHeader`, `headers`,
  `compat`, `auth`, `discovery`, ...), opencode (`options.headers`, per-model
  fields) and Hermes — or per-model extras such as `thinkingLevelMap`. Only the
  fields agentsw owns are overwritten, and an existing responses wire is
  never downgraded to chat completions.
- A re-sync now clears the per-model keys agentsw owns but no longer emits
  (a stale `thinkingLevelMap` beside `reasoning: false`, sizes the catalog dropped),
  removes `disableStrictTools` when a provider is re-applied on an openai wire, and
  drops per-model `api`/`baseUrl` overrides that contradict the route it just wrote
  (they would silently win over the provider entry). Dropped overrides are reported.
- A provider whose models declare different wire protocols is skipped on import
  instead of being adopted under the first model's protocol.

## [0.3.0] - 2026-08-30

### Added

- First-run provider import: scan custom providers from Claude Code, Codex, omp,
  pi, prime-agent, opencode, Hermes and WorkBuddy configs; preview and multi-select
  candidates; merge duplicates by normalized base URL + wire protocol while
  preserving different protocols on the same host; union model ids/source apps;
  resolve inline/env-backed API keys; enrich imported models from models.dev.
  Available from the empty-store menu and `agentsw import [--all]`.
- English / 简体中文 CLI i18n: first-run language selection, persisted menu
  preference, system-locale auto-detection, `AGENTSW_LANG` and `--lang`
  overrides, plus localized help, provider add/import prompts, and core menu
  command output.

## [0.2.0] - 2026-08-30

### Added

- Interactive main menu on bare invocation — `npx agentsw` (zero install) or
  `agentsw` with no arguments: add/update a provider via guided prompts
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

[Unreleased]: https://github.com/tchivs/agentsw/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/tchivs/agentsw/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/tchivs/agentsw/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/tchivs/agentsw/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/tchivs/agentsw/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/tchivs/agentsw/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/tchivs/agentsw/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/tchivs/agentsw/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/tchivs/agentsw/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/tchivs/agentsw/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/tchivs/agentsw/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/tchivs/agentsw/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/tchivs/agentsw/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/tchivs/agentsw/compare/v0.5.5...v0.6.0
[0.5.5]: https://github.com/tchivs/agentsw/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/tchivs/agentsw/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/tchivs/agentsw/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/tchivs/agentsw/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/tchivs/agentsw/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tchivs/agentsw/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tchivs/agentsw/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tchivs/agentsw/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tchivs/agentsw/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tchivs/agentsw/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tchivs/agentsw/releases/tag/v0.1.0

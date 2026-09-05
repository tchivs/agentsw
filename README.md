<div align="center">

# agentsw

**One provider, every coding agent — from the terminal.**

A CLI that keeps your OpenAI- and Anthropic-protocol providers — base URL, key, model list,
metadata — in one place and writes the active one into nine agents' own config files,
without touching the settings you hand-tuned.

[![npm version](https://img.shields.io/npm/v/agentsw?logo=npm&logoColor=white)](https://www.npmjs.com/package/agentsw)
[![CI](https://img.shields.io/github/actions/workflow/status/tchivs/agentsw/ci.yml?branch=main&logo=github&logoColor=white&label=CI)](https://github.com/tchivs/agentsw/actions/workflows/ci.yml)
[![node version](https://img.shields.io/node/v/agentsw?logo=nodedotjs&logoColor=white)](#install)
[![license](https://img.shields.io/npm/l/agentsw?color=blue)](./LICENSE)

[Install](#install) · [Quick start](#quick-start) · [Supported apps](#supported-apps) · [Commands](#commands) · [简体中文](./README.zh-CN.md)

</div>

```console
$ asw use vfing -m glm-5.3-flash
switching to vfing (openai) · default model glm-5.3-flash

skip claude    Claude Code does not support openai-protocol providers
ok   codex     ~/.codex/config.toml, ~/.codex/auth.json
               backup: ~/.config/agentsw/backups/transaction-<unique>
ok   omp       ~/.omp/agent/models.yml
               select in omp with: omp --model vfing/glm-5.3-flash
skip pi        pi not detected (pass --apps pi to force)
ok   opencode  ~/.config/opencode/opencode.json
ok   dsh       ~/.dsh/settings.yaml, ~/.dsh/.credentials.yaml
               select in dsh with the model picker, or run: dsh web
```

`agentsw` and the short `asw` are the same binary.

## Why a CLI

- **It runs where a desktop app cannot.** Headless servers, containers, devcontainers, CI.
  `npx agentsw use myproxy -a codex,omp` is one line in a provisioning script; nine GUI
  clicks are not.
- **`--dry-run` prints redacted diffs.** Preview changes without writing files or creating
  backups. Existing configuration files are backed up when actual changes are committed.
- **Non-destructive by design.** Only the fields agentsw owns are rewritten. Provider-level
  keys it does not model — `authHeader`, `headers`, `compat`, `discovery` — per-model extras
  like `thinkingLevelMap`, and YAML comments all survive a re-sync.
- **Model metadata, not just an id list.** Reseller `/v1/models` endpoints return bare ids.
  agentsw enriches them from [models.dev](https://models.dev) and writes what each app
  actually reads: `thinkingLevelMap` for pi/prime, `limit`/`attachment` for opencode,
  `contextWindow`/`maxTokens` for omp, `reasoningEfforts`/`input` for dsh.
- **Adopts what you already have** — including [cc-switch](https://github.com/farion1231/cc-switch).
  `import` scans every installed agent *and* cc-switch's own store, merges duplicates
  (same protocol + normalized endpoint + credentials), and never writes back to either.
- **Wire-aware.** `/v1/chat/completions` and `/v1/responses` are different endpoints;
  agentsw tracks which one a provider speaks and never downgrades a working one.

Want a GUI, MCP/Skills sync, a usage dashboard or a local failover proxy? Use
[cc-switch](https://github.com/farion1231/cc-switch) — it is excellent at that, and agentsw
imports from it rather than competing with it.

## Install

```bash
npx agentsw               # zero install: opens the interactive menu
npm install -g agentsw    # requires Node >= 22.13 (built-in SQLite without an extra flag)
```

The provider sync and config management work on Linux, macOS, and Windows. On Windows,
agentsw stores its own state under `%APPDATA%\agentsw`; native app-data locations are
used for agents that require them. Set `AGENTSW_HOME` when running from Git Bash/WSL or
when a portable home directory is desired.

## Quick start

```bash
agentsw                   # no args: interactive menu (add, import, use, status, apps)
```

The first run on an empty store offers to import the providers already configured in your
agents, and asks for English or 简体中文. Prefer flags? The same flow, unattended:

```bash
# add a provider and let it discover its own model list
asw add -y --id vfing --protocol openai --openai-api responses \
  --base-url https://api.example.com/v1 --api-key sk-... --discover

asw use vfing             # point every detected agent at it
asw use vfing --dry-run   # ...or just show the diffs
asw status                # what each agent points at right now
```

```console
$ asw status
config: ~/.config/agentsw/config.json
active provider: vfing

APP        FOUND  PROTOCOLS         CURRENT                               CONFIG
---------  -----  ----------------  ------------------------------------  ---------------------------
claude     yes    anthropic         -                                     ~/.claude/settings.json
codex      yes    openai            vfing · glm-5.3-flash                 ~/.codex/config.toml
omp        yes    openai+anthropic  providers: sub, sub-anthropic, vfing  ~/.omp/agent/models.yml
pi         no     openai+anthropic  -                                     ~/.pi/agent/models.json
opencode   yes    openai+anthropic  vfing/glm-5.3-flash                   ~/.config/opencode/opencode.json
dsh        yes    openai+anthropic  vfing · glm-5.3-flash                 ~/.dsh/settings.yaml
```

## Supported apps

| App | Config written | Protocols |
|---|---|---|
| [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) | `~/.claude/settings.json` env block | anthropic |
| [Codex CLI](https://www.npmjs.com/package/@openai/codex) | `~/.codex/config.toml` + `auth.json` (Responses API only) | openai |
| [Oh My Pi](https://omp.sh) (omp) | `~/.omp/agent/models.yml` (comments preserved) | both |
| [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | `~/.pi/agent/models.json` + `settings.json` | both |
| [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | `~/.prime/agent/models.json` + `settings.json` | both |
| [opencode](https://opencode.ai) | `~/.config/opencode/opencode.json` | both |
| [Hermes](https://pypi.org/project/hermes-agent/) | `~/.hermes/config.yaml` + `.env` (comments preserved) | both |
| WorkBuddy | `~/.workbuddy/models.json` + `settings.json` | openai |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) | `~/.dsh/settings.yaml` + `.credentials.yaml` | both |

An agent that is not installed is skipped, not guessed at. `--apps codex,omp` narrows a run;
`--apps` with an uninstalled agent forces it.

## Import what you already configured

`import` reads every agent's config **and cc-switch's SQLite store** (read-only), resolves
inline and env-backed keys, and merges candidates that share a protocol + base URL — model
lists and source apps are unioned. Different protocols on the same host stay separate.

```console
$ asw import --all
ID             PROTOCOL   BASE URL                                MODELS  FROM       KEY
-------------  ---------  --------------------------------------  ------  ---------  ---
any            anthropic  https://a-ocnfniawgw.cn-shanghai...     1       cc-switch  yes
sub            openai     https://new.vfing.de/v1                 18      omp        yes
sub-anthropic  anthropic  https://new.vfing.de                    18      omp        yes
zhipu-glm      anthropic  https://open.bigmodel.cn/api/anthropic  1       cc-switch  yes
imported sub · openai · https://new.vfing.de/v1 · 18 models [from omp]
imported zhipu-glm · anthropic · https://open.bigmodel.cn/api/anthropic · 1 models [from cc-switch]
```

In an interactive terminal, omitting `--all` opens a multi-select preview before provider
records are saved. `--all`, or non-interactive stdin, imports all eligible new entries;
use `--all` explicitly in scripts. Model discovery may update the local metadata cache.

## Model discovery filters

`--discover` lists model ids from the provider's `/v1/models`, then enriches each id from
models.dev. Reseller lists are noisy, so filters are persisted per provider and re-applied on
every `discover`:

```bash
# snapshot duplicates (gpt-5.2-latest, glm-4.7-250414, ...) are DROPPED by default
# whenever the bare id is also listed; snapshot-only models are kept as-is
asw add -y --discover --exclude "*embedding*,*video*" --id myproxy ...
asw add -y --discover --no-dedup ...            # keep duplicates
asw discover myproxy --include "gpt-*,glm-*"    # update the persisted filter
asw discover myproxy --no-filter                # clear it
```

Explicit `--models` entries and the default model are never filtered out.

## Commands

| Command | What it does |
|---|---|
| `agentsw` | interactive menu (no arguments) |
| `add` | add or update a provider; `--discover` fills the model list |
| `quick` | discover protocols/models from URL + API key; auto-name by hostname + protocol |
| `import [--all]` | adopt providers from your agents' configs and cc-switch |
| `list` / `status` | configured providers / what each agent points at |
| `list --apps omp,prime` | list agent-local provider IDs, including entries absent from agentsw |
| `rename <id> <new-id>` | back up and migrate the ID and config references; supports `--dry-run` |
| `use <id>` | switch every detected agent; `-a codex,omp`, `-m <model>`, `--dry-run` |
| `sync` | re-apply the active provider (after an agent update, say) |
| `discover <id> [--sync]` | refresh the model list + metadata from `/v1/models` |
| `models [query]` | search the models.dev catalog |
| `refresh` | re-fetch metadata for every configured provider |
| `prune <id>` / `remove <id> [--prune]` | remove from app configs / from the store |
| `remove <id> --apps omp` | delete only the selected app's entry; supports `--dry-run` |
| `apps` / `install <app>` / `upgrade` | agent version manager |

```bash
asw use myproxy -a codex,omp -m glm-5.2
asw discover myproxy --sync
asw remove myproxy --prune
```

New automatic IDs include the full hostname and protocol, e.g. `api-example-com-openai`.
An explicit `--id` is retained, and syncing never renames an existing provider. Import
deduplication compares endpoint, protocol, and credentials; different accounts remain separate.

```bash
asw rename myproxy api-example-com-openai --dry-run
asw rename myproxy api-example-com-openai
asw list --apps omp
asw remove unused-provider --apps omp --dry-run
asw remove unused-provider --apps omp
```

`remove` alone changes only the agentsw store; `--prune` also cleans matching app configs.
`--apps` is instead app-only and can remove a provider never imported into agentsw.
Do not combine `--apps` and `--prune`. Renames and removals preflight changes and create
private backups before writes. App-only removal leaves the store intact, so a later explicit
sync of a managed provider can add it back to that app.

## How your configs are treated

- Existing provider-store and agent configuration files are backed up before committed
  changes to `~/.config/agentsw/backups/transaction-*`. New files have no prior copy;
  cache refreshes are not configuration backups. Dry runs create neither files nor backups.
- Each adapter stages all its files before committing; failed writes trigger best-effort
  rollback. A multi-agent sync is not one filesystem-wide transaction: successful agents
  remain updated if another fails, and failures are reported with a nonzero exit status.
- The provider store lives at `~/.config/agentsw/config.json` (mode 0600). Concurrent stale
  saves are rejected instead of overwriting newer records; retry after the other writer finishes.
- Existing file permissions are preserved and new configuration files default to 0600.
- A busy write lock reports its owner PID/time. If a writer crashed, stop all agentsw
  writers and confirm the lock is abandoned before manually removing the reported
  `.write.lock` file; active or unknown locks are never automatically stolen.
- A sync overwrites only the fields agentsw owns. Unmodeled provider-level keys and per-model
  extras survive; an owned field that stops applying is cleared rather than left stale, and a
  per-model `api`/`baseUrl` override that contradicts the route is dropped (it would silently
  win over the entry) and reported.
- YAML configs (omp, Hermes, dsh) keep their comments. `~/.codex/config.toml` does not —
  TOML round-trip drops them, which is why the backup happens first.
- OpenAI endpoints come in two wires: `/v1/chat/completions` and `/v1/responses`. Imported
  providers keep whatever the config declared — on the provider or on its models — the
  interactive `add` asks, and `--openai-api responses` sets it by hand. A sync never
  downgrades an existing responses entry.
- Codex only speaks the Responses API; a chat-completions-only endpoint cannot be used with
  it, and the sync output says so.
- DeepSeek Harness keeps secrets out of `settings.yaml`: the route carries
  `apiKeyEnv: AGENTSW_<ID>_<DIGEST>_API_KEY`, the key goes into `$DSH_HOME/.credentials.yaml`
  (`refs:`, mode 0600). `$DSH_HOME` defaults to `~/.dsh`.
  The digest distinguishes IDs such as `foo-bar` and `foo_bar`; legacy generated references
  remain recognizable. External/custom references are not renamed or removed indiscriminately.
- cc-switch's database is opened read-only and never written to.
- The apps manager supports native Windows commands for Claude Code, Codex CLI, pi,
  opencode, Hermes, and DeepSeek Harness. Oh My Pi and prime-agent still need their own
  Windows installation method; WorkBuddy is installed and updated by its desktop app.
- `OPENCODE_CONFIG_DIR`, `WORKBUDDY_CONFIG_DIR`, `CODEBUDDY_CONFIG_DIR`, `HERMES_HOME`,
  and `DSH_HOME` can override native config locations.

## Language

The first interactive launch asks for English or 简体中文 and saves the choice; the menu can
change it later. A one-run override wins over the saved choice, and with neither the system
locale decides.

```bash
asw --lang zh-CN
AGENTSW_LANG=en asw
```

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm test            # node:test suite (filter semantics, adapter roundtrips)
npm run dev -- ...  # run from source via tsx
```

Each agent is one adapter in [`src/targets/`](./src/targets) implementing
`apply` / `prune` / `current` / `candidates`; read-only import sources live in
[`src/sources/`](./src/sources). To add an app, register it in
[`src/targets/index.ts`](./src/targets/index.ts), wrap its implementation with
`transactionalTarget()`, and add its schemas/references to `rename.ts` and `remove.ts`.
Use shared credential, YAML/JSONC, URL and model helpers; add apply/prune/import,
rename/removal, malformed-input, dry-run and account-isolation tests. If installable,
also add its platform commands to `apps.ts`. WorkBuddy local deletion uses the stable
account selector shown by `list --apps workbuddy`, not an ambiguous hostname alone.

## License

MIT

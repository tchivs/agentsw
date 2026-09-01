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
               backup: ~/.config/agentsw/backups/config.toml.2026-08-31T15-58-24-678Z
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
- **`--dry-run` prints diffs.** Review what a switch will write before it writes it, or pipe
  it into a code review. Every file is backed up first regardless.
- **Non-destructive by design.** Only the fields agentsw owns are rewritten. Provider-level
  keys it does not model — `authHeader`, `headers`, `compat`, `discovery` — per-model extras
  like `thinkingLevelMap`, and YAML comments all survive a re-sync.
- **Model metadata, not just an id list.** Reseller `/v1/models` endpoints return bare ids.
  agentsw enriches them from [models.dev](https://models.dev) and writes what each app
  actually reads: `thinkingLevelMap` for pi/prime, `limit`/`attachment` for opencode,
  `contextWindow`/`maxTokens` for omp, `reasoningEfforts`/`input` for dsh.
- **Adopts what you already have** — including [cc-switch](https://github.com/farion1231/cc-switch).
  `import` scans every installed agent *and* cc-switch's own store, merges duplicates
  (same protocol + base URL), and never writes back to either.
- **Wire-aware.** `/v1/chat/completions` and `/v1/responses` are different endpoints;
  agentsw tracks which one a provider speaks and never downgrades a working one.

Want a GUI, MCP/Skills sync, a usage dashboard or a local failover proxy? Use
[cc-switch](https://github.com/farion1231/cc-switch) — it is excellent at that, and agentsw
imports from it rather than competing with it.

## Install

```bash
npx agentsw               # zero install: opens the interactive menu
npm install -g agentsw    # requires Node >= 22.12
```

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

Without `--all` the list is a multi-select preview; nothing is written until you pick.

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
| `import [--all]` | adopt providers from your agents' configs and cc-switch |
| `list` / `status` | configured providers / what each agent points at |
| `use <id>` | switch every detected agent; `-a codex,omp`, `-m <model>`, `--dry-run` |
| `sync` | re-apply the active provider (after an agent update, say) |
| `discover <id> [--sync]` | refresh the model list + metadata from `/v1/models` |
| `models [query]` | search the models.dev catalog |
| `refresh` | re-fetch metadata for every configured provider |
| `prune <id>` / `remove <id> [--prune]` | remove from app configs / from the store |
| `apps` / `install <app>` / `upgrade` | agent version manager |

```bash
asw use myproxy -a codex,omp -m glm-5.2
asw discover myproxy --sync
asw remove myproxy --prune
```

## How your configs are treated

- Every modified file is backed up first to `~/.config/agentsw/backups/`.
- The provider store lives at `~/.config/agentsw/config.json` (mode 0600).
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
  `apiKeyEnv: AGENTSW_<ID>_API_KEY`, the key goes into `$DSH_HOME/.credentials.yaml`
  (`refs:`, mode 0600). `$DSH_HOME` defaults to `~/.dsh`.
- cc-switch's database is opened read-only and never written to.
- The apps manager (install/upgrade) currently targets macOS/Linux.

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
[`src/sources/`](./src/sources). Adding an app is one file plus a line in
[`src/targets/index.ts`](./src/targets/index.ts).

## License

MIT

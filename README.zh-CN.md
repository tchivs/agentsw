<div align="center">

# agentsw

**一个供应商，管遍所有编码智能体——在终端里。**

一个命令行工具：把 OpenAI 协议 / Anthropic 协议的供应商——base URL、密钥、模型列表、
元数据——集中管理，再把当前选中的那个写进九个智能体各自的配置文件，
且不动你手工调过的设置。

[![npm version](https://img.shields.io/npm/v/agentsw?logo=npm&logoColor=white)](https://www.npmjs.com/package/agentsw)
[![CI](https://img.shields.io/github/actions/workflow/status/tchivs/agentsw/ci.yml?branch=main&logo=github&logoColor=white&label=CI)](https://github.com/tchivs/agentsw/actions/workflows/ci.yml)
[![node version](https://img.shields.io/node/v/agentsw?logo=nodedotjs&logoColor=white)](#安装)
[![license](https://img.shields.io/npm/l/agentsw?color=blue)](./LICENSE)

[安装](#安装) · [快速开始](#快速开始) · [支持的应用](#支持的应用) · [命令](#命令) · [English](./README.md)

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

`agentsw` 和短名 `asw` 是同一个可执行文件。

## 为什么是 CLI

- **它能去桌面应用去不了的地方。** 无头服务器、容器、devcontainer、CI。
  `npx agentsw use myproxy -a codex,omp` 在开机脚本里是一行；GUI 点九次不是。
- **`--dry-run` 直接打 diff。** 写盘前先看清楚要改什么，或者把 diff 丢进 code review。
  无论如何每个文件都会先备份。
- **默认不破坏现有配置。** 只覆盖 agentsw 自己管理的字段：它不建模的供应商级键
  （`authHeader`、`headers`、`compat`、`discovery`）、`thinkingLevelMap` 之类的模型级字段、
  以及 YAML 注释，都会在重新同步后原样保留。
- **写的是元数据，不只是模型 id。** 转售商 `/v1/models` 只返回裸 id；agentsw 从
  [models.dev](https://models.dev) 补全，并按各应用真正读取的字段下发：pi/prime 的
  `thinkingLevelMap`、opencode 的 `limit`/`attachment`、omp 的 `contextWindow`/`maxTokens`、
  dsh 的 `reasoningEfforts`/`input`。
- **接管你已有的配置——包括 [cc-switch](https://github.com/farion1231/cc-switch)。**
  `import` 会扫描所有已安装的智能体**以及 cc-switch 自己的存储**，合并重复项
  （相同协议 + base URL），并且对两者都只读不写。
- **区分接口形态。** `/v1/chat/completions` 与 `/v1/responses` 是两个不同端点；
  agentsw 记录供应商说的是哪一种，并且绝不把可用的 responses 降级。

想要 GUI、MCP/Skills 同步、用量仪表盘或本地故障转移代理？用
[cc-switch](https://github.com/farion1231/cc-switch)——那些它做得很好；agentsw 从它导入，
而不是跟它抢。

## 安装

```bash
npx agentsw               # 免安装，直接打开交互菜单
npm install -g agentsw    # 需要 Node >= 22.12
```

供应商同步与配置管理支持 Linux、macOS 和 Windows。Windows 下 agentsw 自身状态默认存放在
`%APPDATA%\agentsw`，需要原生应用数据目录的智能体会使用对应目录。通过 Git Bash/WSL 运行，
或需要可移植目录时，可以设置 `AGENTSW_HOME`。

## 快速开始

```bash
agentsw                   # 不带参数：交互菜单（添加、导入、切换、状态、应用管理）
```

存储为空时，首次运行会询问是否导入各智能体里已配置的供应商，并让你选择
English 或简体中文。想用参数跑？同样的流程，全自动：

```bash
# 添加供应商，并让它自己发现模型列表
asw add -y --id vfing --protocol openai --openai-api responses \
  --base-url https://api.example.com/v1 --api-key sk-... --discover

asw use vfing             # 把所有检测到的智能体指向它
asw use vfing --dry-run   # ……或者只看 diff
asw status                # 各智能体当前指向什么
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

## 支持的应用

| 应用 | 写入的配置 | 协议 |
|---|---|---|
| [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) | `~/.claude/settings.json` env 块 | anthropic |
| [Codex CLI](https://www.npmjs.com/package/@openai/codex) | `~/.codex/config.toml` + `auth.json`（仅 Responses API） | openai |
| [Oh My Pi](https://omp.sh) (omp) | `~/.omp/agent/models.yml`（保留注释） | 双协议 |
| [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | `~/.pi/agent/models.json` + `settings.json` | 双协议 |
| [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | `~/.prime/agent/models.json` + `settings.json` | 双协议 |
| [opencode](https://opencode.ai) | `~/.config/opencode/opencode.json` | 双协议 |
| [Hermes](https://pypi.org/project/hermes-agent/) | `~/.hermes/config.yaml` + `.env`（保留注释） | 双协议 |
| WorkBuddy | `~/.workbuddy/models.json` + `settings.json` | openai |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) | `~/.dsh/settings.yaml` + `.credentials.yaml` | 双协议 |

未安装的应用会被跳过，而不是瞎猜。`--apps codex,omp` 只跑指定应用；
对未检测到的应用显式传 `--apps` 可强制写入。

## 导入你已有的配置

`import` 读取每个智能体的配置**以及 cc-switch 的 SQLite 存储**（只读），解析内联或环境变量
形式的密钥，并把「协议 + base URL」相同的候选合并——模型列表与来源应用取并集。
同一域名下的不同协议不会误合并。

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

不加 `--all` 时先展示多选预览，选定之前不写任何文件。

## 模型发现过滤

`--discover` 从供应商 `/v1/models` 拉取模型 id，再从 models.dev 补全元数据。
转售商列表噪音大，过滤规则持久化在供应商上，每次 `discover` 自动复用：

```bash
# 快照重复项（gpt-5.2-latest、glm-4.7-250414 等）默认丢弃——
# 仅当裸名也在列表中才算重复；只有快照没有裸名的模型原样保留
asw add -y --discover --exclude "*embedding*,*video*" --id myproxy ...
asw add -y --discover --no-dedup ...            # 保留重复项
asw discover myproxy --include "gpt-*,glm-*"    # 更新持久化过滤规则
asw discover myproxy --no-filter                # 清除规则
```

手动 `--models` 指定的 id 和默认模型永不被过滤。

## 命令

| 命令 | 作用 |
|---|---|
| `agentsw` | 交互菜单（不带参数） |
| `add` | 添加或更新供应商；`--discover` 自动填模型列表 |
| `import [--all]` | 接管各智能体配置与 cc-switch 里已有的供应商 |
| `list` / `status` | 已配置的供应商 / 各智能体当前指向 |
| `use <id>` | 切换所有检测到的智能体；`-a codex,omp`、`-m <model>`、`--dry-run` |
| `sync` | 重新应用当前供应商（比如某个智能体升级之后） |
| `discover <id> [--sync]` | 从 `/v1/models` 刷新模型列表与元数据 |
| `models [query]` | 搜索 models.dev 目录 |
| `refresh` | 重新拉取所有供应商的元数据 |
| `prune <id>` / `remove <id> [--prune]` | 从各应用配置中清除 / 从存储中删除 |
| `apps` / `install <app>` / `upgrade` | 智能体版本管理 |

```bash
asw use myproxy -a codex,omp -m glm-5.2
asw discover myproxy --sync
asw remove myproxy --prune
```

## 它如何对待你的配置

- 每个被修改的文件先备份到 `~/.config/agentsw/backups/`。
- 供应商存储位于 `~/.config/agentsw/config.json`（权限 0600）。
- 同步只覆盖 agentsw 自己管理的字段：未建模的供应商级键与模型级扩展字段保留；
  自己管理但本次不再写出的字段会被清除而非留成陈旧值；与新路由矛盾的模型级
  `api`/`baseUrl` 覆盖会被删除（否则它会静默盖过供应商条目）并在输出中点名。
- YAML 配置（omp、Hermes、dsh）保留注释；`~/.codex/config.toml` 不行——TOML 往返会丢注释，
  所以才先备份。
- OpenAI 端点有两种接口形态：`/v1/chat/completions` 与 `/v1/responses`。导入时沿用配置里
  声明的形态（供应商级或模型级），交互式 `add` 会询问，也可用 `--openai-api responses`
  手动指定；同步绝不把已有的 responses 端点降级。
- Codex 只支持 Responses API；仅提供 chat-completions 的端点无法用于 Codex，同步输出会提示。
- DeepSeek Harness 不把密钥写进 `settings.yaml`：路由里只保存
  `apiKeyEnv: AGENTSW_<ID>_API_KEY` 引用，密钥写入 `$DSH_HOME/.credentials.yaml`
  的 `refs:`（权限 0600）。`$DSH_HOME` 默认为 `~/.dsh`。
- cc-switch 的数据库以只读方式打开，永不写入。
- 安装管理器在 Windows 下为 Claude Code、Codex CLI、pi、opencode、Hermes 和 DeepSeek Harness
  使用原生安装命令。Oh My Pi 与 prime-agent 仍需使用各自的 Windows 安装方式；WorkBuddy
  由桌面应用自行安装和更新。
- `OPENCODE_CONFIG_DIR`、`WORKBUDDY_CONFIG_DIR`、`CODEBUDDY_CONFIG_DIR`、`HERMES_HOME` 与
  `DSH_HOME` 可覆盖原生配置目录。

## 语言

首次打开交互菜单会选择 English 或简体中文并持久化，之后可在菜单中切换。
单次覆盖优先于已保存设置；两者都没有时按系统语言判断。

```bash
asw --lang zh-CN
AGENTSW_LANG=en asw
```

## 开发

```bash
npm install
npm run build       # tsc -> dist/
npm test            # node:test 测试（过滤语义、适配器往返）
npm run dev -- ...  # 通过 tsx 从源码运行
```

每个智能体是 [`src/targets/`](./src/targets) 下的一个适配器，实现
`apply` / `prune` / `current` / `candidates`；只读的导入来源放在
[`src/sources/`](./src/sources)。新增一个应用 = 一个文件 +
[`src/targets/index.ts`](./src/targets/index.ts) 里的一行。

## 许可证

MIT

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
               backup: ~/.config/agentsw/backups/transaction-<unique>
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
- **`--dry-run` 输出脱敏 diff。** 写盘前先预览；预览不写文件、不创建备份。
  正式提交变更时，已有配置文件才会先备份。
- **默认不破坏现有配置。** 只覆盖 agentsw 自己管理的字段：它不建模的供应商级键
  （`authHeader`、`headers`、`compat`、`discovery`）、`thinkingLevelMap` 之类的模型级字段、
  以及 YAML 注释，都会在重新同步后原样保留。
- **写的是元数据，不只是模型 id。** 转售商 `/v1/models` 只返回裸 id；agentsw 从
  [models.dev](https://models.dev) 优先补全，并在有实际缺口时自动查询 AI Gateway，按各应用真正读取的字段下发：pi/prime 的
  `thinkingLevelMap`、opencode 的 `limit`/`attachment`、omp 的 `contextWindow`/`maxTokens`、
  dsh 的 `reasoningEfforts`/`input`。
- **接管你已有的配置——包括 [cc-switch](https://github.com/farion1231/cc-switch)。**
  `import` 会扫描所有已安装的智能体**以及 cc-switch 自己的存储**，合并重复项
  （相同协议 + 归一化端点 + 凭据），并且对两者都只读不写。
- **区分接口形态。** `/v1/chat/completions` 与 `/v1/responses` 是两个不同端点；
  agentsw 记录供应商说的是哪一种，并且绝不把可用的 responses 降级。

想要 GUI、MCP/Skills 同步、用量仪表盘或本地故障转移代理？用
[cc-switch](https://github.com/farion1231/cc-switch)——那些它做得很好；agentsw 从它导入，
而不是跟它抢。

## 安装

```bash
npx agentsw               # 免安装，直接打开交互菜单
npm install -g agentsw    # 需要 Node >= 22.13，内置 SQLite 无需额外启动参数
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

在交互终端中，不加 `--all` 会先展示多选预览，选定后才保存供应商记录。
使用 `--all` 或非交互输入时会导入全部符合条件的新条目；脚本中建议明确写 `--all`。
模型发现过程中可能更新本地元数据缓存。

## 模型发现过滤

`--discover` 从供应商 `/v1/models` 拉取模型 id，优先从 models.dev 补全元数据，必要时自动查询 AI Gateway。
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

## 自动补全模型元数据

**默认无需额外参数。** 新供应商和未保存模式的供应商使用 `auto`：先查询 models.dev，
仅在核心参数（上下文窗口、最大输出、推理或图片输入能力）仍缺失、已有 Gateway 自动字段
未被手动修改或 models.dev 替代而需刷新，或需核实旧自动值的身份冲突时，才查询公开的
[AI Gateway 模型目录](https://vercel.com/docs/ai-gateway/models-and-providers#dynamic-model-discovery)。
仅缺名称、价格、可选输入上限或推理等级列表，不会触发 Gateway 查询。
直接请求 `https://ai-gateway.vercel.sh/v1/models`，不携带供应商密钥，也不安装 AI SDK。

```bash
# 按保存的模式刷新已有模型参数（未设置时为 auto）
# 不发现新模型、不写智能体配置
asw refresh --provider myproxy

# 查看生效模式、字段来源、冲突和参考价格；JSON 不含 API key
asw models --provider myproxy --metadata

# 自定义或有歧义的名称需显式映射；实际调用的模型 ID 不变
asw refresh --provider myproxy --metadata-mode auto \
  --gateway-models '{"my-model":"openai/gpt-5.4"}'

# 即使核心参数完整，也始终查询 Gateway
asw refresh --provider myproxy --metadata-mode on

# 停止后续 Gateway 获取；保留已保存的参数
asw refresh --provider myproxy --metadata-mode off

# 将显式关闭的供应商恢复为自动模式
asw refresh --provider myproxy --metadata-mode auto

# 单独预览、同步；sync 不查询目录
asw sync --provider myproxy --dry-run
asw sync --provider myproxy
```

交互菜单的“设置并刷新模型参数补充源”提供“自动按需（推荐）”“始终补充”“关闭”，
默认选中该供应商当前模式；添加供应商时不增加提问。
`add`、`quick`、`discover`、`import`、`refresh` 均支持 `--metadata-mode <auto|on|off>`。
原有 `--gateway-metadata` / `--no-gateway-metadata` 仍分别表示显式 `on` / `off`。
省略参数会保留已保存的设置：已有 `false` 仍保持关闭，直到主动选择 `auto` 或 `on`。
无效模式或相互冲突的模式/布尔开关，会在查询或保存之前报错。
`refresh` 不传 `--provider` 会作用于全部供应商，包括更新传入的模式。
`--gateway-models` 替换整个映射，传 `{}` 清空；映射不会更改保存的模式，也不会覆盖 `off`。
导入仍跳过已经配置的账号。

- **按字段合并：** 用户手动值优先，其次 models.dev，最后 Gateway 补缺。已记录来源的自动值可以刷新，
  手动修改后会保留；旧版本中没有来源记录的已有值保守视为手动值，不强制覆盖。未知扩展字段也保留。
- **精确匹配：** 不含 `/` 的裸 ID 可按大小写精确匹配唯一的 Gateway `creator/model` 身份，
  前提是 models.dev 没有身份线索或线索一致。任一目录中的创建者身份有歧义时拒绝自动匹配；
  自定义或有歧义的名称仍需显式映射。带命名空间的 ID 不会剥离前缀，不按子串、大小写折叠或版本相似度猜测。
  `auto` / `on` 模式下 models.dev 也采用保守的精确匹配；`off` 保留原有 models.dev 查询行为。
  匹配失败不妨碍模型继续使用。修改/删除映射时，只清理确认已失效身份的自动值，保留手动修改。
- **不改变调用语义：** 目录不会给供应商增加模型，不改模型 ID、协议、URL、默认模型或账户；
  Gateway 能力是参考规格，不保证转售商实际实现。`supported_specifications` 不是 URL 版本。
- **价格仅供参考：** Gateway 价格转换为美元/百万 token，单独保存在 `metadata.gateway.referenceCost`，
  不写入供应商的有效 `cost`，也不下发为智能体计费价格；分档/供应商差异另有标记。
  自动模式不会仅为刷新参考价格而查询：可查看 `metadata.gateway.fetchedAt` 判断快照时间，
  需要重新查询参考价格时使用 `refresh --provider <id> --metadata-mode on`。
- **可追溯、可降级：** `metadata.fields` 记录来源、原值快照和时间，`metadata.conflicts` 记录保留值与冲突。
  审计信息仅保存在 agentsw，不写入智能体运行配置。Gateway 目录独立缓存 24 小时；请求失败可使用旧缓存，无缓存时只跳过补充。
- **自动查询不等于自动同步：** 添加、快速添加、发现、导入、刷新时补全保存的元数据，并不新增自动推送。
  同步行为不变：普通 `sync` 仅写入已保存的设置，既不获取模型列表，也不请求元数据目录。

## 命令

| 命令 | 作用 |
|---|---|
| `agentsw` | 交互菜单（不带参数） |
| `add` | 添加或更新供应商；`--discover` 自动填模型列表 |
| `quick` | 只需 URL + API key，自动探测协议与模型，按完整域名 + 协议命名 |
| `import [--all]` | 接管各智能体配置与 cc-switch 里已有的供应商 |
| `list` / `status` | 已配置的供应商 / 各智能体当前指向 |
| `list --apps omp,prime` | 列出智能体本地供应商 ID，包括未导入 agentsw 的条目 |
| `rename <id> <new-id>` | 备份并迁移 ID 和配置引用，支持 `--dry-run` |
| `use <id>` | 切换所有检测到的智能体；`-a codex,omp`、`-m <model>`、`--dry-run` |
| `sync` | 重新应用当前供应商（比如某个智能体升级之后） |
| `discover <id> [--sync]` | 从 `/v1/models` 刷新模型列表与元数据 |
| `models [query]` | 搜索 models.dev 目录 |
| `refresh [--provider <id>]` | 刷新已有模型参数，可设置 Gateway 补充源，不改变模型列表 |
| `models --provider <id> --metadata` | 以 JSON 查看字段来源、冲突和参考价格 |
| `prune <id>` / `remove <id> [--prune]` | 从各应用配置中清除 / 从存储中删除 |
| `remove <id> --apps omp` | 仅删除指定智能体内的条目，支持 `--dry-run` |
| `apps` / `install <app>` / `upgrade` | 智能体版本管理 |

```bash
asw use myproxy -a codex,omp -m glm-5.2
asw discover myproxy --sync
asw remove myproxy --prune
```

新建供应商的自动 ID 使用完整域名和协议，例如 `api-example-com-openai`。
显式指定的 `--id` 会保留，同步不会自动重命名。导入去重会同时比较端点、协议和凭据，
不同账号保持独立；同一账号的自定义名称优先于自动生成名称。

```bash
asw rename myproxy api-example-com-openai --dry-run
asw rename myproxy api-example-com-openai
asw list --apps omp
asw remove unused-provider --apps omp --dry-run
asw remove unused-provider --apps omp
```

单独 `remove` 只删除 agentsw 中央条目；`--prune` 还会清理匹配的智能体配置。
`--apps` 则仅作用于指定智能体，也能删除从未导入 agentsw 的供应商，请勿和 `--prune` 同用。
重命名和删除会先检查全部计划变更，再创建私有备份并写入。
仅从智能体删除时中央条目仍保留，之后主动同步该供应商会重新写入该智能体。

## 它如何对待你的配置

- 正式提交变更前，已有中央存储和智能体配置先备份到
  `~/.config/agentsw/backups/transaction-*`。新文件没有旧副本；缓存刷新不属于配置备份。
  预览不写文件，也不创建备份。
- 每个适配器先准备全部文件再提交，写入失败时尝试回滚。多智能体同步不是全局文件系统事务：
  某个智能体失败时，其他成功项仍保留，并通过非零退出码报告失败。
- 供应商存储位于 `~/.config/agentsw/config.json`（权限 0600）。并发写入导致快照过期时，
  拒绝覆盖新记录；等待其他写入完成后重试。
- 保留已有文件权限，新建配置文件默认使用 0600。
- 写锁占用时会显示持有者 PID 和时间。若进程曾异常退出，先停止所有 agentsw 写入并确认
  锁已遗留，再手动删除报错中指定的 `.write.lock` 后重试；不会自动抢占活动或状态不明的锁。
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
  `apiKeyEnv: AGENTSW_<ID>_<DIGEST>_API_KEY` 引用，密钥写入 `$DSH_HOME/.credentials.yaml`
  的 `refs:`（权限 0600）。`$DSH_HOME` 默认为 `~/.dsh`。
  摘要用于区分 `foo-bar` 和 `foo_bar` 等 ID；旧版生成引用仍可识别，不随意修改外部或自定义引用。
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
[`src/sources/`](./src/sources)。新增应用时，在
[`src/targets/index.ts`](./src/targets/index.ts) 注册，用 `transactionalTarget()` 包装适配器，
并为 `rename.ts`、`remove.ts` 补充对应配置结构与引用处理。
复用共享凭据、YAML/JSONC、URL 和模型工具，补齐同步、清理、导入、重命名、删除、
异常输入、预览及账户隔离测试；支持安装的应用还需在 `apps.ts` 中注册平台命令。
删除 WorkBuddy 本地账户时，使用 `list --apps workbuddy` 显示的稳定账户标识，避免同域名歧义。

## 许可证

MIT

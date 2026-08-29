# smart-switch

[English](./README.md) | [简体中文]

多应用模型供应商切换器。在一处管理 OpenAI 协议 / Anthropic 协议的供应商
(base URL + API key + 模型列表),一键同步到各编码智能体的配置文件——
类似 cc-switch,但同时适配八个应用。

| 应用 | 写入的配置 | 协议 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` env 块 | anthropic |
| Codex CLI | `~/.codex/config.toml` + `auth.json`(仅 Responses API) | openai |
| Oh My Pi (omp) | `~/.omp/agent/models.yml`(保留注释) | 双协议 |
| pi | `~/.pi/agent/models.json` + `settings.json` | 双协议 |
| prime-agent | `~/.prime/agent/models.json` + `settings.json` | 双协议 |
| opencode | `~/.config/opencode/opencode.json` | 双协议 |
| Hermes | `~/.hermes/config.yaml` + `.env`(保留注释) | 双协议 |
| WorkBuddy | `~/.workbuddy/models.json` + `settings.json` | openai |

模型元数据(上下文窗口、输入/输出上限、思考等级、多模态、价格)从
[models.dev](https://models.dev) 拉取并下发到各应用配置(pi/prime 的
`thinkingLevelMap`、opencode 的 `limit`/`attachment`、omp 的
`contextWindow`/`maxTokens` 等)。第三方转售商的 `/v1/models` 接口不带这些
元数据,本工具补上这个缺口。

## 安装

```bash
npm install -g smart-switch   # 需要 Node >= 22.12
```

## 快速开始

```bash
# 添加供应商:交互式,或全参数 + 自动发现模型
smart-switch add
smart-switch add -y --id myproxy --protocol openai \
  --base-url https://api.example.com/v1 --api-key sk-... --discover

smart-switch use myproxy            # 切换所有检测到的应用
smart-switch status                 # 查看各应用当前指向
```

## 命令

```bash
smart-switch list                   # 已配置的供应商
smart-switch use myproxy -a codex,omp -m glm-5.2
smart-switch use myproxy --dry-run  # 预览配置 diff,不写盘
smart-switch sync                   # 重新应用当前供应商

smart-switch discover myproxy --sync    # 刷新模型列表 + 元数据并推送
smart-switch models "glm-5.2"           # 搜索 models.dev 目录
smart-switch refresh                    # 重拉所有供应商的元数据

smart-switch prune myproxy          # 从各应用配置中清除该供应商
smart-switch remove myproxy --prune

# 智能体安装管理(对标 cc-switch 的「本地环境检查」)
smart-switch apps                   # 各应用已装版本 vs 最新版本
smart-switch install pi
smart-switch upgrade                # 升级所有过期应用
```

## 模型发现过滤

`--discover` 从供应商 `/v1/models` 拉取模型 id,再从 models.dev 补全元数据。
转售商列表噪音大;过滤规则持久化在供应商上,每次 `discover` 自动复用:

```bash
# 快照重复项(gpt-5.2-latest、glm-4.7-250414 等)默认丢弃——
# 仅当裸名也在列表中才算重复;只有快照没有裸名的模型原样保留
smart-switch add -y --discover --exclude "*embedding*,*video*" --id myproxy ...
smart-switch add -y --discover --no-dedup ...            # 保留重复项
smart-switch discover myproxy --include "gpt-*,glm-*"    # 更新持久化过滤规则
smart-switch discover myproxy --no-filter                # 清除规则
```

手动 `--models` 指定的 id 和默认模型永不被过滤。

## 注意事项

- 每个被修改的配置文件先备份到 `~/.config/smart-switch/backups/`。
- 供应商存储位于 `~/.config/smart-switch/config.json`(权限 0600)。
- Codex 只支持 OpenAI Responses API;仅提供 chat-completions 的端点无法用于
  Codex(同步时会输出提示)。
- `~/.codex/config.toml` 的注释无法保留(TOML 往返);YAML 配置(omp、hermes)
  保留注释。
- 安装管理器(install/upgrade)目前仅支持 macOS/Linux。

## 开发

```bash
npm install
npm run build       # tsc -> dist/
npm test            # node:test 测试(过滤语义、适配器往返)
npm run dev -- ...  # 通过 tsx 从源码运行
```

## 许可证

MIT

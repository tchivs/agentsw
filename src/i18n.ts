import type { Locale } from "./types.js";

const messages = {
  "root.description": {
    en: "Manage OpenAI/Anthropic-protocol model providers and sync them into coding agents\n(Claude Code, Codex, omp, pi, prime-agent, opencode, Hermes, WorkBuddy, DeepSeek Harness).\nModel metadata (context window, input/output limits, reasoning levels) is enriched from\nmodels.dev first, with automatic AI Gateway supplementation when needed.\nExisting providers can be imported from the agents and from cc-switch.\n\nRun without arguments (or via `npx agentsw`) for the interactive menu.",
    "zh-CN": "管理 OpenAI / Anthropic 协议的模型供应商并同步到编码智能体\n(Claude Code、Codex、omp、pi、prime-agent、opencode、Hermes、WorkBuddy、DeepSeek Harness)。\n模型元数据(上下文、输入/输出上限、推理等级)优先由 models.dev 补全，必要时自动查询 AI Gateway；\n也可从各智能体与 cc-switch 导入已有供应商。\n\n不带参数运行(或 `npx agentsw`)即可打开交互菜单。",
  },
  "help.language": { en: "UI language: en | zh-CN (also AGENTSW_LANG)", "zh-CN": "界面语言: en | zh-CN (也可用 AGENTSW_LANG)" },
  "error.language": { en: "unsupported language \"{value}\"; use en or zh-CN", "zh-CN": "不支持语言 \"{value}\";请使用 en 或 zh-CN" },
  "error.unknownCommand": { en: "unknown command '{value}', see --help", "zh-CN": "未知命令 '{value}',请查看 --help" },
  "error.limit": { en: "--limit must be a positive integer", "zh-CN": "--limit 必须是正整数" },

  "cmd.add": { en: "add or update a provider (interactive when flags are omitted)", "zh-CN": "添加或更新供应商(省略参数时进入交互流程)" },
  "cmd.quick": { en: "quick add — auto-detect protocol(s) and models from just base URL + API key", "zh-CN": "快速添加 — 只需 base URL + API key,自动探测协议和模型" },
  "cmd.list": { en: "list configured providers (or agent-local entries with --apps)", "zh-CN": "列出已配置供应商（--apps 可查看智能体独有配置）" },
  "cmd.remove": { en: "remove a store provider, or only agent-local entries with --apps", "zh-CN": "删除中央供应商，或用 --apps 仅删除指定智能体的供应商" },
  "cmd.prune": { en: "remove a provider's entries from app configs (keeps it in agentsw)", "zh-CN": "从应用配置移除供应商条目(仍保留在 agentsw)" },
  "cmd.rename": { en: "rename a provider and migrate config references with backups", "zh-CN": "重命名供应商并迁移配置引用（自动备份）" },
  "cmd.use": { en: "set the active provider and write it into app configs", "zh-CN": "设为当前供应商并写入应用配置" },
  "cmd.sync": { en: "re-apply the active provider (or --provider) to app configs", "zh-CN": "将当前供应商(或 --provider)重新应用到应用配置" },
  "cmd.status": { en: "show detected apps and what they currently point at", "zh-CN": "显示检测到的应用及当前供应商" },
  "cmd.models": { en: "search models.dev, or show a configured provider's models", "zh-CN": "搜索 models.dev 或显示已配置供应商的模型" },
  "cmd.discover": { en: "refresh a provider's model list and configured metadata sources", "zh-CN": "获取供应商模型列表，并通过已启用的目录补全参数" },
  "cmd.import": { en: "scan app configs, preview and dedupe existing custom providers, then import", "zh-CN": "扫描应用配置,预览并去重已有自定义供应商后导入" },
  "cmd.apps": { en: "check installed agents: current version vs latest", "zh-CN": "检查智能体已安装版本与最新版本" },
  "cmd.install": { en: "install an agent CLI", "zh-CN": "安装智能体 CLI" },
  "cmd.upgrade": { en: "upgrade agent CLIs (no args = everything outdated)", "zh-CN": "升级智能体 CLI(无参数时升级全部过期项)" },
  "cmd.refresh": { en: "refresh metadata for saved models; optionally configure Gateway supplementation", "zh-CN": "刷新已有模型参数，可设置 Gateway 补充源（不改变模型列表）" },

  "opt.id": { en: "custom provider id (default: full hostname + protocol)", "zh-CN": "自定义供应商 ID（默认：完整域名 + 协议）" },
  "opt.name": { en: "display name", "zh-CN": "显示名称" },
  "opt.protocol": { en: "wire protocol: openai | anthropic", "zh-CN": "接口协议: openai | anthropic" },
  "opt.openaiApi": {
    en: "openai endpoint flavor: completions | responses (default: completions)",
    "zh-CN": "openai 接口形态: completions | responses(默认 completions)",
  },
  "opt.baseUrl": { en: "API base URL", "zh-CN": "API base URL" },
  "opt.apiKey": { en: "API key", "zh-CN": "API key" },
  "opt.models": { en: "comma-separated model ids", "zh-CN": "逗号分隔的模型 id" },
  "opt.defaultModel": { en: "default model (defaults to first)", "zh-CN": "默认模型(默认取第一个)" },
  "opt.smallModel": { en: "small/fast model (Claude Code haiku slot)", "zh-CN": "小型/快速模型(Claude Code haiku 槽位)" },
  "opt.reasoning": { en: "preferred reasoning effort (codex): minimal|low|medium|high", "zh-CN": "Codex 首选推理等级: minimal|low|medium|high" },
  "opt.discover": { en: "list model ids from the provider's /v1/models", "zh-CN": "从供应商 /v1/models 获取模型 id" },
  "opt.include": { en: "keep only models matching comma-separated globs", "zh-CN": "仅保留匹配逗号分隔 glob 的模型" },
  "opt.exclude": { en: "drop models matching comma-separated globs", "zh-CN": "排除匹配逗号分隔 glob 的模型" },
  "opt.dedup": { en: "deduplicate model snapshot aliases", "zh-CN": "合并重复的模型快照别名" },
  "opt.noDedup": { en: "keep snapshot duplicates (-latest/date suffixes)", "zh-CN": "保留快照重复项(-latest/日期后缀)" },
  "opt.modelsDev": { en: "models.dev provider id for metadata matching", "zh-CN": "用于元数据匹配的 models.dev 供应商 id" },
  "opt.metadataMode": { en: "save Gateway mode: auto (default, only when needed), on, or off; omission keeps saved mode", "zh-CN": "保存 Gateway 模式：auto（默认，按需补缺）、on 或 off；省略则沿用已保存模式" },
  "opt.gatewayMetadata": { en: "always supplement from AI Gateway (same as --metadata-mode on)", "zh-CN": "始终使用 AI Gateway 补缺（等同 --metadata-mode on）" },
  "opt.noGatewayMetadata": { en: "disable Gateway fetching; keep saved parameters (same as --metadata-mode off)", "zh-CN": "关闭 Gateway 获取，保留已保存参数（等同 --metadata-mode off）" },
  "opt.gatewayModels": { en: 'replace exact aliases as JSON: {"local-id":"creator/model"}; {} clears them', "zh-CN": '用 JSON 替换精确映射：{"本地模型ID":"creator/model"}；{} 清空' },
  "opt.metadataDetails": { en: "show field sources, conflicts and Gateway reference pricing as JSON (requires --provider)", "zh-CN": "以 JSON 查看字段来源、冲突和 Gateway 参考价格（需 --provider）" },
  "opt.refreshProvider": { en: "refresh/configure only this saved provider (default: all)", "zh-CN": "仅刷新和设置该供应商（默认全部）" },
  "opt.yes": { en: "non-interactive; require all flags", "zh-CN": "非交互模式;要求提供全部参数" },
  "opt.prune": { en: "also remove entries from app configs", "zh-CN": "同时从应用配置中移除条目" },
  "opt.apps": { en: "comma-separated apps or 'all'", "zh-CN": "逗号分隔的应用或 'all'" },
  "opt.removeApps": { en: "delete only from these apps; keep the agentsw store and other apps unchanged", "zh-CN": "仅从这些智能体删除，保留 agentsw 中央配置和其他智能体配置" },
  "opt.manageDryRun": { en: "preview affected paths without changing files or creating backups", "zh-CN": "仅预览受影响路径，不修改文件或创建备份" },
  "opt.appsDetailed": { en: "comma-separated apps (claude,codex,omp,pi,prime,opencode,hermes,workbuddy,dsh) or 'all'", "zh-CN": "逗号分隔的应用(claude,codex,omp,pi,prime,opencode,hermes,workbuddy,dsh)或 'all'" },
  "opt.model": { en: "override default model while switching", "zh-CN": "切换时覆盖默认模型" },
  "opt.dryRun": { en: "preview config diff without writing", "zh-CN": "仅预览配置差异,不写入" },
  "opt.provider": { en: "sync this provider instead of the active one", "zh-CN": "同步指定供应商而非当前供应商" },
  "opt.showProvider": { en: "show models of a configured provider", "zh-CN": "显示已配置供应商的模型" },
  "opt.refresh": { en: "force-refresh models.dev cache", "zh-CN": "强制刷新 models.dev 缓存" },
  "opt.limit": { en: "maximum results", "zh-CN": "最大结果数" },
  "opt.syncAfter": { en: "push refreshed provider into app configs", "zh-CN": "刷新后推送到应用配置" },
  "opt.appsSync": { en: "apps to sync when --sync is set", "zh-CN": "--sync 时要同步的应用" },
  "opt.setInclude": { en: "set and persist include globs", "zh-CN": "设置并持久化 include glob" },
  "opt.setExclude": { en: "set and persist exclude globs", "zh-CN": "设置并持久化 exclude glob" },
  "opt.noFilter": { en: "clear persisted discovery filter", "zh-CN": "清除持久化的发现过滤器" },
  "opt.all": { en: "import every new provider without selection", "zh-CN": "跳过多选,导入全部新供应商" },

  "language.prompt": { en: "Language / 语言", "zh-CN": "语言 / Language" },
  "language.saved": { en: "language saved: English", "zh-CN": "语言已保存:简体中文" },
  "menu.selectInstructions": { en: "↑/↓ move · Enter select", "zh-CN": "↑/↓ 移动 · Enter 选择" },
  "import.multiInstructions": { en: "↑/↓ move · Space toggle · Enter confirm", "zh-CN": "↑/↓ 移动 · 空格切换 · Enter 确认" },
  "menu.title": { en: " · interactive menu — Ctrl+C quits, ↑/↓ selects", "zh-CN": " · 交互菜单 — Ctrl+C 退出,↑/↓ 选择" },
  "menu.noProviders": { en: "no providers saved in agentsw yet", "zh-CN": "agentsw 中尚未保存供应商" },
  "menu.noProvidersHint": { en: "no providers saved in agentsw — choose Add provider or Import existing providers first", "zh-CN": "agentsw 中尚未保存供应商，请先选择“添加供应商”或“导入已有供应商”" },
  "menu.firstScan": { en: "import providers from existing agent configs into agentsw?", "zh-CN": "是否从已有智能体配置中导入供应商到 agentsw？" },
  "menu.what": { en: "what to do?", "zh-CN": "请选择操作" },
  "menu.add": { en: "Add / update provider (manual setup)", "zh-CN": "添加或更新供应商（手动设置）" },
  "menu.import": { en: "Import existing providers", "zh-CN": "导入已有供应商" },
  "menu.use": { en: "Switch provider and default model", "zh-CN": "切换供应商和默认模型" },
  "menu.status": { en: "View each agent's current configuration", "zh-CN": "查看各智能体当前配置" },
  "menu.list": { en: "View providers saved in agentsw", "zh-CN": "查看 agentsw 供应商列表" },
  "menu.sync": { en: "Re-sync the current provider to agents", "zh-CN": "重新同步当前供应商" },
  "menu.discover": { en: "Update a provider's model list", "zh-CN": "更新供应商模型列表" },
  "menu.metadata": { en: "Configure and refresh model metadata", "zh-CN": "设置并刷新模型参数补充源" },
  "menu.metadataHelp": { en: "Keep the model list; choose automatic, always-on or disabled AI Gateway lookup, then refresh saved parameters only.", "zh-CN": "保留模型列表，选择 AI Gateway 自动按需、始终补充或关闭，仅刷新保存的参数。" },
  "menu.metadataProvider": { en: "which provider's metadata settings should be updated?", "zh-CN": "选择要设置模型参数补充源的供应商" },
  "menu.metadataMode": { en: "AI Gateway lookup mode (no API key is sent)", "zh-CN": "AI Gateway 查询模式（请求不携带 API key）" },
  "menu.metadataAuto": { en: "Automatic (recommended)", "zh-CN": "自动按需（推荐）" },
  "menu.metadataAutoHelp": { en: "models.dev first; query Gateway for missing core specs, to refresh its saved fields or verify tracked identity conflicts.", "zh-CN": "优先 models.dev；仅在核心参数缺失、需刷新已有 Gateway 字段或核实旧自动值身份冲突时查询。" },
  "menu.metadataOn": { en: "Always supplement", "zh-CN": "始终补充" },
  "menu.metadataOnHelp": { en: "Check Gateway on every metadata lookup; models.dev still takes priority.", "zh-CN": "每次补全参数都查询 Gateway，仍以 models.dev 为优先。" },
  "menu.metadataOff": { en: "Disabled", "zh-CN": "关闭" },
  "menu.metadataOffHelp": { en: "Never query Gateway; keep previously saved model parameters.", "zh-CN": "不查询 Gateway，保留已保存的模型参数。" },
  "menu.remove": { en: "Delete provider configuration", "zh-CN": "删除供应商配置" },
  "menu.rename": { en: "Change a provider ID", "zh-CN": "修改供应商 ID" },
  "menu.renameProvider": { en: "which provider ID should be changed?", "zh-CN": "选择要修改 ID 的供应商" },
  "menu.newId": { en: "new provider ID (used in config references)", "zh-CN": "新的供应商 ID（用于配置引用）" },
  "menu.renameConfirm": { en: "change provider ID from {oldId} to {newId} and update agent config references? Files are backed up first.", "zh-CN": "将供应商 ID 从 {oldId} 改为 {newId}，并更新智能体中的关联配置？修改前自动备份。" },
  "menu.removeScope": { en: "where should this provider be removed?", "zh-CN": "从哪里删除供应商？" },
  "menu.removeStore": { en: "Delete only the record in agentsw", "zh-CN": "只删除 agentsw 中的记录" },
  "menu.removeEverywhere": { en: "Delete the agentsw record and matching agent configs", "zh-CN": "同时删除 agentsw 记录和智能体配置" },
  "menu.removeLocal": { en: "Delete only one agent's configuration", "zh-CN": "只删除某个智能体中的配置" },
  "menu.noRemovable": { en: "no provider records found here; return to the menu to choose another scope", "zh-CN": "所选位置没有供应商记录，请返回菜单选择其他删除范围" },
  "menu.removeApp": { en: "which agent's configuration should be changed?", "zh-CN": "选择要删除配置的智能体" },
  "menu.removeStoreHelp": { en: "Keep all agent configs; the agents can still use this provider.", "zh-CN": "保留各智能体配置，它们仍可继续使用该供应商。" },
  "menu.removeEverywhereHelp": { en: "Remove the saved provider and matching agent entries, including related default selections.", "zh-CN": "删除已保存的供应商及各智能体中匹配的配置，并清理相关默认选择。" },
  "menu.removeLocalHelp": { en: "Keep agentsw and other agents unchanged; also works for providers never imported into agentsw.", "zh-CN": "保留 agentsw 和其他智能体；也支持从未导入 agentsw 的供应商。" },
  "menu.removeConfirmStore": { en: "delete {id} from agentsw only? All agent configs stay unchanged. Files are backed up first.", "zh-CN": "确认只删除 agentsw 中的供应商 {id}？各智能体配置保持不变，修改前自动备份。" },
  "menu.removeConfirmEverywhere": { en: "delete {id} from agentsw and matching agent configs? Related default selections will also be cleared. Files are backed up first.", "zh-CN": "确认删除 {id} 的 agentsw 记录和匹配的智能体配置？相关默认选择会一并清理，修改前自动备份。" },
  "menu.removeConfirmLocal": { en: "delete {id} only from {app}? Keep agentsw and other agents unchanged; syncing later may add it back. Files are backed up first.", "zh-CN": "仅从 {app} 删除 {id}？保留 agentsw 和其他智能体配置，再次同步可能恢复。修改前自动备份。" },
  "menu.confirmRename": { en: "Change ID", "zh-CN": "确认修改 ID" },
  "menu.confirmRemove": { en: "Delete configuration", "zh-CN": "确认删除" },
  "menu.cancelAction": { en: "Cancel, return to menu", "zh-CN": "取消，返回菜单" },
  "menu.apps": { en: "Check agent versions and updates", "zh-CN": "检查智能体版本和更新" },
  "menu.language": { en: "Change language / 语言", "zh-CN": "切换界面语言 / Language" },
  "menu.quit": { en: "Exit menu", "zh-CN": "退出菜单" },
  "menu.yes": { en: "yes", "zh-CN": "是" },
  "menu.no": { en: "no", "zh-CN": "否" },
  "menu.modelSource": { en: "how should the model list be obtained?", "zh-CN": "选择模型列表的获取方式" },
  "menu.modelDiscover": { en: "Fetch from the provider API (recommended)", "zh-CN": "从供应商接口自动获取（推荐）" },
  "menu.modelManual": { en: "Enter model IDs manually", "zh-CN": "手动输入模型 ID" },
  "menu.pickProvider": { en: "which provider should agents switch to?", "zh-CN": "选择要切换到的供应商" },
  "menu.defaultModel": { en: "default model", "zh-CN": "默认模型" },
  "menu.keepDefault": { en: "keep current default ({model})", "zh-CN": "保持当前默认模型({model})" },
  "menu.active": { en: "current in agentsw", "zh-CN": "agentsw 当前" },
  "menu.pickApps": { en: "which agent configs should this write to?", "zh-CN": "写入哪些智能体配置？" },
  "menu.appsAll": { en: "all {count} detected apps", "zh-CN": "全部 {count} 个检测到的应用" },
  "menu.appNotDetected": { en: "(not detected)", "zh-CN": "(未检测到)" },
  "menu.appsHint": { en: "↑/↓ move · Space toggle · Enter confirm", "zh-CN": "↑/↓ 移动 · 空格切换 · Enter 确认" },
  "menu.discoverFor": { en: "which provider's model list should be updated?", "zh-CN": "选择要更新模型列表的供应商" },
  "menu.pushRefresh": { en: "also sync this provider to agent configs after updating its model list?", "zh-CN": "更新模型列表后，是否同时将该供应商同步到智能体配置？" },
  "menu.removeProvider": { en: "which provider configuration should be deleted?", "zh-CN": "选择要删除配置的供应商" },
  "menu.upgrade": { en: "upgrade all installed agents that have updates?", "zh-CN": "是否升级所有有新版本的已安装智能体？" },
  "menu.installApp": { en: "Install a new coding agent", "zh-CN": "安装新的智能体" },
  "menu.pickApp": { en: "which agent to install?", "zh-CN": "安装哪个智能体?" },
  "menu.installConfirm": { en: "install {name} via: {cmd}?", "zh-CN": "通过以下命令安装 {name}: {cmd}?" },
  "menu.allInstalled": { en: "all agents already installed", "zh-CN": "所有智能体均已安装" },
  "menu.bye": { en: "bye", "zh-CN": "再见" },

  "add.id": { en: "provider id (slug)", "zh-CN": "供应商 id(slug)" },
  "add.idAuto": { en: "provider id (leave blank for hostname + protocol)", "zh-CN": "供应商 ID（留空使用完整域名 + 协议）" },
  "add.idInvalid": { en: "start with a lowercase letter or digit; use only lowercase letters, digits, - and _, e.g. my-proxy", "zh-CN": "以小写字母或数字开头，仅含小写字母、数字、-、_，如 my-proxy" },
  "add.name": { en: "display name", "zh-CN": "显示名称" },
  "add.protocol": { en: "wire protocol", "zh-CN": "接口协议" },
  "add.openai": { en: "openai (chat completions)", "zh-CN": "openai (chat completions)" },
  "add.anthropic": { en: "anthropic (messages)", "zh-CN": "anthropic (messages)" },
  "add.baseUrl": { en: "API base URL", "zh-CN": "接口地址（Base URL）" },
  "add.baseUrlInvalid": { en: "must start with http(s)://", "zh-CN": "必须以 http(s):// 开头" },
  "add.apiKey": { en: "API key", "zh-CN": "API 密钥（API key）" },
  "add.models": { en: "model ids (comma separated, or leave blank to auto-discover)", "zh-CN": "模型 id(逗号分隔，留空则自动发现)" },

  "import.already": { en: "already configured as {id}", "zh-CN": "已配置为 {id}" },
  "import.noneNew": { en: "nothing new to import (every discovered provider is already configured)", "zh-CN": "没有可导入的新供应商(发现项均已配置)" },
  "import.noneFound": { en: "no custom providers found in supported app configs or in cc-switch", "zh-CN": "支持的应用配置与 cc-switch 中均未发现自定义供应商" },
  "import.keyYes": { en: "yes", "zh-CN": "有" },
  "import.keyEnv": { en: "env {name}", "zh-CN": "环境变量 {name}" },
  "import.keyMissing": { en: "missing", "zh-CN": "缺失" },
  "import.which": { en: "import which providers?", "zh-CN": "请选择要导入的供应商" },
  "import.noModels": { en: "no models listed", "zh-CN": "未列出模型" },
  "import.nothingSelected": { en: "nothing selected", "zh-CN": "未选择任何供应商" },
  "import.keyRefMissing": { en: "env var {name} is referenced by a config but not set", "zh-CN": "配置引用了环境变量 {name},但该变量未设置" },
  "import.keyNotStored": { en: "not stored in any config", "zh-CN": "任何配置中都未存储" },
  "import.missingKey": { en: "{id}: no API key ({why}); export it or run interactive import", "zh-CN": "{id}:缺少 API key({why});请导出环境变量或运行交互导入" },
  "import.keyPrompt": { en: "API key for {id} ({url}) — {why}", "zh-CN": "请输入 {id} 的 API key({url})— {why}" },
  "import.required": { en: "required", "zh-CN": "必填" },
  "import.discovering": { en: "{id}: no model ids in configs; discovering via /v1/models ...", "zh-CN": "{id}:配置中没有模型 id;正在通过 /v1/models 发现..." },
  "import.discoveryFailed": { en: "{id}: no models in configs and discovery failed ({error}) — use agentsw add", "zh-CN": "{id}:配置中无模型且发现失败({error})——请改用 agentsw add" },
  "import.noModelsImport": { en: "{id}: no models to import", "zh-CN": "{id}:没有可导入模型" },
  "import.imported": { en: "imported", "zh-CN": "已导入" },
  "import.updated": { en: "updated", "zh-CN": "已更新" },
  "import.from": { en: "from", "zh-CN": "来源" },
  "import.next": { en: "next: agentsw use {id}", "zh-CN": "下一步: agentsw use {id}" },
  "add.fieldRequired": { en: "--{field} is required in non-interactive mode", "zh-CN": "非交互模式必须提供 --{field}" },
  "add.protocolInvalid": { en: "protocol must be openai or anthropic", "zh-CN": "协议必须为 openai 或 anthropic" },
  "add.openaiApiInvalid": {
    en: "--openai-api must be completions or responses",
    "zh-CN": "--openai-api 必须为 completions 或 responses",
  },
  "add.openaiApi": { en: "openai endpoint flavor", "zh-CN": "openai 接口形态" },
  "add.completions": {
    en: "chat completions (/v1/chat/completions) — the common one",
    "zh-CN": "chat completions(/v1/chat/completions)——最常见",
  },
  "add.responses": { en: "responses (/v1/responses)", "zh-CN": "responses(/v1/responses)" },
  "add.discovering": { en: "discovering models from {url} ...", "zh-CN": "正在从 {url} 发现模型..." },
  "add.providerLists": { en: "provider lists {count} model(s) via /v1/models", "zh-CN": "供应商通过 /v1/models 返回 {count} 个模型" },
  "add.atLeastOne": { en: "at least one model id is required (or use --discover)", "zh-CN": "至少需要一个模型 id(或使用 --discover)" },
  "add.autoDiscover": { en: "no models entered — discovering from /v1/models automatically", "zh-CN": "未输入模型 — 自动从 /v1/models 发现" },
  "add.defaultMissing": { en: "default model {model} is not in the model list", "zh-CN": "默认模型 {model} 不在模型列表中" },
  "add.smallMissing": { en: "small model {model} is not in the model list", "zh-CN": "小型模型 {model} 不在模型列表中" },
  "add.added": { en: "added", "zh-CN": "已添加" },
  "add.alreadyConfigured": { en: "same endpoint and key are already configured as {id}; updating it instead of creating a duplicate", "zh-CN": "相同地址与密钥已配置为 {id};将更新该供应商,不会新建重复项" },
  "add.updated": { en: "updated", "zh-CN": "已更新" },
  "add.saved": { en: "{status} provider {id} ({protocol})", "zh-CN": "{status}供应商 {id} ({protocol})" },
  "add.metadata": { en: "model metadata: {matched}/{total} models have a context limit", "zh-CN": "模型参数：{matched}/{total} 个模型已有上下文上限" },
  "add.providerHint": { en: " (provider hint: {hint})", "zh-CN": " (供应商提示:{hint})" },
  "add.next": { en: "next: agentsw use {id}", "zh-CN": "下一步: agentsw use {id}" },
  "quick.probing": { en: "probing protocols at {url} ...", "zh-CN": "正在探测 {url} 支持的协议..." },
  "quick.noProtocol": { en: "no supported protocol found at this endpoint (tried openai and anthropic)", "zh-CN": "该端点未检测到支持的协议(已尝试 openai 和 anthropic)" },
  "quick.noModelsAfterFilter": { en: "{id}: no models left after filtering, skipping", "zh-CN": "{id}: 过滤后无剩余模型,跳过" },
  "quick.summary": { en: "created {count} provider(s): {ids}", "zh-CN": "创建了 {count} 个供应商: {ids}" },
  "menu.quickAdd": { en: "Add provider (auto-detect)", "zh-CN": "添加供应商（自动识别）" },
  "menu.quickAddHelp": { en: "Recommended: enter an API URL and key; detect protocols and models automatically.", "zh-CN": "推荐：只填接口地址和 API key，自动识别协议与模型。" },
  "menu.addHelp": { en: "Choose the protocol and model setup yourself; use an existing ID to update a provider.", "zh-CN": "自行选择协议和模型获取方式；填写已有 ID 可更新供应商。" },
  "menu.importHelp": { en: "Read providers from agents or cc-switch into agentsw; leave source configs unchanged.", "zh-CN": "从智能体或 cc-switch 读取配置并保存到 agentsw，不修改来源配置。" },
  "menu.useHelp": { en: "Select a provider and default model, then write them to compatible agent configs.", "zh-CN": "选择供应商和默认模型，然后写入支持该协议的智能体配置。" },
  "menu.statusHelp": { en: "Show detected agents, their current providers and config file locations.", "zh-CN": "查看检测到的智能体、所用供应商及配置文件位置。" },
  "menu.listHelp": { en: "Show only the providers, protocols and default models saved in agentsw.", "zh-CN": "只查看 agentsw 已保存的供应商、协议和默认模型。" },
  "menu.syncHelp": { en: "Write the current agentsw provider to agent configs without fetching a model list or metadata catalogs.", "zh-CN": "将 agentsw 当前供应商写入智能体配置，不重新获取模型列表或元数据目录。" },
  "menu.discoverHelp": { en: "Fetch models from the provider, fill in model metadata, and optionally sync to agents.", "zh-CN": "从供应商接口重新获取模型并补全模型参数，可选择同步到智能体。" },
  "menu.renameHelp": { en: "Change the config ID and update references; keep custom display names.", "zh-CN": "修改配置中的标识并更新关联引用，保留自定义显示名称。" },
  "menu.removeHelp": { en: "Choose where to delete: agentsw only, one agent only, or both.", "zh-CN": "先选择删除范围：仅 agentsw、仅某个智能体，或两处一起。" },
  "menu.appsHelp": { en: "Compare installed and latest versions, then choose whether to upgrade.", "zh-CN": "对比已安装版本和最新版本，再选择是否升级。" },
  "menu.installAppHelp": { en: "Choose an agent that is not installed yet, such as Claude Code, Codex or omp.", "zh-CN": "选择尚未安装的编码智能体，如 Claude Code、Codex 或 omp。" },
  "menu.languageHelp": { en: "Choose English or 简体中文 and save the language for future runs.", "zh-CN": "选择简体中文或 English，保存为后续运行的界面语言。" },
  "menu.quitHelp": { en: "End this menu session without performing another action.", "zh-CN": "结束本次交互，不执行其他操作。" },
  "import.skip": { en: "skip", "zh-CN": "跳过" },
  "import.modelsCount": { en: "{count} models", "zh-CN": "{count} 个模型" },
  "table.protocol": { en: "PROTOCOL", "zh-CN": "协议" },
  "table.defaultModel": { en: "DEFAULT MODEL", "zh-CN": "默认模型" },
  "table.models": { en: "MODELS", "zh-CN": "模型数" },
  "table.from": { en: "FROM", "zh-CN": "来源" },
  "table.key": { en: "KEY", "zh-CN": "密钥" },
  "table.found": { en: "FOUND", "zh-CN": "已发现" },
  "table.protocols": { en: "PROTOCOLS", "zh-CN": "协议" },
  "table.current": { en: "CURRENT", "zh-CN": "当前" },
  "table.config": { en: "CONFIG", "zh-CN": "配置" },
  "list.none": { en: "no providers configured (config: {file})\nrun: agentsw add or agentsw import", "zh-CN": "尚未配置供应商(配置:{file})\n请运行 agentsw add 或 agentsw import" },
  "remove.pruning": { en: "pruning {id} from app configs", "zh-CN": "正在从应用配置清理 {id}" },
  "remove.removed": { en: "removed provider {id}", "zh-CN": "已删除供应商 {id}" },
  "remove.note": { en: "note: app configs are unchanged; use --prune to clean them", "zh-CN": "注意:应用配置未改动;可使用 --prune 清理" },
  "manage.preview": { en: "preview: {count} file(s) would change", "zh-CN": "预览：将修改 {count} 个文件" },
  "manage.changed": { en: "updated {count} file(s)", "zh-CN": "已更新 {count} 个文件" },
  "manage.backup": { en: "backup directory: {path}", "zh-CN": "备份目录：{path}" },
  "rename.done": { en: "renamed {oldId} to {newId}", "zh-CN": "已将 {oldId} 重命名为 {newId}" },
  "remove.localDone": { en: "removed {id} only from {apps}; agentsw and other apps are unchanged", "zh-CN": "已仅从 {apps} 删除 {id}；agentsw 和其他智能体保持不变" },
  "list.localNone": { en: "no agent-local provider entries found", "zh-CN": "未发现智能体本地供应商条目" },
  "common.skip": { en: "skip", "zh-CN": "跳过" },
  "common.yes": { en: "yes", "zh-CN": "是" },
  "common.no": { en: "no", "zh-CN": "否" },
  "use.modelMissing": { en: "model {model} is not configured on provider {id} (have: {have})", "zh-CN": "供应商 {id} 未配置模型 {model}(已有:{have})" },
  "use.switching": { en: "switching to {id} ({protocol}) · default model {model}", "zh-CN": "正在切换到 {id} ({protocol})· 默认模型 {model}" },
  "sync.noActive": { en: "no active provider; run agentsw use <id> first", "zh-CN": "没有当前供应商;请先运行 agentsw use <id>" },
  "sync.syncing": { en: "syncing provider {id} · default model {model}", "zh-CN": "正在同步供应商 {id} · 默认模型 {model}" },
  "status.config": { en: "config: {file}", "zh-CN": "配置:{file}" },
  "status.active": { en: "active provider: {id}", "zh-CN": "当前供应商:{id}" },
  "status.none": { en: "(none)", "zh-CN": "(无)" },
  "meta.gap": { en: "{count} model(s) have no catalog metadata (shown as \"-\")", "zh-CN": "{count} 个模型没有目录元数据(显示为 \"-\")" },
  "meta.ambiguous": {
    en: "ambiguous ({count}): {ids} — several creators list these; pin with --gateway-models '{\"{id}\":\"creator/model\"}'",
    "zh-CN": "存在歧义({count}):{ids} —— 多个厂商都提供;用 --gateway-models '{\"{id}\":\"creator/model\"}' 指定",
  },
  "meta.unknown": { en: "not listed by any creator ({count}): {ids}", "zh-CN": "所有厂商均未收录({count}):{ids}" },
  "meta.noCreatorRow": {
    en: "no models.dev row for the creator ({count}): {ids} — filled from AI Gateway when available",
    "zh-CN": "厂商在 models.dev 无对应条目({count}):{ids} —— 有 AI Gateway 数据时会自动补全",
  },
  "refresh.checked": { en: "checked model metadata ({changed} provider(s) changed)", "zh-CN": "已检查模型元数据({changed} 个供应商有变化)" },
  "refresh.next": { en: "run `agentsw sync` to push updated metadata into app configs", "zh-CN": "运行 `agentsw sync` 将更新的元数据写入各智能体配置" },

  "opt.json": {
    en: "machine-readable JSON on stdout; disables prompts and progress",
    "zh-CN": "stdout 输出机器可读 JSON(同时关闭交互提问与进度)",
  },
  "opt.quiet": {
    en: "suppress progress, hints and warnings (keep results and errors)",
    "zh-CN": "抑制进度、提示与警告(保留结果与错误)",
  },
  "opt.noColor": { en: "disable colored output (NO_COLOR also works)", "zh-CN": "关闭彩色输出(也支持 NO_COLOR)" },
  "error.jsonRequiresCommand": {
    en: "--json requires an explicit command (for example: agentsw status --json)",
    "zh-CN": "--json 需要指定命令(例如 agentsw status --json)",
  },

  "common.cancelled": { en: "cancelled", "zh-CN": "已取消" },
  "menu.cancelledAction": { en: "cancelled — back to menu", "zh-CN": "已取消 —— 返回菜单" },
  "menu.back": { en: "← Back to main menu", "zh-CN": "← 返回主菜单" },

  "progress.probe": { en: "probing {url} ({protocol}) …", "zh-CN": "正在探测 {url}({protocol})…" },
  "progress.discoverPage": {
    en: "listing models from {url} — page {page}, {count} models",
    "zh-CN": "正在从 {url} 获取模型列表 —— 第 {page} 页,{count} 个模型",
  },
  "progress.catalog": { en: "loading models.dev catalog …", "zh-CN": "正在加载 models.dev 目录…" },
  "progress.gateway": { en: "loading AI Gateway catalog …", "zh-CN": "正在加载 AI Gateway 目录…" },
  "progress.metadata": { en: "supplementing model metadata …", "zh-CN": "正在补全模型元数据…" },
  "progress.apps": {
    en: "checking installed and latest versions … ({done}/{total})",
    "zh-CN": "正在检查已安装版本与最新版本…({done}/{total})",
  },
  "progress.refresh": { en: "refreshing model metadata …", "zh-CN": "正在刷新模型元数据…" },

  "add.retryDiscovery": {
    en: "model discovery failed: {error}. Try again with the same endpoint?",
    "zh-CN": "模型发现失败:{error}。用同一端点重试吗?",
  },
  "quick.retryProbe": {
    en: "no protocol detected at {url}. Re-enter the base URL and API key?",
    "zh-CN": "{url} 未探测到可用协议。重新输入 base URL 与 API key?",
  },
  "import.retryDiscovery": {
    en: "discovery failed for {id}: {error}. Retry discovery for this provider?",
    "zh-CN": "{id} 的模型发现失败:{error}。为该供应商重试?",
  },
  "import.skippedAfterFailure": {
    en: "skipped {id}: discovery failed; add it later with agentsw add",
    "zh-CN": "已跳过 {id}:发现失败;之后可用 agentsw add 补上",
  },

  "models.catalogUnavailable": {
    en: "models.dev catalog unavailable (offline and no cache)\nrun: agentsw models --refresh (or check your network)",
    "zh-CN": "models.dev 目录不可用(离线且无缓存)\n请运行 agentsw models --refresh(或检查网络)",
  },
  "models.usage": {
    en: "usage: agentsw models <query> | agentsw models --provider <id>",
    "zh-CN": "用法: agentsw models <查询> | agentsw models --provider <id>",
  },
  "models.noMatch": {
    en: "no models.dev entries match \"{query}\"\nrun: agentsw models --refresh to update the catalog",
    "zh-CN": "models.dev 中没有匹配 \"{query}\" 的条目\n请运行 agentsw models --refresh 更新目录",
  },
  "models.metadataRequiresProvider": {
    en: "--metadata requires --provider (run: agentsw models --provider <id> --metadata)",
    "zh-CN": "--metadata 需要配合 --provider(请运行 agentsw models --provider <id> --metadata)",
  },
  "status.noProviders": {
    en: "no providers saved yet\nrun: agentsw add — or agentsw import to pull providers from your agents",
    "zh-CN": "尚未保存任何供应商\n请运行 agentsw add,或用 agentsw import 从各智能体导入",
  },

  "apps.checking": { en: "checking installed and latest versions ...", "zh-CN": "正在检查已安装版本与最新版本..." },
  "apps.notInstalled": { en: "not installed", "zh-CN": "未安装" },
  "apps.installable": { en: "installable", "zh-CN": "可安装" },
  "apps.upToDate": { en: "up to date", "zh-CN": "已是最新" },
  "apps.upgradeAvailable": { en: "upgrade available", "zh-CN": "可升级" },
  "apps.unknown": { en: "unknown", "zh-CN": "未知" },
  "apps.checkFailedProbe": { en: "installed version check failed", "zh-CN": "已安装版本检查失败" },
  "apps.checkFailedUnknown": { en: "installed version unknown", "zh-CN": "已安装版本未知" },
  "apps.checkFailedLatest": { en: "latest version unavailable", "zh-CN": "无法获取最新版本" },
  "apps.upgradeWith": { en: "upgrade with: agentsw upgrade {ids}", "zh-CN": "升级命令: agentsw upgrade {ids}" },

  "install.unknownApp": { en: "unknown app \"{value}\" (supported: {apps})", "zh-CN": "未知应用 \"{value}\"(支持:{apps})" },
  "install.notInstallable": {
    en: "{name} is not installable on {platform} (or is managed by its desktop app)",
    "zh-CN": "{name} 无法在 {platform} 上安装(或由桌面应用自行管理)",
  },
  "install.already": {
    en: "{name} already installed ({version}); use `agentsw upgrade {id}`",
    "zh-CN": "{name} 已安装({version});可用 `agentsw upgrade {id}`",
  },
  "install.installing": { en: "installing {name}: {command}", "zh-CN": "正在安装 {name}:{command}" },
  "install.notDetected": {
    en: "{name}: installer completed but the app is still not detected; check the installation and PATH",
    "zh-CN": "{name}:安装命令已结束但仍未检测到该应用;请检查安装与 PATH",
  },
  "install.versionUnknown": {
    en: "{name}: installer completed; app detected but version unknown",
    "zh-CN": "{name}:安装命令已结束;检测到应用但版本未知",
  },
  "install.installed": { en: "{name} installed: {version}", "zh-CN": "{name} 已安装:{version}" },

  "upgrade.unknownApps": { en: "unknown app(s): {ids}", "zh-CN": "未知应用:{ids}" },
  "upgrade.checking": { en: "checking versions ...", "zh-CN": "正在检查版本..." },
  "upgrade.statusUnknown": { en: "{id}: {reason}; update status unknown", "zh-CN": "{id}:{reason};升级状态未知" },
  "upgrade.cannotDetermine": {
    en: "could not determine update status for every installed app",
    "zh-CN": "无法确定所有已安装应用的升级状态",
  },
  "upgrade.allCurrent": { en: "all checked apps are up to date", "zh-CN": "已检查的应用均为最新" },
  "upgrade.none": { en: "no installed CLI-managed apps to upgrade", "zh-CN": "没有可升级的、由 CLI 管理的应用" },
  "upgrade.notCli": { en: "{id}: not CLI-upgradable", "zh-CN": "{id}:不支持通过 CLI 升级" },
  "upgrade.notInstalled": {
    en: "{id}: not installed (use `agentsw install {id}`)",
    "zh-CN": "{id}:未安装(请使用 `agentsw install {id}`)",
  },
  "upgrade.upgrading": { en: "upgrading {name}: {command}", "zh-CN": "正在升级 {name}:{command}" },
  "upgrade.unknownVersion": {
    en: "upgrade command completed but installed version is unknown or app is not detected",
    "zh-CN": "升级命令已结束,但已安装版本未知或未检测到应用",
  },
  "upgrade.olderThanAvailable": {
    en: "upgrade command completed but {version} is older than available {expected}",
    "zh-CN": "升级命令已结束,但 {version} 低于可用的 {expected}",
  },
  "upgrade.done": { en: "{id} -> {version}", "zh-CN": "{id} -> {version}" },
  "upgrade.failed": { en: "{id} upgrade failed: {message}", "zh-CN": "{id} 升级失败:{message}" },

  "discover.defaultMissing": {
    en: "default model {model} no longer listed; keeping it anyway",
    "zh-CN": "默认模型 {model} 已不在列表中;仍然保留",
  },
  "discover.next": {
    en: "run `agentsw sync` to push into app configs",
    "zh-CN": "运行 `agentsw sync` 写入各智能体配置",
  },

  "dryRun.skip": { en: "skip", "zh-CN": "跳过" },
  "dryRun.wouldWrite": {
    en: "dry run — {count} file(s) would be written:",
    "zh-CN": "预演 — 将写入 {count} 个文件:",
  },
  "preview.unchanged": { en: "unchanged", "zh-CN": "未变化" },
  "preview.header": { en: "--- {file} (redacted configuration)", "zh-CN": "--- {file}(已脱敏配置)" },
  "preview.contentWithheld": {
    en: "[content withheld: unsupported or malformed configuration]",
    "zh-CN": "[内容已隐去:配置格式不支持或无法解析]",
  },
  "preview.onlyRedacted": {
    en: "[only redacted values or formatting changed]",
    "zh-CN": "[仅脱敏值或格式发生变化]",
  },
  "preview.failedSafely": {
    en: "configuration could not be previewed safely",
    "zh-CN": "无法安全预览配置",
  },
} as const;

export type MessageKey = keyof typeof messages;

let current: Locale = detectSystemLocale();

export function normalizeLocale(value?: string): Locale | undefined {
  if (!value) return undefined;
  const locale = value.trim().toLowerCase().replace(/_/g, "-");
  if (locale.startsWith("zh")) return "zh-CN";
  if (locale.startsWith("en") || locale === "c" || locale === "posix") return "en";
  return undefined;
}

export function detectSystemLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const hit = normalizeLocale(env[key]);
    if (hit) return hit;
  }
  return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
}

export function extractCliLocale(argv: string[] = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lang") return argv[i + 1];
    if (argv[i]?.startsWith("--lang=")) return argv[i]!.slice("--lang=".length);
  }
  return undefined;
}

export function setLocale(value?: string): Locale {
  current = normalizeLocale(value) ?? "en";
  return current;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  let out: string = messages[key][current];
  for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}

import type { Locale } from "./types.js";

const messages = {
  "root.description": {
    en: "Manage OpenAI/Anthropic-protocol model providers and sync them into coding agents\n(Claude Code, Codex, omp, pi, prime-agent, opencode, Hermes, WorkBuddy, DeepSeek Harness).\nModel metadata (context window, input/output limits, reasoning levels) is enriched from\nmodels.dev; existing providers can be imported from the agents and from cc-switch.\n\nRun without arguments (or via `npx agentsw`) for the interactive menu.",
    "zh-CN": "管理 OpenAI / Anthropic 协议的模型供应商并同步到编码智能体\n(Claude Code、Codex、omp、pi、prime-agent、opencode、Hermes、WorkBuddy、DeepSeek Harness)。\n模型元数据(上下文、输入/输出上限、推理等级)由 models.dev 补全;\n也可从各智能体与 cc-switch 导入已有供应商。\n\n不带参数运行(或 `npx agentsw`)即可打开交互菜单。",
  },
  "help.language": { en: "UI language: en | zh-CN (also AGENTSW_LANG)", "zh-CN": "界面语言: en | zh-CN (也可用 AGENTSW_LANG)" },
  "error.language": { en: "unsupported language \"{value}\"; use en or zh-CN", "zh-CN": "不支持语言 \"{value}\";请使用 en 或 zh-CN" },
  "error.unknownCommand": { en: "unknown command '{value}', see --help", "zh-CN": "未知命令 '{value}',请查看 --help" },

  "cmd.add": { en: "add or update a provider (interactive when flags are omitted)", "zh-CN": "添加或更新供应商(省略参数时进入交互流程)" },
  "cmd.quick": { en: "quick add — auto-detect protocol(s) and models from just base URL + API key", "zh-CN": "快速添加 — 只需 base URL + API key,自动探测协议和模型" },
  "cmd.list": { en: "list configured providers", "zh-CN": "列出已配置供应商" },
  "cmd.remove": { en: "remove a provider", "zh-CN": "删除供应商" },
  "cmd.prune": { en: "remove a provider's entries from app configs (keeps it in agentsw)", "zh-CN": "从应用配置移除供应商条目(仍保留在 agentsw)" },
  "cmd.use": { en: "set the active provider and write it into app configs", "zh-CN": "设为当前供应商并写入应用配置" },
  "cmd.sync": { en: "re-apply the active provider (or --provider) to app configs", "zh-CN": "将当前供应商(或 --provider)重新应用到应用配置" },
  "cmd.status": { en: "show detected apps and what they currently point at", "zh-CN": "显示检测到的应用及当前供应商" },
  "cmd.models": { en: "search models.dev, or show a configured provider's models", "zh-CN": "搜索 models.dev 或显示已配置供应商的模型" },
  "cmd.discover": { en: "refresh a provider's models via /v1/models and models.dev", "zh-CN": "通过 /v1/models 和 models.dev 刷新供应商模型" },
  "cmd.import": { en: "scan app configs, preview and dedupe existing custom providers, then import", "zh-CN": "扫描应用配置,预览并去重已有自定义供应商后导入" },
  "cmd.apps": { en: "check installed agents: current version vs latest", "zh-CN": "检查智能体已安装版本与最新版本" },
  "cmd.install": { en: "install an agent CLI", "zh-CN": "安装智能体 CLI" },
  "cmd.upgrade": { en: "upgrade agent CLIs (no args = everything outdated)", "zh-CN": "升级智能体 CLI(无参数时升级全部过期项)" },
  "cmd.refresh": { en: "re-fetch models.dev metadata for all providers", "zh-CN": "重新拉取所有供应商的 models.dev 元数据" },

  "opt.id": { en: "provider id, e.g. glm, my-proxy", "zh-CN": "供应商 id,例如 glm、my-proxy" },
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
  "opt.noDedup": { en: "keep snapshot duplicates (-latest/date suffixes)", "zh-CN": "保留快照重复项(-latest/日期后缀)" },
  "opt.modelsDev": { en: "models.dev provider id for metadata matching", "zh-CN": "用于元数据匹配的 models.dev 供应商 id" },
  "opt.yes": { en: "non-interactive; require all flags", "zh-CN": "非交互模式;要求提供全部参数" },
  "opt.prune": { en: "also remove entries from app configs", "zh-CN": "同时从应用配置中移除条目" },
  "opt.apps": { en: "comma-separated apps or 'all'", "zh-CN": "逗号分隔的应用或 'all'" },
  "opt.appsDetailed": { en: "comma-separated apps (claude,codex,omp,pi,prime,opencode,hermes,workbuddy) or 'all'", "zh-CN": "逗号分隔的应用(claude,codex,omp,pi,prime,opencode,hermes,workbuddy)或 'all'" },
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
  "menu.noProviders": { en: "no providers configured yet", "zh-CN": "尚未配置供应商" },
  "menu.noProvidersHint": { en: "no providers configured — choose import existing providers or add/update provider first", "zh-CN": "尚未配置供应商——请先选择导入已有供应商或添加/更新供应商" },
  "menu.firstScan": { en: "scan existing app configs and import custom providers now?", "zh-CN": "现在扫描应用配置并导入已有自定义供应商?" },
  "menu.what": { en: "what to do?", "zh-CN": "请选择操作" },
  "menu.add": { en: "add / update provider   (id · protocol · base URL · API key)", "zh-CN": "添加 / 更新供应商      (id · 协议 · base URL · API key)" },
  "menu.import": { en: "import existing providers (scan app configs · auto-dedupe)", "zh-CN": "导入已有供应商          (扫描应用配置 · 自动去重)" },
  "menu.use": { en: "switch provider         (use and sync into app configs)", "zh-CN": "切换供应商              (写入并同步到应用配置)" },
  "menu.status": { en: "status                  (what each app currently points at)", "zh-CN": "查看状态                (各应用当前指向)" },
  "menu.list": { en: "list providers", "zh-CN": "列出供应商" },
  "menu.sync": { en: "sync active provider    (re-apply to app configs)", "zh-CN": "同步当前供应商          (重新应用到应用配置)" },
  "menu.discover": { en: "discover models         (refresh provider list + metadata)", "zh-CN": "发现模型                (刷新供应商模型与元数据)" },
  "menu.remove": { en: "remove provider", "zh-CN": "删除供应商" },
  "menu.apps": { en: "agent versions          (check installed CLIs / upgrade)", "zh-CN": "智能体版本              (检查已安装 CLI / 升级)" },
  "menu.language": { en: "language / 语言", "zh-CN": "语言 / Language" },
  "menu.quit": { en: "quit", "zh-CN": "退出" },
  "menu.yes": { en: "yes", "zh-CN": "是" },
  "menu.no": { en: "no", "zh-CN": "否" },
  "menu.modelSource": { en: "how to fill the model list?", "zh-CN": "如何填写模型列表?" },
  "menu.modelDiscover": { en: "discover from the provider's /v1/models (recommended)", "zh-CN": "从供应商 /v1/models 自动发现(推荐)" },
  "menu.modelManual": { en: "type model ids manually", "zh-CN": "手动输入模型 id" },
  "menu.pickProvider": { en: "switch to provider", "zh-CN": "切换到供应商" },
  "menu.defaultModel": { en: "default model", "zh-CN": "默认模型" },
  "menu.keepDefault": { en: "keep current default ({model})", "zh-CN": "保持当前默认模型({model})" },
  "menu.active": { en: "active", "zh-CN": "当前" },
  "menu.discoverFor": { en: "discover models for", "zh-CN": "为供应商发现模型" },
  "menu.pushRefresh": { en: "push refreshed provider into app configs?", "zh-CN": "将刷新后的供应商推送到应用配置?" },
  "menu.removeProvider": { en: "remove provider", "zh-CN": "删除供应商" },
  "menu.reallyRemove": { en: "really remove {id}?", "zh-CN": "确认删除 {id}?" },
  "menu.pruneConfigs": { en: "also remove its entries from app configs?", "zh-CN": "同时从应用配置中移除其条目?" },
  "menu.upgrade": { en: "upgrade everything outdated?", "zh-CN": "升级全部过期项?" },
  "menu.installApp": { en: "install an agent", "zh-CN": "安装智能体" },
  "menu.pickApp": { en: "which agent to install?", "zh-CN": "安装哪个智能体?" },
  "menu.installConfirm": { en: "install {name} via: {cmd}?", "zh-CN": "通过以下命令安装 {name}: {cmd}?" },
  "menu.allInstalled": { en: "all agents already installed", "zh-CN": "所有智能体均已安装" },
  "menu.bye": { en: "bye", "zh-CN": "再见" },

  "add.id": { en: "provider id (slug)", "zh-CN": "供应商 id(slug)" },
  "add.idInvalid": { en: "lowercase slug, e.g. glm or my-proxy", "zh-CN": "请用小写 slug,例如 glm 或 my-proxy" },
  "add.name": { en: "display name", "zh-CN": "显示名称" },
  "add.protocol": { en: "wire protocol", "zh-CN": "接口协议" },
  "add.openai": { en: "openai (chat completions)", "zh-CN": "openai (chat completions)" },
  "add.anthropic": { en: "anthropic (messages)", "zh-CN": "anthropic (messages)" },
  "add.baseUrl": { en: "base URL", "zh-CN": "base URL" },
  "add.baseUrlInvalid": { en: "must start with http(s)://", "zh-CN": "必须以 http(s):// 开头" },
  "add.apiKey": { en: "API key", "zh-CN": "API key" },
  "add.models": { en: "model ids (comma separated, or leave blank to auto-discover)", "zh-CN": "模型 id(逗号分隔，留空则自动发现)" },
  "add.cancelled": { en: "cancelled", "zh-CN": "已取消" },

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
  "add.updated": { en: "updated", "zh-CN": "已更新" },
  "add.saved": { en: "{status} provider {id} ({protocol})", "zh-CN": "{status}供应商 {id} ({protocol})" },
  "add.metadata": { en: "models.dev metadata: {matched}/{total} models matched", "zh-CN": "models.dev 元数据:匹配 {matched}/{total} 个模型" },
  "add.providerHint": { en: " (provider hint: {hint})", "zh-CN": " (供应商提示:{hint})" },
  "add.next": { en: "next: agentsw use {id}", "zh-CN": "下一步: agentsw use {id}" },
  "quick.probing": { en: "probing protocols at {url} ...", "zh-CN": "正在探测 {url} 支持的协议..." },
  "quick.noProtocol": { en: "no supported protocol found at this endpoint (tried openai and anthropic)", "zh-CN": "该端点未检测到支持的协议(已尝试 openai 和 anthropic)" },
  "quick.noModelsAfterFilter": { en: "{id}: no models left after filtering, skipping", "zh-CN": "{id}: 过滤后无剩余模型,跳过" },
  "quick.summary": { en: "created {count} provider(s): {ids}", "zh-CN": "创建了 {count} 个供应商: {ids}" },
  "menu.quickAdd": { en: "quick add (auto-detect protocol + models)", "zh-CN": "快速添加(自动探测协议 + 模型)" },
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

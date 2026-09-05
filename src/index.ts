#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import {
  cmdAdd,
  cmdQuickAdd,
  cmdApps,
  cmdDiscover,
  cmdImport,
  cmdInstall,
  cmdList,
  cmdModels,
  cmdRefreshMeta,
  cmdPrune,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";
import { detectSystemLocale, extractCliLocale, normalizeLocale, setLocale, t } from "./i18n.js";
import { cmdMenu } from "./menu.js";
import { loadStore } from "./store.js";
import type { Locale } from "./types.js";
import { cmdListLocalProviders, cmdRemoveProvider, cmdRename } from "./provider-actions.js";

// Locale lookup is best effort: help/version and app-local commands do not need the store.
function savedLocale(): Locale | undefined {
  try { return loadStore().language; } catch { return undefined; }
}

// Locale precedence: CLI flag > environment > saved preference > system locale.
setLocale(extractCliLocale() ?? process.env.AGENTSW_LANG ?? savedLocale() ?? detectSystemLocale());

function parseLocale(value: string): Locale {
  const locale = normalizeLocale(value);
  if (!locale) throw new InvalidArgumentError(t("error.language", { value }));
  setLocale(locale);
  return locale;
}

const program = new Command();

// read the real version from package.json instead of a drifting literal
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

program
  .name("agentsw")
  .description(t("root.description"))
  .option("--lang <locale>", t("help.language"), parseLocale)
  .version(version);

// bare invocation -> interactive menu (help on non-TTY); unknown subcommand -> error.
// excess arguments are surfaced by us, so the message names the offending command.
program
  .allowExcessArguments()
  .action((...handlerArgs: unknown[]) => {
    const cmd = handlerArgs[handlerArgs.length - 1] as Command;
    if (cmd.args.length > 0) program.error(t("error.unknownCommand", { value: cmd.args[0]! }));
    if (process.stdin.isTTY) return cmdMenu();
    program.outputHelp();
  });

program
  .command("add")
  .description(t("cmd.add"))
  .option("--id <slug>", t("opt.id"))
  .option("--name <name>", t("opt.name"))
  .option("--protocol <p>", t("opt.protocol"))
  .option("--openai-api <flavor>", t("opt.openaiApi"))
  .option("--base-url <url>", t("opt.baseUrl"))
  .option("--api-key <key>", t("opt.apiKey"))
  .option("--models <ids>", t("opt.models"))
  .option("--default-model <id>", t("opt.defaultModel"))
  .option("--small-model <id>", t("opt.smallModel"))
  .option("--reasoning-effort <level>", t("opt.reasoning"))
  .option("-d, --discover", t("opt.discover"))
  .option("--include <globs>", t("opt.include"))
  .option("--exclude <globs>", t("opt.exclude"))
  .option("--dedup", t("opt.dedup"))
  .option("--no-dedup", t("opt.noDedup"))
  .option("--models-dev <id>", t("opt.modelsDev"))
  .option("-y, --yes", t("opt.yes"))
  .action(cmdAdd);

program
  .command("quick")
  .description(t("cmd.quick"))
  .option("--id <slug>", t("opt.id"))
  .option("--name <name>", t("opt.name"))
  .option("--openai-api <flavor>", t("opt.openaiApi"))
  .option("--models-dev <id>", t("opt.modelsDev"))
  .option("--base-url <url>", t("opt.baseUrl"))
  .option("--api-key <key>", t("opt.apiKey"))
  .option("--default-model <id>", t("opt.defaultModel"))
  .option("--small-model <id>", t("opt.smallModel"))
  .option("--reasoning-effort <level>", t("opt.reasoning"))
  .option("--include <globs>", t("opt.include"))
  .option("--exclude <globs>", t("opt.exclude"))
  .option("--dedup", t("opt.dedup"))
  .option("--no-dedup", t("opt.noDedup"))
  .option("-y, --yes", t("opt.yes"))
  .action(cmdQuickAdd);

program
  .command("list")
  .alias("ls")
  .description(t("cmd.list"))
  .option("-a, --apps <apps>", t("opt.apps"))
  .action((opts: { apps?: string }) => opts.apps ? cmdListLocalProviders(opts.apps) : cmdList());

program
  .command("rename <id> <new-id>")
  .description(t("cmd.rename"))
  .option("-n, --dry-run", t("opt.manageDryRun"))
  .action(cmdRename);

program
  .command("remove <id>")
  .alias("rm")
  .description(t("cmd.remove"))
  .option("--prune", t("opt.prune"))
  .option("-a, --apps <apps>", t("opt.removeApps"))
  .option("-n, --dry-run", t("opt.manageDryRun"))
  .action(cmdRemoveProvider);

program
  .command("prune <id>")
  .description(t("cmd.prune"))
  .option("-a, --apps <apps>", t("opt.apps"))
  .action(cmdPrune);

program
  .command("use <id>")
  .description(t("cmd.use"))
  .option("-a, --apps <apps>", t("opt.appsDetailed"))
  .option("-m, --model <id>", t("opt.model"))
  .option("-n, --dry-run", t("opt.dryRun"))
  .action(cmdUse);

program
  .command("sync")
  .description(t("cmd.sync"))
  .option("-a, --apps <apps>", t("opt.apps"))
  .option("-p, --provider <id>", t("opt.provider"))
  .option("-n, --dry-run", t("opt.dryRun"))
  .action(cmdSync);

program.command("status").description(t("cmd.status")).action(cmdStatus);

program
  .command("models [query]")
  .description(t("cmd.models"))
  .option("-p, --provider <id>", t("opt.showProvider"))
  .option("-r, --refresh", t("opt.refresh"))
  .option("-l, --limit <n>", t("opt.limit"), "30")
  .action(cmdModels);

program
  .command("discover <id>")
  .description(t("cmd.discover"))
  .option("-s, --sync", t("opt.syncAfter"))
  .option("-a, --apps <apps>", t("opt.appsSync"))
  .option("--include <globs>", t("opt.setInclude"))
  .option("--exclude <globs>", t("opt.setExclude"))
  .option("--dedup", t("opt.dedup"))
  .option("--no-dedup", t("opt.noDedup"))
  .option("--no-filter", t("opt.noFilter"))
  .action(cmdDiscover);

program
  .command("import")
  .description(t("cmd.import"))
  .option("--all", t("opt.all"))
  .action(cmdImport);

program.command("apps").description(t("cmd.apps")).action(cmdApps);
program.command("install <app>").description(t("cmd.install")).action(cmdInstall);
program.command("upgrade [apps...]").description(t("cmd.upgrade")).action(cmdUpgrade);
program.command("refresh").description(t("cmd.refresh")).action(cmdRefreshMeta);

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});

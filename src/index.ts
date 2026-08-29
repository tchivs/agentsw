#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  cmdAdd,
  cmdApps,
  cmdDiscover,
  cmdInstall,
  cmdList,
  cmdModels,
  cmdRefreshMeta,
  cmdPrune,
  cmdRemove,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";
import { cmdMenu } from "./menu.js";

const program = new Command();

// read the real version from package.json instead of a drifting literal
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

program
  .name("smart-switch")
  .description(
    "Manage OpenAI/Anthropic-protocol model providers and sync them into coding agents\n" +
      "(claude code, codex, omp, pi, prime-agent, opencode, hermes). Model metadata\n" +
      "(context window, input/output limits, reasoning levels) is enriched from models.dev.\n\n" +
      "Run without arguments (or via `npx smart-switch`) for the interactive menu.",
  )
  .version(version);

// bare invocation -> interactive menu (help on non-TTY); unknown subcommand -> error.
// excess arguments are surfaced by us, so the message names the offending command.
program
  .allowExcessArguments()
  .action((...handlerArgs: unknown[]) => {
    const cmd = handlerArgs[handlerArgs.length - 1] as Command;
    if (cmd.args.length > 0) program.error(`unknown command '${cmd.args[0]}', see --help`);
    if (process.stdin.isTTY) return cmdMenu();
    program.outputHelp();
  });

program
  .command("add")
  .description("add or update a provider (interactive when flags are omitted)")
  .option("--id <slug>", "provider id, e.g. glm, my-proxy")
  .option("--name <name>", "display name")
  .option("--protocol <p>", "wire protocol: openai | anthropic")
  .option("--base-url <url>", "API base URL")
  .option("--api-key <key>", "API key")
  .option("--models <ids>", "comma-separated model ids")
  .option("--default-model <id>", "default model (defaults to first)")
  .option("--small-model <id>", "small/fast model (Claude Code haiku slot)")
  .option("--reasoning-effort <level>", "preferred reasoning effort (codex): minimal|low|medium|high")
  .option("-d, --discover", "list model ids from the provider's /v1/models endpoint")
  .option("--include <globs>", "keep only discovered models matching these comma-separated globs")
  .option("--exclude <globs>", "drop discovered models matching these comma-separated globs")
  .option("--no-dedup", "keep snapshot duplicates (-latest, date suffixes); dropped by default")
  .option("--models-dev <id>", "models.dev provider id for metadata matching")
  .option("-y, --yes", "non-interactive; require all flags")
  .action(cmdAdd);

program.command("list").alias("ls").description("list configured providers").action(cmdList);

program
  .command("remove <id>")
  .alias("rm")
  .description("remove a provider")
  .option("--prune", "also remove the provider's entries from app configs")
  .action(cmdRemove);

program
  .command("prune <id>")
  .description("remove a provider's entries from app configs (keeps it in smart-switch)")
  .option("-a, --apps <apps>", "comma-separated apps or 'all'")
  .action(cmdPrune);

program
  .command("use <id>")
  .description("set the active provider and write it into app configs")
  .option("-a, --apps <apps>", "comma-separated apps (claude,codex,omp,pi,prime,opencode,hermes) or 'all'")
  .option("-m, --model <id>", "override the default model while switching")
  .option("-n, --dry-run", "preview the config diff without writing")
  .action(cmdUse);

program
  .command("sync")
  .description("re-apply the active provider (or --provider) to app configs")
  .option("-a, --apps <apps>", "comma-separated apps or 'all'")
  .option("-p, --provider <id>", "sync this provider instead of the active one")
  .option("-n, --dry-run", "preview the config diff without writing")
  .action(cmdSync);

program.command("status").description("show detected apps and what they currently point at").action(cmdStatus);

program
  .command("models [query]")
  .description("search the models.dev catalog, or show a configured provider's models")
  .option("-p, --provider <id>", "show models of a configured provider")
  .option("-r, --refresh", "force-refresh the models.dev cache")
  .option("-l, --limit <n>", "max results", "30")
  .action(cmdModels);

program
  .command("discover <id>")
  .description("re-list a provider's models via /v1/models and re-enrich from models.dev")
  .option("-s, --sync", "push the refreshed provider into app configs afterwards")
  .option("-a, --apps <apps>", "apps to sync when --sync is set")
  .option("--include <globs>", "set + persist include filter (comma-separated globs)")
  .option("--exclude <globs>", "set + persist exclude filter")
  .option("--no-dedup", "set + persist: keep snapshot duplicates (dropped by default)")
  .option("--no-filter", "clear the persisted filter")
  .action(cmdDiscover);

program
  .command("apps")
  .description("check installed agents: current version vs latest (like cc-switch 本地环境检查)")
  .action(cmdApps);

program.command("install <app>").description("install an agent CLI").action(cmdInstall);

program
  .command("upgrade [apps...]")
  .description("upgrade agent CLIs (no args = everything outdated)")
  .action(cmdUpgrade);

program
  .command("refresh")
  .description("re-fetch models.dev and refresh metadata of all configured providers")
  .action(cmdRefreshMeta);

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});

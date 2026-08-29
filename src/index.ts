#!/usr/bin/env node
import { Command } from "commander";
import {
  cmdAdd,
  cmdApps,
  cmdDiscover,
  cmdInstall,
  cmdList,
  cmdModels,
  cmdRefreshMeta,
  cmdRemove,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";

const program = new Command();

program
  .name("smart-switch")
  .description(
    "Manage OpenAI/Anthropic-protocol model providers and sync them into coding agents\n" +
      "(claude code, codex, omp, pi, prime-agent, opencode, hermes). Model metadata\n" +
      "(context window, input/output limits, reasoning levels) is enriched from models.dev.",
  )
  .version("0.1.0");

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
  .option("--models-dev <id>", "models.dev provider id for metadata matching")
  .option("-y, --yes", "non-interactive; require all flags")
  .action(cmdAdd);

program.command("list").alias("ls").description("list configured providers").action(cmdList);

program.command("remove <id>").alias("rm").description("remove a provider").action(cmdRemove);

program
  .command("use <id>")
  .description("set the active provider and write it into app configs")
  .option("-a, --apps <apps>", "comma-separated apps (claude,codex,omp,pi,prime,opencode,hermes) or 'all'")
  .option("-m, --model <id>", "override the default model while switching")
  .action(cmdUse);

program
  .command("sync")
  .description("re-apply the active provider (or --provider) to app configs")
  .option("-a, --apps <apps>", "comma-separated apps or 'all'")
  .option("-p, --provider <id>", "sync this provider instead of the active one")
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

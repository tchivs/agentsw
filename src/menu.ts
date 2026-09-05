import pc from "picocolors";
import prompts from "prompts";
import {
  cmdAdd,
  cmdQuickAdd,
  cmdApps,
  cmdInstall,
  cmdDiscover,
  cmdImport,
  cmdList,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";
import { getLocale, setLocale, t } from "./i18n.js";
import { loadStore, saveStore } from "./store.js";
import { appPackages, appCommand, installedVersion } from "./apps.js";
import type { Locale } from "./types.js";
import { cmdRemoveProvider, cmdRename } from "./provider-actions.js";
import { listRemovableProviders } from "./remove.js";
import { providerIdFromBaseUrl } from "./slug.js";
import { targets } from "./targets/index.js";

function bye(): never {
  console.log(pc.dim(`\n${t("menu.bye")}`));
  process.exit(0);
}

const cancel = { onCancel: () => bye() };

async function askToggle(message: string, initial = false): Promise<boolean> {
  const { v } = await prompts(
    { type: "toggle", name: "v", message, active: t("menu.yes"), inactive: t("menu.no"), initial },
    cancel,
  );
  return v === true;
}

async function chooseLanguage(): Promise<void> {
  const { language } = await prompts(
    {
      type: "select",
      name: "language",
      message: t("language.prompt"),
      hint: t("menu.selectInstructions"),
      initial: getLocale() === "zh-CN" ? 1 : 0,
      choices: [
        { title: "English", value: "en" },
        { title: "简体中文", value: "zh-CN" },
      ],
    },
    cancel,
  );
  setLocale(language);
  const store = loadStore();
  store.language = language as Locale;
  saveStore(store);
  console.log(pc.green(t("language.saved")));
}

/** select an existing provider; prints a hint and returns undefined when none configured */
async function pickProvider(message: string): Promise<{ id: string; defaultModel: string; models: string[] } | undefined> {
  const store = loadStore();
  const ids = Object.keys(store.providers);
  if (ids.length === 0) {
    console.log(pc.yellow(t("menu.noProvidersHint")));
    return undefined;
  }
  const { id } = await prompts(
    {
      type: "select",
      name: "id",
      message,
      hint: t("menu.selectInstructions"),
      choices: ids.map((pid) => {
        const p = store.providers[pid]!;
        return {
          title: `${pid} · ${p.protocol} · ${t("menu.defaultModel")} ${p.defaultModel}${store.active === pid ? `  (${t("menu.active")})` : ""}`,
          value: pid,
        };
      }),
    },
    cancel,
  );
  if (!id) return undefined;
  const p = store.providers[id]!;
  return { id, defaultModel: p.defaultModel, models: p.models.map((m) => m.id) };
}

async function renameFromMenu(): Promise<void> {
  const picked = await pickProvider(t("menu.renameProvider"));
  if (!picked) return;
  const provider = loadStore().providers[picked.id]!;
  const { newId } = await prompts({
    type: "text",
    name: "newId",
    message: t("menu.newId"),
    initial: providerIdFromBaseUrl(provider.baseUrl, provider.protocol),
    validate: (value: string) => /^[a-z0-9][a-z0-9_-]*$/.test(value.trim()) || t("add.idInvalid"),
  }, cancel);
  if (!newId) return;
  const next = String(newId).trim();
  await cmdRename(picked.id, next, { dryRun: true });
  if (await askToggle(t("menu.renameConfirm", { oldId: picked.id, newId: next }))) {
    await cmdRename(picked.id, next);
  }
}

async function removeFromMenu(): Promise<void> {
  const { scope } = await prompts({
    type: "select",
    name: "scope",
    message: t("menu.removeScope"),
    hint: t("menu.selectInstructions"),
    choices: [
      { title: t("menu.removeStore"), value: "store" },
      { title: t("menu.removeEverywhere"), value: "everywhere" },
      { title: t("menu.removeLocal"), value: "local" },
    ],
  }, cancel);
  if (!scope) return;
  let app: string | undefined;
  if (scope === "local") {
    const answer = await prompts({
      type: "select",
      name: "app",
      message: t("menu.removeApp"),
      hint: t("menu.selectInstructions"),
      choices: targets.map((target) => ({ title: `${target.id} · ${target.name}`, value: target.id })),
    }, cancel);
    app = answer.app;
    if (!app) return;
  }
  const entries: Array<{ id: string; app?: string; name?: string }> = app
    ? listRemovableProviders(app)
    : Object.values(loadStore().providers).map((provider) => ({ id: provider.id, name: provider.name }));
  if (!entries.length) {
    console.log(pc.dim(t("menu.noRemovable")));
    return;
  }
  const { selected } = await prompts({
    type: "select",
    name: "selected",
    message: t("menu.removeProvider"),
    hint: t("menu.selectInstructions"),
    choices: entries.map((entry, index) => ({
      title: `${entry.id} · ${entry.app ?? "agentsw"}${entry.name && entry.name !== entry.id ? ` · ${entry.name}` : ""}`,
      value: index,
    })),
  }, cancel);
  const picked = entries[selected];
  if (!picked) return;
  const opts = scope === "local" ? { apps: picked.app! } : { prune: scope === "everywhere" };
  await cmdRemoveProvider(picked.id, { ...opts, dryRun: true });
  const scopeLabel = picked.app ?? t(scope === "everywhere" ? "menu.removeEverywhere" : "menu.removeStore");
  if (await askToggle(t("menu.removeConfirmScope", { id: picked.id, scope: scopeLabel }))) {
    await cmdRemoveProvider(picked.id, opts);
  }
}

export async function cmdMenu(): Promise<void> {
  if (!loadStore().language) await chooseLanguage();
  console.log(pc.bold("agentsw") + pc.dim(t("menu.title")));
  if (Object.keys(loadStore().providers).length === 0) {
    console.log(pc.yellow(t("menu.noProviders")));
    if (await askToggle(t("menu.firstScan"), true)) await cmdImport({});
  }
  for (;;) {
    console.log("");
    const { action } = await prompts(
      {
        type: "select",
        name: "action",
        message: t("menu.what"),
        hint: t("menu.selectInstructions"),
        choices: [
          { title: t("menu.add"), value: "add" },
          { title: t("menu.quickAdd"), value: "quickAdd" },
          { title: t("menu.import"), value: "import" },
          { title: t("menu.use"), value: "use" },
          { title: t("menu.status"), value: "status" },
          { title: t("menu.list"), value: "list" },
          { title: t("menu.sync"), value: "sync" },
          { title: t("menu.discover"), value: "discover" },
          { title: t("menu.rename"), value: "rename" },
          { title: t("menu.remove"), value: "remove" },
          { title: t("menu.apps"), value: "apps" },
          { title: t("menu.installApp"), value: "install" },
          { title: t("menu.language"), value: "language" },
          { title: t("menu.quit"), value: "quit" },
        ],
      },
      cancel,
    );
    if (action === undefined || action === "quit") return;

    if (action === "quickAdd") {
      await cmdQuickAdd({});
    } else if (action === "add") {
      const { src } = await prompts(
        {
          type: "select",
          name: "src",
          message: t("menu.modelSource"),
          hint: t("menu.selectInstructions"),
          choices: [
            { title: t("menu.modelDiscover"), value: "discover" },
            { title: t("menu.modelManual"), value: "manual" },
          ],
        },
        cancel,
      );
      await cmdAdd({ discover: src === "discover" });
    } else if (action === "import") {
      await cmdImport({});
    } else if (action === "use") {
      const picked = await pickProvider(t("menu.pickProvider"));
      if (!picked) continue;
      const { model } = await prompts(
        {
          type: picked.models.length > 1 ? "select" : null,
          name: "model",
          message: t("menu.defaultModel"),
          hint: t("menu.selectInstructions"),
          choices: [
            { title: t("menu.keepDefault", { model: picked.defaultModel }), value: "" },
            ...picked.models.filter((m) => m !== picked.defaultModel).map((m) => ({ title: m, value: m })),
          ],
        },
        cancel,
      );
      await cmdUse(picked.id, { model: model || undefined });
    } else if (action === "status") {
      cmdStatus();
    } else if (action === "list") {
      cmdList();
    } else if (action === "sync") {
      await cmdSync({});
    } else if (action === "discover") {
      const picked = await pickProvider(t("menu.discoverFor"));
      if (!picked) continue;
      const sync = await askToggle(t("menu.pushRefresh"));
      await cmdDiscover(picked.id, { sync });
    } else if (action === "rename" || action === "remove") {
      try {
        if (action === "rename") await renameFromMenu();
        else await removeFromMenu();
      } catch (error) {
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
      }
    } else if (action === "apps") {
      await cmdApps();
      if (await askToggle(t("menu.upgrade"))) await cmdUpgrade([]);
    } else if (action === "install") {
      const installable = appPackages
        .filter((a) => !installedVersion(a) && appCommand(a, "install"))
        .map((a) => ({ title: `${a.id} · ${a.name}`, value: a.id }));
      if (installable.length === 0) {
        console.log(pc.dim(t("menu.allInstalled")));
        continue;
      }
      const { appId } = await prompts(
        {
          type: "select",
          name: "appId",
          message: t("menu.pickApp"),
          hint: t("menu.selectInstructions"),
          choices: installable,
        },
        cancel,
      );
      if (!appId) continue;
      await cmdInstall(appId);
    } else if (action === "language") {
      await chooseLanguage();
    }
  }
}

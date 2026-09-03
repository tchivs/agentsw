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
  cmdRemove,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";
import { getLocale, setLocale, t } from "./i18n.js";
import { loadStore, saveStore } from "./store.js";
import { appPackages, appCommand, installedVersion } from "./apps.js";
import type { Locale } from "./types.js";

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
    } else if (action === "remove") {
      const picked = await pickProvider(t("menu.removeProvider"));
      if (!picked) continue;
      if (!(await askToggle(t("menu.reallyRemove", { id: pc.bold(picked.id) })))) continue;
      const prune = await askToggle(t("menu.pruneConfigs"));
      await cmdRemove(picked.id, { prune });
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

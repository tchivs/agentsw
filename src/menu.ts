import pc from "picocolors";
import prompts from "prompts";
import {
  cmdAdd,
  cmdApps,
  cmdDiscover,
  cmdList,
  cmdRemove,
  cmdStatus,
  cmdSync,
  cmdUpgrade,
  cmdUse,
} from "./commands.js";
import { loadStore } from "./store.js";

function bye(): never {
  console.log(pc.dim("\nbye"));
  process.exit(0);
}

const cancel = { onCancel: () => bye() };

async function askToggle(message: string, initial = false): Promise<boolean> {
  const { v } = await prompts(
    { type: "toggle", name: "v", message, active: "yes", inactive: "no", initial },
    cancel,
  );
  return v === true;
}

/** select an existing provider; prints a hint and returns undefined when none configured */
async function pickProvider(message: string): Promise<{ id: string; defaultModel: string; models: string[] } | undefined> {
  const store = loadStore();
  const ids = Object.keys(store.providers);
  if (ids.length === 0) {
    console.log(pc.yellow('no providers configured yet — pick "add / update provider" first'));
    return undefined;
  }
  const { id } = await prompts(
    {
      type: "select",
      name: "id",
      message,
      choices: ids.map((pid) => {
        const p = store.providers[pid]!;
        return {
          title: `${pid} · ${p.protocol} · default ${p.defaultModel}${store.active === pid ? "  (active)" : ""}`,
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
  console.log(pc.bold("smart-switch") + pc.dim(" · interactive menu — Ctrl+C quits, ↑/↓ selects"));
  for (;;) {
    console.log("");
    const { action } = await prompts(
      {
        type: "select",
        name: "action",
        message: "what to do?",
        choices: [
          { title: "add / update provider   (id · protocol · base URL · API key)", value: "add" },
          { title: "switch provider         (use and sync into app configs)", value: "use" },
          { title: "status                  (what each app currently points at)", value: "status" },
          { title: "list providers", value: "list" },
          { title: "sync active provider    (re-apply to app configs)", value: "sync" },
          { title: "discover models         (refresh a provider's list + metadata)", value: "discover" },
          { title: "remove provider", value: "remove" },
          { title: "agent versions          (check installed CLIs / upgrade)", value: "apps" },
          { title: "quit", value: "quit" },
        ],
      },
      cancel,
    );
    if (action === undefined || action === "quit") return;

    if (action === "add") {
      const { src } = await prompts(
        {
          type: "select",
          name: "src",
          message: "how to fill the model list?",
          choices: [
            { title: "discover from the provider's /v1/models (recommended)", value: "discover" },
            { title: "type model ids manually", value: "manual" },
          ],
        },
        cancel,
      );
      await cmdAdd({ discover: src === "discover" });
    } else if (action === "use") {
      const picked = await pickProvider("switch to provider");
      if (!picked) continue;
      const { model } = await prompts(
        {
          type: picked.models.length > 1 ? "select" : null,
          name: "model",
          message: "default model",
          choices: [
            { title: `keep current default (${picked.defaultModel})`, value: "" },
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
      const picked = await pickProvider("discover models for");
      if (!picked) continue;
      const sync = await askToggle("push the refreshed provider into app configs?");
      await cmdDiscover(picked.id, { sync });
    } else if (action === "remove") {
      const picked = await pickProvider("remove provider");
      if (!picked) continue;
      if (!(await askToggle(`really remove ${pc.bold(picked.id)}?`))) continue;
      const prune = await askToggle("also remove its entries from app configs?");
      await cmdRemove(picked.id, { prune });
    } else if (action === "apps") {
      await cmdApps();
      if (await askToggle("upgrade everything outdated?")) await cmdUpgrade([]);
    }
  }
}

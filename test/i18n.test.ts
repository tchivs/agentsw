import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSystemLocale,
  extractCliLocale,
  getLocale,
  normalizeLocale,
  setLocale,
  t,
} from "../src/i18n.js";

const original = getLocale();
after(() => setLocale(original));

test("locale normalization accepts common English and Chinese forms", () => {
  assert.equal(normalizeLocale("zh_CN.UTF-8"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hant-TW"), "zh-CN");
  assert.equal(normalizeLocale("en_US.UTF-8"), "en");
  assert.equal(normalizeLocale("C"), "en");
  assert.equal(normalizeLocale("fr-FR"), undefined);
});

test("system and CLI locale detection follow explicit inputs", () => {
  assert.equal(detectSystemLocale({ LANG: "zh_CN.UTF-8" }), "zh-CN");
  assert.equal(detectSystemLocale({ LC_ALL: "en_GB.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(extractCliLocale(["status", "--lang", "zh-CN"]), "zh-CN");
  assert.equal(extractCliLocale(["--lang=en", "status"]), "en");
});

test("translations switch language and interpolate values", () => {
  setLocale("en");
  assert.equal(t("import.modelsCount", { count: 3 }), "3 models");
  setLocale("zh-CN");
  assert.equal(t("import.modelsCount", { count: 3 }), "3 个模型");
  assert.match(t("menu.import"), /导入已有供应商/);
});

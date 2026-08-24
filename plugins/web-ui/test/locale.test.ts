import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("zh dict covers all 17 mini-lit required keys", async () => {
  const { ZH_CN } = await import("../src/locale/zh-cn.ts");
  const REQUIRED = ["*","Copy","Copy code","Copied!","Download","Close","Preview","Code","Loading...","Select an option","Mode 1","Mode 2","Required","Optional","Input Required","Cancel","Confirm"];
  for (const key of REQUIRED) assert.ok(ZH_CN[key], `missing required key: ${key}`);
});

test("tr() falls back to the english key when the key is missing instead of throwing", async () => {
  const { tr } = await import("../src/locale/index.ts");
  assert.equal(tr("Definitely Missing Key")(42), "Definitely Missing Key");
});

test("i18n() does not throw in a bare-node environment without localStorage", async () => {
  const { i18n } = await import("../src/locale/index.ts");
  assert.equal(i18n("Send"), "Send");
});

test("setupLocale re-registers zh after a foreign setTranslations wipe", async () => {
  const { setTranslations, getTranslations, defaultEnglish, defaultGerman } = await import("@mariozechner/mini-lit");
  const { setupLocale } = await import("../src/locale/index.ts");
  setTranslations({ en: defaultEnglish, de: defaultGerman } as unknown as Parameters<typeof setTranslations>[0]);
  setupLocale();
  assert.ok(getTranslations().zh, "zh must be registered after setupLocale");
});

test("entry evaluates pi-web-ui's i18n module before setupLocale merges zh", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(main.indexOf('import "pi-web-ui-i18n"') !== -1, "main.ts must statically import pi-web-ui-i18n");
  assert.ok(
    main.indexOf('import "pi-web-ui-i18n"') < main.indexOf("setupLocale()"),
    "pi-web-ui's top-level setTranslations must run before setupLocale()",
  );
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(
    vite,
    /find: "pi-web-ui-i18n", replacement: here\("node_modules\/@earendil-works\/pi-web-ui\/dist\/utils\/i18n\.js"\)/,
  );
});

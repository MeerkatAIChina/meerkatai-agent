import { test } from "node:test";
import assert from "node:assert/strict";

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

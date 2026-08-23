import { JSDOM } from "jsdom";

if (typeof globalThis.document === "undefined") {
  Object.defineProperty(globalThis, "document", { configurable: true, value: new JSDOM("").window.document });
}
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => "zh", setItem: () => {} },
});

export async function activateZh(): Promise<void> {
  const { getTranslations, setTranslations } = await import("@mariozechner/mini-lit");
  const { ZH_CN } = await import("../src/locale/zh-cn.ts");
  const zh = ZH_CN as unknown as Parameters<typeof setTranslations>[0]["en"];
  setTranslations({ ...getTranslations(), zh });
}

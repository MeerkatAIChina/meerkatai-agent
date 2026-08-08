import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../../../src/config.ts";
import { buildApp } from "../../../src/wiring.ts";
import { createInsecureTestServer } from "../../../src/api/server.ts";

const GITHUB_URL = "https://github.com/MeerkatAIChina/meerkat-skills-triz.git";
const localStaging = new URL("../../../skill-pack-staging", import.meta.url).pathname;
const PACK_URL = process.env.PACK_URL ?? localStaging;
const CLASSIFIER_URL = process.env.CLASSIFIER_URL ?? "http://localhost:8080/classify";
const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };

const headSha = execFileSync("git", ["ls-remote", PACK_URL, "main"]).toString().split(/\s+/)[0]!;
console.log(`pack source: ${PACK_URL}`);
console.log(`source HEAD: ${headSha} (github: ${GITHUB_URL})`);

const built = buildApp({
  ...loadConfig({}),
  port: 0,
  dataDir: mkdtempSync(join(tmpdir(), "meerkat-e2e-")),
  pluginSkillDirs: [],
  connectorSecretKey: "dev-connector-key",
  capabilitySecret: "dev-capability-key",
  classifierUrl: CLASSIFIER_URL,
});

const server = createInsecureTestServer(built.app, {
  admin: built.admin,
  auditLog: built.auditLog,
  sessions: built.sessions,
  errors: built.errors,
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
console.log(`core listening: ${base}`);

const json = async (r: Response): Promise<any> => {
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
};

const reg = await json(
  await fetch(`${base}/v1/admin/skill-packs`, {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ url: PACK_URL, ref: "main", trustTier: "internal", subset: "all" }),
  }),
);
const packId = reg.pack.id as string;
console.log(`registered pack ${packId}: available=${reg.pack.available} syncMode=${reg.pack.syncMode} scope=${reg.pack.targetScopeId}`);

const catalog = await json(await fetch(`${base}/v1/admin/skill-packs/${packId}/catalog`, { headers: ADMIN }));
console.log(`catalog counts: ${JSON.stringify(catalog.counts)}`);

const imp = await json(
  await fetch(`${base}/v1/admin/skill-packs/${packId}/import`, {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ selected: "all" }),
  }),
);
console.log(`imported: ${JSON.stringify(imp.imported.sort())}`);
console.log(`import counts: ${JSON.stringify(imp.counts)}`);

const skills = await json(await fetch(`${base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
const triz = skills.skills.filter((k: any) => k.name.startsWith("triz-"));
for (const k of triz) console.log(`skill ${k.name}: status=${k.status}`);
const packs = await json(await fetch(`${base}/v1/admin/skill-packs`, { headers: ADMIN }));
const mine = packs.packs.find((p: any) => p.id === packId);
console.log(`pack lastImport: commit=${mine?.lastImport?.commit ?? "-"} status=${mine?.lastImport?.status ?? "-"}`);
const commitMatches = mine?.lastImport?.commit === headSha;
const allPublished = triz.length === 8 && triz.every((k: any) => k.status === "published") && commitMatches;
console.log(`8 skills published and import commit matches source HEAD: ${allPublished}`);

const turn = async (text: string, threadRef: string) =>
  json(
    await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "battery",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef },
        text,
      }),
    }),
  );

const trizTurn = await turn("帮我用矛盾矩阵分析一下这个产品的技术矛盾", "dm:U1:triz");
console.log(`triz turn: status=${trizTurn.status} reply=${JSON.stringify(trizTurn.reply ?? "").slice(0, 60)}`);

const piiTurn = await turn("我的身份证号是 320102199001011234，帮我存一下", "dm:U1:pii");
console.log(`pii turn: status=${piiTurn.status}`);

const events = await built.auditLog.events();
for (const e of events.filter((x) => x.action.startsWith("classifier."))) {
  console.log(`audit ${e.action}: resource=${e.resource} status=${e.status ?? "-"} detail=${e.detail ?? "-"}`);
}

const pin = built.config.getRuntimeSelection("personal:U1" as any);
console.log(`pin on personal:U1: ${JSON.stringify(pin)}`);

await new Promise<void>((r) => server.close(() => r()));
process.exit(allPublished ? 0 : 1);

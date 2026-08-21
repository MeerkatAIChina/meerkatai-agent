import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../../../../src/config.ts";
import { buildApp } from "../../../../../src/wiring.ts";
import { createInsecureTestServer } from "../../../../../src/api/server.ts";

process.env.ORG_ID = "meerkat";

const COMMIT_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADMIN = { "x-admin-actor": "admin-alice@meerkat", "content-type": "application/json" };

const dataDir = mkdtempSync(join(tmpdir(), "meerkat-verify6-"));
const snap = mkdtempSync(join(tmpdir(), "meerkat-verify6-snap-"));
mkdirSync(join(snap, "skills", "triz-demo"), { recursive: true });
writeFileSync(
  join(snap, "skills", "triz-demo", "SKILL.md"),
  "---\nname: triz-demo\ndescription: d\nscope: company\n---\n# Body\n",
);
const writeMeta = (commit: string) =>
  writeFileSync(
    join(snap, ".skillpack-meta.json"),
    JSON.stringify({ upstreamUrl: "https://upstream.invalid/repo.git", ref: "main", commit, snapshotAt: "2026-08-20T00:00:00Z" }),
  );
writeMeta(COMMIT_1);

const built = buildApp({
  ...loadConfig({}),
  port: 0,
  dataDir,
  allowLocalSkillPacks: true,
  sessionStore: "sqlite",
  sqlitePath: join(dataDir, "meerkat.db"),
  harness: "mock",
  connectorSecretKey: "dev-connector-key",
  capabilitySecret: "dev-capability-key",
});
const server = createInsecureTestServer(built.app, {
  admin: built.admin,
  auditLog: built.auditLog,
  sessions: built.sessions,
  errors: built.errors,
  allowLocalSkillPacks: true,
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: ADMIN,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const reg = await call("POST", "/v1/admin/skill-packs", {
  url: snap,
  ref: "main",
  allowLocal: true,
  trustTier: "internal",
  subset: "all",
  upstreamUrl: "https://upstream.invalid/repo.git",
});
if (reg.status !== 200) fail(`register: ${JSON.stringify(reg.body)}`);
const packId = reg.body.pack.id;
if (reg.body.pack.upstreamUrl !== "https://upstream.invalid/repo.git") fail("upstreamUrl not stored");

const imp = await call("POST", `/v1/admin/skill-packs/${packId}/import`, { selected: "all" });
if (imp.status !== 200) fail(`local snapshot import: ${JSON.stringify(imp.body)}`);
console.log("local snapshot import ok (no git, no network)");

const t0 = Date.now();
const syncFail = await call("POST", `/v1/admin/skill-packs/${packId}/sync`, { onlyIfUpdate: true });
const elapsed = Date.now() - t0;
if (syncFail.status === 200) fail("sync against an unreachable upstream must fail");
if (elapsed > 20_000) fail(`sync took ${elapsed}ms — looks like retry/backoff, want a single attempt`);
const afterFail = await call("GET", "/v1/admin/skill-packs");
const packAfterFail = afterFail.body.packs.find((p) => p.id === packId);
if (packAfterFail.lastImport?.status !== "error") fail("failed sync must record an error");
if (packAfterFail.lastImport?.commit !== COMMIT_1) fail(`commit clobbered: ${packAfterFail.lastImport?.commit}`);
console.log(`unreachable upstream: single fast failure (${elapsed}ms), last good commit preserved`);

const local = await call("POST", "/v1/admin/skill-packs", {
  url: snap,
  ref: "main",
  allowLocal: true,
  trustTier: "internal",
  subset: "all",
});
const localId = local.body.pack.id;
await call("POST", `/v1/admin/skill-packs/${localId}/import`, { selected: "all" });
const skip = await call("POST", `/v1/admin/skill-packs/${localId}/sync`, { onlyIfUpdate: true });
if (skip.body.upToDate !== true) fail(`expected upToDate skip, got ${JSON.stringify(skip.body)}`);
console.log("onlyIfUpdate skips the fetch when the snapshot is unchanged");

writeMeta(COMMIT_2);
const bumped = await call("POST", `/v1/admin/skill-packs/${localId}/sync`, { onlyIfUpdate: true });
if (bumped.status !== 200 || bumped.body.upToDate === true) fail("bumped snapshot commit must trigger a re-import");
const afterBump = await call("GET", "/v1/admin/skill-packs");
if (afterBump.body.packs.find((p) => p.id === localId).lastImport?.commit !== COMMIT_2) fail("commit not advanced");
console.log("bumped snapshot commit re-imports and advances lastImport");

server.close();
await built.runtime.stop();
rmSync(dataDir, { recursive: true, force: true });
rmSync(snap, { recursive: true, force: true });
console.log("PASS: issue #6 core flows verified");

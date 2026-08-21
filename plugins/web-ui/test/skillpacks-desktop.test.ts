import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const META_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const payload = mkdtempSync(join(tmpdir(), "meerkat-payload-"));
mkdirSync(join(payload, "config", "seeds"), { recursive: true });
mkdirSync(join(payload, "skillpacks", "triz", "skills", "demo"), { recursive: true });
writeFileSync(
  join(payload, "skillpacks", "triz", ".skillpack-meta.json"),
  JSON.stringify({ upstreamUrl: "https://github.com/org/triz.git", ref: "main", commit: META_COMMIT, snapshotAt: "2026-08-20T00:00:00Z" }),
);
writeFileSync(join(payload, "skillpacks", "triz", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
writeFileSync(
  join(payload, "config", "seeds", "skillpacks.json"),
  JSON.stringify({
    packs: [
      { name: "triz", url: "skillpacks/triz", upstreamUrl: "https://github.com/org/triz.git", ref: "main", local: true },
    ],
  }),
);

interface PackState {
  id: string;
  url: string;
  upstreamUrl?: string;
  local?: boolean;
  lastImport?: { at: number; commit: string; status: string };
}
const state: { packs: PackState[]; registers: unknown[]; imports: string[]; syncs: unknown[]; patches: unknown[] } = {
  packs: [],
  registers: [],
  imports: [],
  syncs: [],
  patches: [],
};

const core = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const u = new URL(req.url ?? "/", "http://core");
    const send = (obj: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/v1/admin/whoami") return send({ isAdmin: true });
    if (u.pathname === "/v1/admin/skill-packs" && req.method === "GET") return send({ packs: state.packs });
    if (u.pathname === "/v1/admin/skill-packs" && req.method === "POST") {
      state.registers.push(body);
      const pack: PackState = { id: "p1", url: String(body.url), ...(body.upstreamUrl ? { upstreamUrl: String(body.upstreamUrl) } : {}) };
      state.packs = [pack];
      return send({ pack });
    }
    const m = u.pathname.match(/^\/v1\/admin\/skill-packs\/([^/]+)(?:\/(import|sync))?$/);
    if (m && req.method === "PATCH") {
      state.patches.push(body);
      const cur = state.packs[0];
      state.packs = [{ ...cur, ...(body as object) } as PackState];
      return send({ pack: state.packs[0] });
    }
    if (m && m[2] === "import") {
      state.imports.push(m[1]);
      state.packs = [{ ...state.packs[0], lastImport: { at: 1, commit: META_COMMIT, status: "ok" } }];
      return send({ imported: ["demo"], updated: [], skipped: [], archived: [], counts: {} });
    }
    if (m && m[2] === "sync") {
      state.syncs.push(body);
      return send({ imported: [], updated: [], skipped: [], archived: [], counts: {}, upToDate: true });
    }
    send({});
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "skillpacks-desktop-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.MEERKAT_DESKTOP = "1";
process.env.MEERKAT_SEEDS_DIR = join(payload, "config", "seeds");

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
  rmSync(payload, { recursive: true, force: true });
});

const waitFor = async (phase: string, token: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await fetch(`${base}/api/desktop/skill-packs/status`, {
      headers: { [PORTAL_IDENTITY_HEADER]: token },
    });
    const body = (await r.json()) as { packs?: Array<Record<string, unknown>> };
    const pack = body.packs?.find((p) => p.name === "triz");
    if (pack?.phase === phase) return pack;
    if (Date.now() > deadline) throw new Error(`timed out waiting for phase ${phase}; last: ${JSON.stringify(body)}`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
};

test("first boot: resolves the relative seed url, registers with upstreamUrl, imports, syncs once", async () => {
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  const pack = await waitFor("ready", token);
  assert.equal(pack.phase, "ready");
  assert.equal(state.registers.length, 1);
  const reg = state.registers[0] as Record<string, unknown>;
  assert.equal(reg.allowLocal, true);
  assert.equal(reg.upstreamUrl, "https://github.com/org/triz.git");
  assert.ok(String(reg.url).endsWith(join("skillpacks", "triz")), `absolute snapshot path, got ${reg.url}`);
  assert.ok(String(reg.url).startsWith(payload), "relative seed url resolved against the payload root");
  assert.equal(state.imports.length, 1);
  assert.ok(state.syncs.length >= 1, "single-shot upstream sync ran");
  assert.equal((state.syncs[0] as Record<string, unknown>).onlyIfUpdate, true);
});

test("second boot: import skipped when lastImport matches the snapshot commit, sync still runs once", async () => {
  const before = state.imports.length;
  const syncsBefore = state.syncs.length;
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/api/desktop/skill-packs/retry`, {
    method: "POST",
    headers: { [PORTAL_IDENTITY_HEADER]: token },
  });
  assert.equal(r.status, 200);
  await waitFor("ready", token);
  assert.equal(state.imports.length, before, "no re-import of an unchanged snapshot");
  assert.ok(state.syncs.length >= syncsBefore + 1, "retry runs the update channel once more");
});

test("reinstalled payload path: refreshes the stale pack url via patch, no re-register, import skipped", async () => {
  const registersBefore = state.registers.length;
  const importsBefore = state.imports.length;
  const patchesBefore = state.patches.length;
  state.packs = [
    {
      id: "p0",
      url: join(payload, "old-install", "skillpacks", "triz"),
      upstreamUrl: "https://github.com/org/triz.git",
      local: true,
      lastImport: { at: 0, commit: META_COMMIT, status: "ok" },
    },
  ];
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/api/desktop/skill-packs/retry`, {
    method: "POST",
    headers: { [PORTAL_IDENTITY_HEADER]: token },
  });
  assert.equal(r.status, 200);
  const deadline = Date.now() + 15_000;
  while (state.patches.length === patchesBefore) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the path refresh patch");
    await new Promise((r2) => setTimeout(r2, 100));
  }
  await waitFor("ready", token);
  assert.equal(state.registers.length, registersBefore, "no re-register of an already-migrated pack");
  assert.equal(state.imports.length, importsBefore, "snapshot commit matches, import skipped");
  assert.equal(state.patches.length, patchesBefore + 1, "one path refresh patch");
  const patch = state.patches[state.patches.length - 1] as Record<string, unknown>;
  assert.ok(String(patch.url).endsWith(join("skillpacks", "triz")), `refreshed to the resolved snapshot path, got ${patch.url}`);
  assert.ok(String(patch.url).startsWith(payload), "refresh targets the current payload root");
  assert.equal(patch.local, true);
});

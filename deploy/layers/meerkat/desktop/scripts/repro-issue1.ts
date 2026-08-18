import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), "../payload");
const CORE_PORT = 18093;
const DATA_DIR = process.env.REPRO_DATA_DIR ?? mkdtempSync(join(tmpdir(), "meerkat-task15-"));
const EPHEMERAL = !process.env.REPRO_DATA_DIR;
const SIGN = randomBytes(32).toString("hex");
const NODE = join(PAYLOAD, "node", "node.exe");

const secrets = {
  CAPABILITY_SECRET: randomBytes(32).toString("hex"),
  CONNECTOR_SECRET_KEY: randomBytes(32).toString("hex"),
  CORE_SIGNING_SECRET: SIGN,
  PORTAL_IDENTITY_SECRET: randomBytes(32).toString("hex"),
  SKILL_SIGNING_SECRET: randomBytes(32).toString("hex"),
};

function mintPortal(p: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ p, exp: Date.now() + 3_600_000 }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
const PORTAL_TOK = mintPortal("meerkat-desktop", secrets.PORTAL_IDENTITY_SECRET);

const core: ChildProcess = spawn(NODE, ["dist/index.mjs"], {
  cwd: join(PAYLOAD, "core"),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HARNESS: "pi",
    ORG_ID: "meerkat",
    HOST: "127.0.0.1",
    PORT: String(CORE_PORT),
    DATA_DIR,
    SANDBOX_BACKEND: "none",
    SESSION_STORE: "sqlite",
    CLASSIFIER_FALLBACK_MODEL: "Meerkat-TRIZ-v1",
    CLASSIFIER_FALLBACK_HARNESS: "pi",
    ALLOW_LOCAL_SKILL_PACKS: "1",
    ADMIN_GRANTS: "meerkat-desktop:org_admin",
    ...secrets,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
core.stdout?.on("data", (d: Buffer) => process.stdout.write(`[core] ${d}`));
core.stderr?.on("data", (d: Buffer) => process.stdout.write(`[core!] ${d}`));

async function main() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CORE_PORT}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tryCreate = async (label: string, payload: Record<string, unknown>) => {
    const path = "/v1/skills";
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${createHmac("sha256", SIGN).update(`v0:${ts}:POST\n${path}\n${body}`).digest("hex")}`;
    const res = await fetch(`http://127.0.0.1:${CORE_PORT}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": sig,
        "x-portal-identity": PORTAL_TOK,
      },
      body,
    });
    console.log(`${label} ->`, res.status, (await res.text()).slice(0, 300));
  };

  const base = { principalId: "meerkat-desktop", description: "repro for issue 1", body: "# repro\n\nhello" };
  await tryCreate("no scopeId", { ...base, name: "repro-a" });
  await tryCreate("personal scopeId", { ...base, name: "repro-b", scopeId: "personal:meerkat-desktop" });
  await tryCreate("org scopeId", { ...base, name: "repro-c", scopeId: "org:meerkat" });
}

async function cleanup() {
  const listPath = "/v1/skills?principalId=meerkat-desktop";
  const ts0 = Math.floor(Date.now() / 1000);
  const sig0 = `v0=${createHmac("sha256", SIGN).update(`v0:${ts0}:GET\n${listPath}\n`).digest("hex")}`;
  const listRes = await fetch(`http://127.0.0.1:${CORE_PORT}${listPath}`, {
    headers: { "x-timestamp": String(ts0), "x-signature": sig0, "x-portal-identity": PORTAL_TOK },
  });
  const listed = (await listRes.json().catch(() => null)) as { skills?: Array<{ id: string; name: string }> } | null;
  const targets = (listed?.skills ?? []).filter((s) => ["repro-a", "repro-b"].includes(s.name));
  for (const target of targets) {
    const path = `/v1/skills/${target.id}`;
    const body = JSON.stringify({ principalId: "meerkat-desktop" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v0=${createHmac("sha256", SIGN).update(`v0:${ts}:DELETE\n${path}\n${body}`).digest("hex")}`;
    const res = await fetch(`http://127.0.0.1:${CORE_PORT}${path}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": sig,
        "x-portal-identity": PORTAL_TOK,
      },
      body,
    });
    console.log(`cleanup ${target.name} ->`, res.status);
  }
}

main()
  .catch((e) => {
    console.error("repro failed:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    const done = () => {
      core.kill();
      if (EPHEMERAL) setTimeout(() => rmSync(DATA_DIR, { recursive: true, force: true }), 1500).unref();
    };
    if (EPHEMERAL) {
      setTimeout(done, 500).unref();
    } else {
      setTimeout(() => void cleanup().finally(() => setTimeout(done, 500).unref()), 500).unref();
    }
  });

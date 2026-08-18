import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), "../payload");
const CORE_PORT = 18091;
const DATA_DIR = mkdtempSync(join(tmpdir(), "meerkat-task14-"));
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

const core: ChildProcess = spawn(
  NODE,
  ["dist/index.mjs"],
  {
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
  },
);
core.stdout?.on("data", (d: Buffer) => process.stdout.write(`[core] ${d}`));
core.stderr?.on("data", (d: Buffer) => process.stdout.write(`[core!] ${d}`));

function signed(method: string, path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = `v0=${createHmac("sha256", SIGN).update(`v0:${ts}:${method}\n${path}\n${body}`).digest("hex")}`;
  return { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sig, "x-portal-identity": PORTAL_TOK };
}

async function call(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${CORE_PORT}${path}`, {
    method,
    headers: signed(method, path, raw),
    ...(raw ? { body: raw } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CORE_PORT}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  const seedsDir = join(PAYLOAD, "config", "seeds");
  const tensoris = JSON.parse(readFileSync(join(seedsDir, "providers.tensoris.json"), "utf8"));
  const localSecure = JSON.parse(readFileSync(join(seedsDir, "providers.local-secure.json"), "utf8"));
  const defaults = JSON.parse(readFileSync(join(seedsDir, "defaults.json"), "utf8"));

  let r = await call("PUT", `/v1/admin/custom-providers/${tensoris.id}`, {
    name: tensoris.name,
    protocol: tensoris.protocol,
    baseUrl: tensoris.baseUrl,
    models: tensoris.models,
    apiKey: "sk-637067a1ee237dc63b8813e7967afd2adb64e1a7c26d22e247c57b33d28477f3",
  });
  console.log("register tensoris:", r.status, JSON.stringify(r.body).slice(0, 200));

  r = await call("PUT", `/v1/admin/custom-providers/${localSecure.id}`, {
    name: localSecure.name,
    protocol: localSecure.protocol,
    baseUrl: "http://47.117.35.137:18000/v1",
    models: localSecure.models,
    apiKey: "e5424278969ae3d54583f5472d14450e7ef06fd9ff5a83e9d68948bf26a48c41",
    validate: false,
  });
  console.log("register local-secure:", r.status, JSON.stringify(r.body).slice(0, 200));

  r = await call("PUT", "/v1/admin/scopes/org:meerkat/base-model", { modelId: defaults.defaultModelId });
  console.log("base-model:", r.status);

  r = await call("PUT", "/v1/admin/scopes/org:meerkat/webui-models", { ids: defaults.webuiModels });
  console.log("webui-models:", r.status, JSON.stringify(r.body).slice(0, 200));

  r = await call("GET", "/v1/runtime-config?principalId=meerkat-desktop&scopeId=personal:meerkat-desktop");
  console.log("runtime-config:", r.status);
  const cfg = r.body as {
    modelsByHarness?: Record<string, Array<{ id?: string; modelId?: string } | string>>;
    modelCatalog?: Array<{ id?: string; modelId?: string; label?: string; name?: string }>;
    effective?: { modelId?: string };
  } | null;
  const piModels = cfg?.modelsByHarness?.pi ?? [];
  const ids = piModels.map((m) => (typeof m === "string" ? m : (m.id ?? m.modelId ?? "?")));
  console.log("modelsByHarness.pi ids:", JSON.stringify(ids));
  const catalogRaw = cfg?.modelCatalog;
  const catalogIds = Array.isArray(catalogRaw)
    ? catalogRaw.map((m) => {
        const rec = m as { id?: string; modelId?: string };
        return rec.id ?? rec.modelId ?? "?";
      })
    : catalogRaw && typeof catalogRaw === "object"
      ? Object.keys(catalogRaw as Record<string, unknown>)
      : [];
  console.log("modelCatalog ids:", JSON.stringify(catalogIds));
  console.log("effective.modelId:", cfg?.effective?.modelId);
  const trizInPicker = ids.includes("Meerkat-TRIZ-v1");
  const trizInCatalog = catalogIds.includes("Meerkat-TRIZ-v1");
  console.log(`RESULT picker=${trizInPicker ? "PASS" : "FAIL"} catalog=${trizInCatalog ? "PASS" : "FAIL"}`);
}

main()
  .catch((e) => {
    console.error("verify failed:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    core.kill();
    setTimeout(() => rmSync(DATA_DIR, { recursive: true, force: true }), 1500).unref();
  });

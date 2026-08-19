import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../../../../src/config.ts";
import { buildApp } from "../../../../../src/wiring.ts";
import { createInsecureTestServer } from "../../../../../src/api/server.ts";

const mode = process.argv[2];
const dataDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "meerkat-verify5-"));
const THREAD = "web:meerkat-desktop:verify-issue5";

const built = buildApp({
  ...loadConfig({}),
  port: 0,
  dataDir,
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
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const sendTurn = async (text: string) => {
  const res = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface: "battery",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: THREAD },
      text,
    }),
  });
  return { status: res.status, body: await res.text() };
};

if (mode === "plant") {
  const first = await sendTurn("hello");
  console.log(`first turn: http=${first.status} body=${first.body.slice(0, 200)}`);
  const session = await built.sessions.getByThread(THREAD);
  if (!session) throw new Error("session was not created by the first turn");
  const { lease } = await built.sessions.acquireLease(session.id, "turn");
  if (!lease) throw new Error("failed to plant the stale lease");
  console.log(`planted stale turn lease on session ${session.id}; killing process without release`);
  process.exit(0);
}

if (mode === "retry") {
  const attempt = await sendTurn("are you there?");
  console.log(`retry turn: http=${attempt.status} body=${attempt.body.slice(0, 300)}`);
  const busy = attempt.body.includes("session busy");
  console.log(busy ? "VERIFY-ISSUE5: FAIL (session still busy after restart)" : "VERIFY-ISSUE5: PASS (turn accepted after restart)");
  process.exit(busy ? 1 : 0);
}

console.error("usage: verify-issue5.ts plant|retry [dataDir]");
process.exit(2);

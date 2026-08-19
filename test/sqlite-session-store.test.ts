import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createSqliteSessionStore } from "../src/sessions/sqlite-session-store.ts";
import { scopeId } from "../src/types.ts";
import { runSessionStoreContract } from "./support/session-store-contract.ts";

const dir = mkdtempSync(join(tmpdir(), "qm-sqlite-session-test-"));

const stores: Array<{ close(): void }> = [];
let seq = 0;

runSessionStoreContract("sqlite", (opts) => {
  const store = createSqliteSessionStore(join(dir, `test-${process.pid}-${seq++}.db`), opts);
  stores.push(store);
  return store;
});

test("sqlite: a lease left behind by a dead process is cleared at open", async () => {
  const file = join(dir, `restart-${process.pid}-${seq++}.db`);
  const killed = createSqliteSessionStore(file);
  const s = await killed.getOrCreateByThread("web:meerkat-desktop:t1", "channel", scopeId("org", "meerkat"));
  const { lease } = await killed.acquireLease(s.id, "turn");
  assert.ok(lease);
  killed.close();

  const restarted = createSqliteSessionStore(file);
  stores.push(restarted);
  const attempt = await restarted.acquireLease(s.id, "turn");
  assert.ok(attempt.lease, "the stale lease from the killed process no longer blocks the session");
});

after(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

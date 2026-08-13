import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createSqliteSessionStore } from "../src/sessions/sqlite-session-store.ts";
import { runSessionStoreContract } from "./support/session-store-contract.ts";

const dir = mkdtempSync(join(tmpdir(), "qm-sqlite-session-test-"));

const stores: Array<{ close(): void }> = [];
let seq = 0;

runSessionStoreContract("sqlite", (opts) => {
  const store = createSqliteSessionStore(join(dir, `test-${process.pid}-${seq++}.db`), opts);
  stores.push(store);
  return store;
});

after(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

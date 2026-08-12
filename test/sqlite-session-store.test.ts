import { readdirSync, rmSync } from "node:fs";
import { after } from "node:test";
import { createSqliteSessionStore } from "../src/sessions/sqlite-session-store.ts";
import { runSessionStoreContract } from "./support/session-store-contract.ts";

function cleanupFiles(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

for (const f of readdirSync("./data")) {
  if (/^test-sqlite-session-.*\.db(-wal|-shm)?$/.test(f)) rmSync(`./data/${f}`, { force: true });
}

const stores: Array<{ close(): void }> = [];
const paths: string[] = [];

runSessionStoreContract("sqlite", (opts) => {
  const path = `./data/test-sqlite-session-${process.pid}-${paths.length}.db`;
  cleanupFiles(path);
  paths.push(path);
  const store = createSqliteSessionStore(path, opts);
  stores.push(store);
  return store;
});

after(() => {
  for (const s of stores) s.close();
  for (const p of paths) cleanupFiles(p);
});

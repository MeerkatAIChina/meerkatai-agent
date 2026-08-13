import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function cleanupFiles(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

mkdirSync("./data", { recursive: true });
for (const f of readdirSync("./data")) {
  if (/^test-sqlite-wiring-.*\.db(-wal|-shm)?$/.test(f)) rmSync(`./data/${f}`, { force: true });
}

function wiringPath(tag: string): string {
  return `./data/test-sqlite-wiring-${tag}-${process.pid}.db`;
}

test("config: SESSION_STORE=sqlite selects sqlite and resolves SQLITE_PATH", () => {
  const cfg = loadConfig({ SESSION_STORE: "sqlite", SQLITE_PATH: "./data/custom.db" });
  assert.equal(cfg.sessionStore, "sqlite");
  assert.equal(cfg.sqlitePath, resolve("./data/custom.db"));
});

test("config: SESSION_STORE=sqlite defaults SQLITE_PATH to <dataDir>/meerkat.db", () => {
  const cfg = loadConfig({ SESSION_STORE: "sqlite", DATA_DIR: "./data/wiring-default" });
  assert.equal(cfg.sessionStore, "sqlite");
  assert.equal(cfg.sqlitePath, resolve(join("./data/wiring-default", "meerkat.db")));
});

test("config: memory and postgres session stores carry no sqlitePath", () => {
  const memory = loadConfig({});
  assert.equal(memory.sessionStore, "memory");
  assert.equal(memory.sqlitePath, undefined);
  const postgres = loadConfig({ SESSION_STORE: "postgres", DATABASE_URL: "postgres://localhost/test" });
  assert.equal(postgres.sessionStore, "postgres");
  assert.equal(postgres.sqlitePath, undefined);
});

test("config: RUN_STORE=sqlite and ARTIFACT_STORE=sqlite no longer throw; runStore stays memory", () => {
  const cfg = loadConfig({ RUN_STORE: "sqlite", ARTIFACT_STORE: "sqlite" });
  assert.equal(cfg.sessionStore, "memory");
  assert.equal(cfg.runStore, "memory");
});

test("config: SESSION_STORE=sqlite rejects a simultaneous DATABASE_URL (sessions and locks must share one backend)", () => {
  assert.throws(
    () => loadConfig({ SESSION_STORE: "sqlite", DATABASE_URL: "postgres://localhost/test" }),
    /SESSION_STORE=sqlite cannot be combined with DATABASE_URL/,
  );
});

test("SESSION_STORE=sqlite wires SQLite-backed session + artifact stores on the same file", async () => {
  const path = wiringPath("same-file");
  cleanupFiles(path);
  const apps: BuiltApp[] = [];
  try {
    const envCfg = loadConfig({ SESSION_STORE: "sqlite", SQLITE_PATH: path });
    const cfg = testConfig({
      sessionStore: envCfg.sessionStore,
      ...(envCfg.sqlitePath ? { sqlitePath: envCfg.sqlitePath } : {}),
    });
    const app1 = buildApp(cfg);
    apps.push(app1);
    const scope = "personal:U1";
    const s = await app1.sessions.getOrCreateByThread("t1", "dm", scope as never);
    await app1.sessions.updateTitle(s.id, "persisted");
    await app1.sessionLockStore.put("lock1", { harnessId: "pi", modelId: "m1" });

    const app2 = buildApp(cfg);
    apps.push(app2);
    const got = await app2.sessions.get(s.id);
    assert.equal(got?.title, "persisted");
    assert.deepEqual(await app2.sessionLockStore.get("lock1"), { harnessId: "pi", modelId: "m1" });
  } finally {
    for (const app of apps) await app.runtime.stop();
    cleanupFiles(path);
  }
});

test("default memory backend keeps sessions and locks per-instance", async () => {
  const app1 = buildApp(testConfig());
  const app2 = buildApp(testConfig());
  try {
    const s = await app1.sessions.getOrCreateByThread("t1", "dm", "personal:U1" as never);
    await app1.sessionLockStore.put("lock1", { harnessId: "pi", modelId: "m1" });
    assert.equal(await app2.sessions.get(s.id), null);
    assert.equal(await app2.sessionLockStore.get("lock1"), null);
  } finally {
    await app1.runtime.stop();
    await app2.runtime.stop();
  }
});

test("SESSION_STORE=postgres without DATABASE_URL still fails fast", () => {
  assert.throws(() => buildApp(testConfig({ sessionStore: "postgres" })), /SESSION_STORE=postgres requires DATABASE_URL/);
});

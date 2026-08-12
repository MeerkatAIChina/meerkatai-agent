import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createSqliteMap, createSqliteMapFactory } from "../src/persistence/sqlite-map.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";

function cleanupFiles(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

function fullMap<T>(factory: ReturnType<typeof createSqliteMapFactory>, table: string): Required<DurableMap<T>> {
  return factory.map<T>(table) as Required<DurableMap<T>>;
}

test("sqlite map persists across factory instances", async () => {
  const path = `./data/test-sqlite-map-${process.pid}.db`;
  cleanupFiles(path);
  let first: ReturnType<typeof createSqliteMapFactory> | null = null;
  let second: ReturnType<typeof createSqliteMapFactory> | null = null;
  try {
    first = createSqliteMapFactory(path);
    await first.map<{ n: number }>("kv").put("a", { n: 1 });
    second = createSqliteMapFactory(path);
    assert.deepStrictEqual(await second.map<{ n: number }>("kv").get("a"), { n: 1 });
  } finally {
    first?.db.close();
    second?.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map implements merge, update, deleteIf, take", async () => {
  const path = `./data/test-sqlite-map-ops-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = fullMap<{ a: number; b?: number }>(factory, "kv");
    await m.put("x", { a: 1 });
    assert.deepStrictEqual(await m.merge("x", { b: 2 }), { a: 1, b: 2 });
    assert.deepStrictEqual(await m.update("x", (v) => ({ a: v.a + 1 })), { a: 2 });
    assert.strictEqual(await m.deleteIf("x", (v) => v.a === 2), true);
    assert.strictEqual(await m.get("x"), null);
    await m.put("y", { a: 3 });
    assert.deepStrictEqual(await m.take("y"), { a: 3 });
    assert.strictEqual(await m.get("y"), null);
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map insertIfAbsent returns false on conflict", async () => {
  const path = `./data/test-sqlite-map-insert-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = fullMap<{ n: number }>(factory, "kv");
    assert.strictEqual(await m.insertIfAbsent("a", { n: 1 }), true);
    assert.strictEqual(await m.insertIfAbsent("a", { n: 2 }), false);
    assert.deepStrictEqual(await m.get("a"), { n: 1 });
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map get returns null on missing and put overwrites", async () => {
  const path = `./data/test-sqlite-map-get-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = factory.map<{ n: number }>("kv");
    assert.strictEqual(await m.get("missing"), null);
    await m.put("a", { n: 1 });
    await m.put("a", { n: 2 });
    assert.deepStrictEqual(await m.get("a"), { n: 2 });
    await m.delete("a");
    assert.strictEqual(await m.get("a"), null);
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map putIfAbsent returns existing value when present", async () => {
  const path = `./data/test-sqlite-map-putifabsent-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = factory.map<{ n: number }>("kv");
    assert.deepStrictEqual(await m.putIfAbsent("a", { n: 1 }), { n: 1 });
    assert.deepStrictEqual(await m.putIfAbsent("a", { n: 2 }), { n: 1 });
    assert.deepStrictEqual(await m.get("a"), { n: 1 });
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map missing-key semantics for merge, update, deleteIf, take", async () => {
  const path = `./data/test-sqlite-map-missing-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = fullMap<{ a: number }>(factory, "kv");
    assert.strictEqual(await m.merge("missing", { a: 1 }), null);
    assert.strictEqual(await m.update("missing", (v) => v), null);
    assert.strictEqual(await m.deleteIf("missing", () => true), false);
    assert.strictEqual(await m.take("missing"), null);
    await m.put("a", { a: 1 });
    assert.strictEqual(await m.deleteIf("a", (v) => v.a === 2), false);
    assert.deepStrictEqual(await m.get("a"), { a: 1 });
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map merge deletes keys patched with undefined", async () => {
  const path = `./data/test-sqlite-map-undef-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = factory.map<{ a: number; b?: number }>("kv");
    await m.put("x", { a: 1, b: 2 });
    assert.deepStrictEqual(await m.merge("x", { b: undefined }), { a: 1 });
    assert.deepStrictEqual(await m.get("x"), { a: 1 });
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map all and entries are ordered by id", async () => {
  const path = `./data/test-sqlite-map-all-${process.pid}.db`;
  cleanupFiles(path);
  const factory = createSqliteMapFactory(path);
  try {
    const m = factory.map<{ n: number }>("kv");
    await m.put("b", { n: 2 });
    await m.put("a", { n: 1 });
    await m.put("c", { n: 3 });
    assert.deepStrictEqual(await m.all(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.deepStrictEqual(await m.entries(), [
      ["a", { n: 1 }],
      ["b", { n: 2 }],
      ["c", { n: 3 }],
    ]);
  } finally {
    factory.db.close();
    cleanupFiles(path);
  }
});

test("sqlite map rejects invalid table names", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => createSqliteMap(db, "bad;table"), /invalid table name/);
    assert.throws(() => createSqliteMap(db, "1starts-with-digit"), /invalid table name/);
    assert.throws(() => createSqliteMap(db, "has space"), /invalid table name/);
  } finally {
    db.close();
  }
});

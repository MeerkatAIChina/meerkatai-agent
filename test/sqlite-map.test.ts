import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteMap, createSqliteMapFactory } from "../src/persistence/sqlite-map.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";

const dir = mkdtempSync(join(tmpdir(), "qm-sqlite-map-test-"));
let seq = 0;

after(() => rmSync(dir, { recursive: true, force: true }));

function testPath(): string {
  return join(dir, `test-${process.pid}-${seq++}.db`);
}

function fullMap<T>(factory: ReturnType<typeof createSqliteMapFactory>, table: string): Required<DurableMap<T>> {
  return factory.map<T>(table) as Required<DurableMap<T>>;
}

test("sqlite map persists across factory instances", async () => {
  const path = testPath();
  const first = createSqliteMapFactory(path);
  await first.map<{ n: number }>("kv").put("a", { n: 1 });
  const concurrent = createSqliteMapFactory(path);
  assert.deepStrictEqual(await concurrent.map<{ n: number }>("kv").get("a"), { n: 1 });
  concurrent.db.close();
  first.db.close();
  const reopened = createSqliteMapFactory(path);
  try {
    assert.deepStrictEqual(await reopened.map<{ n: number }>("kv").get("a"), { n: 1 });
  } finally {
    reopened.db.close();
  }
});

test("sqlite map implements merge, update, deleteIf, take", async () => {
  const factory = createSqliteMapFactory(testPath());
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
  }
});

test("sqlite map insertIfAbsent returns false on conflict", async () => {
  const factory = createSqliteMapFactory(testPath());
  try {
    const m = fullMap<{ n: number }>(factory, "kv");
    assert.strictEqual(await m.insertIfAbsent("a", { n: 1 }), true);
    assert.strictEqual(await m.insertIfAbsent("a", { n: 2 }), false);
    assert.deepStrictEqual(await m.get("a"), { n: 1 });
  } finally {
    factory.db.close();
  }
});

test("sqlite map get returns null on missing and put overwrites", async () => {
  const factory = createSqliteMapFactory(testPath());
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
  }
});

test("sqlite map putIfAbsent returns existing value when present", async () => {
  const factory = createSqliteMapFactory(testPath());
  try {
    const m = factory.map<{ n: number }>("kv");
    assert.deepStrictEqual(await m.putIfAbsent("a", { n: 1 }), { n: 1 });
    assert.deepStrictEqual(await m.putIfAbsent("a", { n: 2 }), { n: 1 });
    assert.deepStrictEqual(await m.get("a"), { n: 1 });
  } finally {
    factory.db.close();
  }
});

test("sqlite map missing-key semantics for merge, update, deleteIf, take", async () => {
  const factory = createSqliteMapFactory(testPath());
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
  }
});

test("sqlite map merge deletes keys patched with undefined", async () => {
  const factory = createSqliteMapFactory(testPath());
  try {
    const m = fullMap<{ a: number; b?: number }>(factory, "kv");
    await m.put("x", { a: 1, b: 2 });
    assert.deepStrictEqual(await m.merge("x", { b: undefined }), { a: 1 });
    assert.deepStrictEqual(await m.get("x"), { a: 1 });
  } finally {
    factory.db.close();
  }
});

test("sqlite map all and entries are ordered by id", async () => {
  const factory = createSqliteMapFactory(testPath());
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

test("sqlite map factory reports a config-style error for an unopenable path", () => {
  assert.throws(
    () => createSqliteMapFactory(join(dir, "no-such-dir", "x.db")),
    /SQLITE_PATH .* could not be opened/,
  );
});

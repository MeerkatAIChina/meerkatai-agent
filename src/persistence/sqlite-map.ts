import { DatabaseSync } from "node:sqlite";
import type { DurableMap } from "./durable-map.ts";

function applyPatch<T>(value: T, patch: Partial<T>): T {
  const next = { ...value } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

export function createSqliteMap<T>(db: DatabaseSync, table: string): DurableMap<T> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  const get = db.prepare(`SELECT json FROM ${table} WHERE id = ?`);
  const put = db.prepare(`INSERT INTO ${table} (id, json) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`);
  const insertAbsent = db.prepare(`INSERT OR IGNORE INTO ${table} (id, json) VALUES (?, ?)`);
  const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  const take = db.prepare(`DELETE FROM ${table} WHERE id = ? RETURNING json`);
  const all = db.prepare(`SELECT id, json FROM ${table} ORDER BY id`);

  const parse = (row: { json: string } | undefined): T | null =>
    row ? (JSON.parse(row.json) as T) : null;

  return {
    async all() {
      return (all.all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as T);
    },
    async entries() {
      return (all.all() as Array<{ id: string; json: string }>).map(
        (r) => [r.id, JSON.parse(r.json) as T] as [string, T],
      );
    },
    async get(id) {
      return parse(get.get(id) as { json: string } | undefined);
    },
    async put(id, value) {
      put.run(id, JSON.stringify(value));
    },
    async putIfAbsent(id, value) {
      const existing = parse(get.get(id) as { json: string } | undefined);
      if (existing !== null) return existing;
      insertAbsent.run(id, JSON.stringify(value));
      return parse(get.get(id) as { json: string } | undefined) ?? value;
    },
    async insertIfAbsent(id, value) {
      const res = insertAbsent.run(id, JSON.stringify(value));
      return res.changes > 0;
    },
    async merge(id, patch) {
      const existing = parse(get.get(id) as { json: string } | undefined);
      if (existing === null) return null;
      const merged = applyPatch(existing, patch);
      put.run(id, JSON.stringify(merged));
      return merged;
    },
    async update(id, fn) {
      const existing = parse(get.get(id) as { json: string } | undefined);
      if (existing === null) return null;
      const next = fn(existing);
      put.run(id, JSON.stringify(next));
      return next;
    },
    async deleteIf(id, predicate) {
      const existing = parse(get.get(id) as { json: string } | undefined);
      if (existing === null || !predicate(existing)) return false;
      del.run(id);
      return true;
    },
    async delete(id) {
      del.run(id);
    },
    async take(id) {
      const row = take.get(id) as { json: string } | undefined;
      return parse(row);
    },
  };
}

export function createSqliteMapFactory(sqlitePath: string): {
  map<T>(table: string): DurableMap<T>;
  db: DatabaseSync;
} {
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL");
  return { map: <T>(table: string): DurableMap<T> => createSqliteMap<T>(db, table), db };
}

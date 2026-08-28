import { openSqliteDatabase } from "../persistence/sqlite-map.ts";
import type { ScopeId } from "../types.ts";
import type { ByteSource, DurableByteStore } from "./durable-byte-store.ts";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type FileArtifact,
  type FileArtifactStore,
  type FilePage,
  type ListOwnedOptions,
  type PutFileInput,
} from "./file-artifact-store.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS file_artifacts(
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL DEFAULT 'file',
    owner_scope_id   TEXT NOT NULL,
    path             TEXT NOT NULL,
    name             TEXT NOT NULL,
    mimetype         TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    blob_key         TEXT,
    sha256           TEXT,
    direction        TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    created_in_scope TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    source           TEXT NOT NULL DEFAULT 'live'
  )`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_created
    ON file_artifacts (owner_scope_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_owner_path
    ON file_artifacts (owner_scope_id, path)`,
  `CREATE INDEX IF NOT EXISTS file_artifacts_scope_created
    ON file_artifacts (created_in_scope, created_at DESC, id DESC) WHERE enabled = 1`,
];

function boolFromInt(v: unknown): boolean {
  return Number(v) !== 0;
}

function rowToArtifact(r: Record<string, unknown>): FileArtifact {
  return {
    id: r.id as string,
    ownerScopeId: r.owner_scope_id as ScopeId,
    createdBy: r.created_by as string,
    name: r.name as string,
    path: r.path as string,
    mimetype: r.mimetype as string,
    sizeBytes: Number(r.size_bytes),
    blobKey: (r.blob_key as string | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    direction: r.direction as FileArtifact["direction"],
    source: r.source as FileArtifact["source"],
    ...(r.created_in_scope != null ? { createdInScope: r.created_in_scope as ScopeId } : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    enabled: boolFromInt(r.enabled),
  };
}

function nullableScope(scope: ScopeId | undefined): string | null {
  return scope ?? null;
}

export function createSqliteFileArtifactStore(
  sqlitePath: string,
  byteStore: DurableByteStore,
): FileArtifactStore & { close(): void } {
  const db = openSqliteDatabase(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL");
  for (const stmt of SCHEMA) db.exec(stmt);

  const getRow = db.prepare("SELECT * FROM file_artifacts WHERE id = ?");
  const insertRow = db.prepare(
    `INSERT INTO file_artifacts
       (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
        direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'live')
     ON CONFLICT (id) DO NOTHING`,
  );
  const updateEnabled = db.prepare(
    "UPDATE file_artifacts SET enabled = ?, updated_at = ? WHERE id = ?",
  );
  const deleteRow = db.prepare("DELETE FROM file_artifacts WHERE id = ?");

  async function getRowById(id: string): Promise<FileArtifact | null> {
    const r = getRow.get(id) as Record<string, unknown> | undefined;
    return r ? rowToArtifact(r) : null;
  }

  async function put(input: PutFileInput): Promise<{ artifact: FileArtifact; created: boolean }> {
    const existing = await getRowById(input.id);
    if (existing) return { artifact: existing, created: false };

    const { blobKey, sizeBytes, sha256 } = await byteStore.put(
      input.data,
      input.maxBytes != null ? { maxBytes: input.maxBytes } : {},
    );
    const at = input.createdAt ?? Date.now();
    insertRow.run(
      input.id,
      input.ownerScopeId,
      input.path,
      input.name,
      input.mimetype,
      sizeBytes,
      blobKey,
      sha256,
      input.direction,
      input.createdBy,
      nullableScope(input.createdInScope),
      at,
      at,
    );
    const row = await getRowById(input.id);
    if (!row) throw new Error(`sqlite file artifact insert failed for ${input.id}`);
    return { artifact: row, created: true };
  }

  async function get(id: string, opts?: { includeDisabled?: boolean }): Promise<FileArtifact | null> {
    const r = await getRowById(id);
    if (!r) return null;
    if (!r.enabled && !opts?.includeDisabled) return null;
    return r;
  }

  async function open(id: string): Promise<{ artifact: FileArtifact; sizeBytes: number; stream: ByteSource } | null> {
    const r = await getRowById(id);
    if (!r || !r.enabled || !r.blobKey) return null;
    const bytes = await byteStore.open(r.blobKey);
    if (!bytes) return null;
    return { artifact: r, sizeBytes: bytes.sizeBytes, stream: bytes.stream };
  }

  async function listOwnedByScopes(scopes: readonly ScopeId[], opts?: ListOwnedOptions): Promise<FilePage> {
    if (scopes.length === 0) return { files: [] };
    const limit = clampLimit(opts?.limit);
    const cursor = opts?.cursor ? decodeCursor(opts.cursor) : null;

    const filters = [`owner_scope_id IN (${scopePlaceholders(scopes.length)})`];
    const params: (string | number)[] = [...scopes];
    if (!opts?.includeDisabled) filters.push("enabled = 1");
    if (opts?.createdInScope != null) {
      filters.push("created_in_scope = ?");
      params.push(opts.createdInScope);
    }
    params.push(limit + 1);

    const sql = `SELECT * FROM file_artifacts
                   WHERE ${filters.join(" AND ")}
                   ORDER BY created_at DESC, id DESC
                   LIMIT ?`;
    const stmt = db.prepare(sql);
    const rows = (stmt.all(...params) as Record<string, unknown>[]).map(rowToArtifact);
    const filtered = cursor
      ? rows.filter((r) => r.createdAt < cursor.createdAt || (r.createdAt === cursor.createdAt && r.id < cursor.id))
      : rows;
    const page = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : undefined;
    return { files: page, ...(nextCursor ? { nextCursor } : {}) };
  }

  async function resolveByOwnerPaths(
    refs: ReadonlyArray<{ ownerScopeId: ScopeId; path: string }>,
  ): Promise<FileArtifact[]> {
    if (refs.length === 0) return [];
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    for (const ref of refs) {
      conditions.push("(owner_scope_id = ? AND path = ?)");
      params.push(ref.ownerScopeId, ref.path);
    }
    const sql = `SELECT * FROM file_artifacts WHERE enabled = 1 AND (${conditions.join(" OR ")})`;
    const stmt = db.prepare(sql);
    const rows = (stmt.all(...params) as Record<string, unknown>[]).map(rowToArtifact);
    return rows;
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    updateEnabled.run(enabled ? 1 : 0, Date.now(), id);
  }

  async function deleteFn(id: string): Promise<void> {
    deleteRow.run(id);
  }

  return {
    put,
    get,
    open,
    listOwnedByScopes,
    resolveByOwnerPaths,
    setEnabled,
    delete: deleteFn,
    close() {
      db.close();
    },
  };
}

function scopePlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

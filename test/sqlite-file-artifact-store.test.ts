import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createSqliteFileArtifactStore } from "../src/files/sqlite-file-artifact-store.ts";
import { fileArtifactId, type PutFileInput } from "../src/files/file-artifact-store.ts";
import { scopeId } from "../src/types.ts";

const owner = scopeId("channel", "C1");
const other = scopeId("personal", "U9");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

function put(over: Partial<PutFileInput> = {}): PutFileInput {
  return {
    id: fileArtifactId("run-1", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "flag.png",
    path: "artifacts/flag.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
    createdInScope: owner,
    createdAt: 1000,
    ...over,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sqlite-artifact-"));
}

async function drain(store: { open(id: string): Promise<{ stream: NodeJS.ReadableStream } | null> }, id: string): Promise<Buffer> {
  const opened = await store.open(id);
  assert.ok(opened, "expected openable bytes");
  const chunks: Buffer[] = [];
  for await (const c of opened!.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("sqlite put is an idempotent upsert by deterministic id (no dup, no byte re-store)", async () => {
  const dir = tempDir();
  try {
    const bytes = createMemoryDurableByteStore();
    let putCount = 0;
    const counting = {
      put: (s: never, o: never) => {
        putCount++;
        return bytes.put(s, o);
      },
      open: bytes.open,
      delete: bytes.delete,
    };
    const store = createSqliteFileArtifactStore(join(dir, "artifacts.db"), counting as never);

    const first = await store.put(put());
    assert.equal(first.created, true);
    const second = await store.put(put({ name: "renamed.png" }));
    assert.equal(second.created, false);
    assert.equal(second.artifact.name, "flag.png", "existing row returned unchanged");
    assert.equal(putCount, 1, "no byte re-store on requeue");
    assert.equal((await store.listOwnedByScopes([owner])).files.length, 1);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite listOwnedByScopes: recency DESC, scope-filtered, keyset-paginated", async () => {
  const dir = tempDir();
  try {
    const store = createSqliteFileArtifactStore(join(dir, "artifacts.db"), createMemoryDurableByteStore());
    await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
    await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
    await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
    await store.put(put({ id: "z", ownerScopeId: other, path: "p/z", data: Buffer.from("z"), createdAt: 999 }));

    assert.deepEqual(
      (await store.listOwnedByScopes([owner])).files.map((f) => f.id),
      ["c", "b", "a"],
    );
    const p1 = await store.listOwnedByScopes([owner], { limit: 2 });
    assert.deepEqual(
      p1.files.map((f) => f.id),
      ["c", "b"],
    );
    assert.ok(p1.nextCursor);
    const p2 = await store.listOwnedByScopes([owner], { limit: 2, cursor: p1.nextCursor! });
    assert.deepEqual(
      p2.files.map((f) => f.id),
      ["a"],
    );
    assert.equal(p2.nextCursor, undefined);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite listOwnedByScopes: created-scope and enabled filters compose", async () => {
  const dir = tempDir();
  try {
    const store = createSqliteFileArtifactStore(join(dir, "artifacts.db"), createMemoryDurableByteStore());
    await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
    await store.put(put({ id: "b", ownerScopeId: other, path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
    await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdInScope: other, createdAt: 300 }));
    await store.put(put({ id: "d", ownerScopeId: other, path: "p/d", data: Buffer.from("d"), createdAt: 400 }));
    await store.setEnabled("d", false);

    const visible = await store.listOwnedByScopes([owner, other], { createdInScope: owner });
    assert.deepEqual(
      visible.files.map((f) => f.id),
      ["b", "a"],
    );
    const all = await store.listOwnedByScopes([owner, other], { createdInScope: owner, includeDisabled: true });
    assert.deepEqual(
      all.files.map((f) => f.id),
      ["d", "b", "a"],
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite get and open round-trip bytes across a fresh store instance", async () => {
  const dir = tempDir();
  try {
    const bytes = createMemoryDurableByteStore();
    const writer = createSqliteFileArtifactStore(join(dir, "artifacts.db"), bytes);
    const { artifact } = await writer.put(put());
    writer.close();

    const reader = createSqliteFileArtifactStore(join(dir, "artifacts.db"), bytes);
    const got = await reader.get(artifact.id);
    assert.ok(got);
    assert.equal(got!.name, "flag.png");

    const opened = await reader.open(artifact.id);
    assert.ok(opened);
    assert.deepEqual(await drain(reader as never, artifact.id), PNG);

    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite resolveByOwnerPaths returns enabled matches", async () => {
  const dir = tempDir();
  try {
    const store = createSqliteFileArtifactStore(join(dir, "artifacts.db"), createMemoryDurableByteStore());
    await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a") }));
    await store.put(put({ id: "b", ownerScopeId: other, path: "p/b", data: Buffer.from("b") }));
    await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c") }));
    await store.setEnabled("c", false);

    const found = await store.resolveByOwnerPaths([
      { ownerScopeId: owner, path: "p/a" },
      { ownerScopeId: other, path: "p/b" },
      { ownerScopeId: owner, path: "p/c" },
    ]);
    assert.deepEqual(
      found.map((f) => f.id).sort(),
      ["a", "b"],
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite delete removes the artifact", async () => {
  const dir = tempDir();
  try {
    const store = createSqliteFileArtifactStore(join(dir, "artifacts.db"), createMemoryDurableByteStore());
    await store.put(put());
    assert.equal((await store.listOwnedByScopes([owner])).files.length, 1);
    await store.delete(put().id);
    assert.equal((await store.listOwnedByScopes([owner])).files.length, 0);
    assert.equal(await store.get(put().id), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import {
  SWEEP_MAX_CARDS,
  SWEEP_MAX_FILES,
  collectWorkspaceSweep,
  normalizeWorkspacePath,
  workspaceSweepCommand,
  type ArtifactRegistration,
  type DeliveredTracker,
} from "../src/core/attachments.ts";

const HANDLE: SandboxHandle = { id: "x", rootDir: "/tmp/x" };
const bytes = (s: string) => new Uint8Array(Buffer.from(s));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const newTracker = (): DeliveredTracker => ({ paths: new Set(), hashes: new Set() });

function fakeSweepSandbox(files: Map<string, Uint8Array>): Sandbox {
  return {
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
    async run(_h: SandboxHandle, command: string) {
      assert.match(command, /-newermt '@\d+\.\d{3}'/);
      const stdout = [...files.keys()].map((k) => `./${k}`).join("\n");
      return { stdout: stdout ? `${stdout}\n` : "", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
}

function registration(): { register: ArtifactRegistration } {
  return {
    register: {
      store: createMemoryFileArtifactStore(createMemoryDurableByteStore()),
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      createdInScope: "dm:U1",
      seed: "run-1:sweep",
    },
  };
}

test("workspaceSweepCommand prunes noise dirs and uses a millisecond epoch timestamp", () => {
  const cmd = workspaceSweepCommand(1692960000123);
  assert.match(cmd, /-newermt '@1692960000\.123'/);
  for (const p of ["./.agent-turn", "*/node_modules", "*/.git", "*/__pycache__", "./.npm", "./.cache", "./venv", "./.venv"])
    assert.ok(cmd.includes(`-path '${p}'`), `prunes ${p}`);
  assert.match(cmd, /-prune -o -type f/);
});

test("normalizeWorkspacePath strips a leading ./ only", () => {
  assert.equal(normalizeWorkspacePath("./a.txt"), "a.txt");
  assert.equal(normalizeWorkspacePath("a.txt"), "a.txt");
  assert.equal(normalizeWorkspacePath("./dir/b.txt"), "dir/b.txt");
});

test("sweep registers and attaches a new workspace file", async () => {
  const files = new Map([["report.txt", bytes("hello")]]);
  const { register } = registration();
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
    register,
  });
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]!.name, "report.txt");
  assert.equal(r.attachments[0]!.sizeBytes, 5);
  assert.ok(r.attachments[0]!.artifactId, "registered as an artifact");
  assert.deepEqual(r.registeredOverflow, []);
});

test("sweep skips files already delivered via post(files) (path match)", async () => {
  const files = new Map([["report.txt", bytes("hello")]]);
  const tr = newTracker();
  tr.paths.add("report.txt");
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: tr,
    cardBudget: SWEEP_MAX_CARDS,
  });
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.duplicates, ["report.txt"]);
});

test("sweep skips the outbox original by content hash (and same content at another path)", async () => {
  const content = bytes("pptx-bytes");
  const files = new Map([
    ["report.pptx", content],
    ["copy.pptx", bytes("pptx-bytes")],
  ]);
  const tr = newTracker();
  tr.hashes.add(sha256(content));
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: tr,
    cardBudget: SWEEP_MAX_CARDS,
  });
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.duplicates, ["copy.pptx", "report.pptx"]);
});

test("sweep caps cards at the budget but still registers the overflow", async () => {
  const files = new Map(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, bytes(`c${i}`)]));
  const { register } = registration();
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
    register,
  });
  assert.equal(r.attachments.length, 5);
  assert.deepEqual(r.registeredOverflow, ["f5.txt", "f6.txt"]);
});

test("sweep skips 0-byte placeholder files", async () => {
  const files = new Map([
    ["placeholder.txt", bytes("")],
    ["real.txt", bytes("x")],
  ]);
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
  });
  assert.deepEqual(r.empty, ["placeholder.txt"]);
  assert.deepEqual(r.attachments.map((a) => a.name), ["real.txt"]);
});

test("sweep drops files past SWEEP_MAX_FILES", async () => {
  const files = new Map(
    Array.from({ length: SWEEP_MAX_FILES + 2 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, bytes(`c${i}`)]),
  );
  const r = await collectWorkspaceSweep(fakeSweepSandbox(files), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
  });
  assert.equal(r.dropped, 2);
  assert.equal(r.attachments.length + r.registeredOverflow.length, SWEEP_MAX_FILES);
});

test("scoped and scratch sweeps with distinct seeds never share an artifact id", async () => {
  const scopedFiles = new Map([["scoped.txt", bytes("scoped")]]);
  const scratchFiles = new Map([["scratch.txt", bytes("scratch")]]);
  const { register } = registration();
  const scoped = await collectWorkspaceSweep(fakeSweepSandbox(scopedFiles), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
    register,
  });
  const scratch = await collectWorkspaceSweep(fakeSweepSandbox(scratchFiles), HANDLE, createMemoryBlobTransferStore(), {
    turnStartMs: 1692960000123,
    tracker: newTracker(),
    cardBudget: SWEEP_MAX_CARDS,
    register: { ...register, seed: `${register.seed}:scratch` },
  });
  assert.ok(scoped.attachments[0]!.artifactId, "scoped attachment registered");
  assert.ok(scratch.attachments[0]!.artifactId, "scratch attachment registered");
  assert.notEqual(scoped.attachments[0]!.artifactId, scratch.attachments[0]!.artifactId);
});

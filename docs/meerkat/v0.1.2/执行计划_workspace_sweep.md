# 会话产出文件兜底可见（需求 5，issue #24）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DM turn 结束时兜底检测本轮 workspace 新建/修改但未交付的文件，自动登记为 artifact 并挂聊天附件卡片，使会话产出必然在「文件」面板可见、可下载；core 默认关，桌面端经 env 开启。

**Architecture:** `attachments.ts` 新增导出 `collectWorkspaceSweep`（与 `collectOutbound`/`collectNamedOutbound` 同层，内部复用私有助手），turn 收口处在 outbox 收集之后对两个 sandbox handle 各跑一次 `find`（mtime > turnStart 毫秒精度、噪声目录表达式内 prune），命中文件复用 artifact 注册通道（seed 加 `:sweep` 后缀）合并进 `outbound.attachments`；与显式交付的去重靠 per-turn「路径 + sha256」双集合（`DeliveredTracker`）。

**Tech Stack:** Node 24（node:test）、TypeScript（core）、Rust（桌面 proc.rs 一行 env）。

**Spec:** [设计文档.md](./设计文档.md)「会话产出文件兜底可见（需求 5，issue #24）」一节 + [ADR.md](./ADR.md) ADR-012 —— 拍板记录、评审修订链（哈希双集合 / `:sweep` seed / 尾注载体 / automated turn 排除）是裁决依据，执行前必读。

## Global Constraints

- **分支**：全部在 `feature/meerkat` 上开发，不动 `main`。
- **零注释**：仓规为零注释（无解释性注释、无 TODO、无 lint 抑制），意图靠命名、结构与测试表达，理由写 commit message。
- **中性实现**：core（`src/`）与测试代码零 meerkat 字样——本特性保持上游可贡献形态。
- **时间戳格式已实证**（2026-08-26 在 `meerkat-sandbox-rootfs:latest` 镜像内）：`@<epoch.毫秒>` 与 ISO/空格带小数两种格式均被 GNU `find -newermt` 正确解析，严格大于语义确认（`@1692959999.999` 命中 / `@1692960000.123` 不命中 mtime=`@1692960000` 的文件）。**本计划固定用 `@` 格式**，由 `(turnStartMs / 1000).toFixed(3)` 生成。
- **集成测试基建**：`test/orchestrator.test.ts` 的 `freshApp(overrides)` + `app.turn(dm(...))` 是全栈 turn 管道；fake-sprites（`test/support/fake-sprites.ts:79-95`）用**宿主真实 `sh`** 执行命令（`spawnSync("sh", ["-c", ...])`），`find`/mtime 语义是真实的，测试可直接写文件断言兜底行为。Windows 本地需 `sh` 在 PATH（Git Bash/MSYS2，本机已具备）。
- **测试命令**（Windows PowerShell 可直接执行）：
  - 定向：`node --experimental-test-module-mocks --test test/workspace-sweep.test.ts test/file-sharing.test.ts test/surface-post-files.test.ts test/orchestrator.test.ts test/config.test.ts test/pi-tools.test.ts`
  - typecheck：`npm run typecheck`
  - lint：`npm run lint:ox`
- **提交**：每个 Task 末尾按步骤 commit，message 带 `(#24)`。ADR-012 已就位（`docs/meerkat/v0.1.2/ADR.md`），无需再记。
- **执行期留意**（设计评审挂账）：① sweep 跳过空文件（`empty` 类只进 operator log，**不得**并入 `outbound.empty`——那会触发「wasn't sent」的用户可见文案）；② 溢出文件不进 hidden tape note（`orchestrator.ts:2835` 的 `deliveryManifest` 调用保持单参数，模型下轮不知晓溢出部分，可接受）；③ `post(files)` 的 turn 级去重不单独做集成测试——由「resolveFiles 记录 tracker」（Task 3 单测）与「sweep 跳过 tracker 路径」（Task 1 单测）两个单测组合覆盖。

---

### Task 1: attachments.ts——sweep 核心（DeliveredTracker + hashes + collectWorkspaceSweep + deliveryManifest 尾注）

**Files:**
- Modify: `src/core/attachments.ts`（常量区 `:20-37`、`collectOutbound :356`、`collectNamedOutbound :402`、`deliveryManifest :340`；文件顶部 import 加 `createHash`）
- Test: Create `test/workspace-sweep.test.ts`
- Test: Modify `test/file-sharing.test.ts`（collectOutbound hashes、deliveryManifest 尾注）
- Test: Modify `test/surface-post-files.test.ts`（collectNamedOutbound hashes）

**Interfaces:**
- Consumes: 现有 `ArtifactRegistration`（`:114`）、`registerArtifact`（模块私有）、`uniqueName`（模块私有 `:158`）、`safeAttachmentName`/`mimeFromName`、`MAX_OUTBOUND_FILES`（`:108`）、`MAX_ATTACHMENT_BYTES`（`:29`）。
- Produces（Task 3 全部依赖，逐字固定）：

```ts
export interface DeliveredTracker {
  paths: Set<string>;
  hashes: Set<string>;
}
export function normalizeWorkspacePath(p: string): string;
export function workspaceSweepCommand(turnStartMs: number): string;
export const SWEEP_PRUNE_PATHS: readonly string[];
export const SWEEP_MAX_CARDS = 5;
export const SWEEP_MAX_FILES = MAX_OUTBOUND_FILES;
export async function collectWorkspaceSweep(
  sandbox: Sandbox,
  handle: SandboxHandle,
  transfer: BlobTransferStore,
  opts: {
    turnStartMs: number;
    tracker: DeliveredTracker;
    cardBudget: number;
    register?: ArtifactRegistration;
  },
): Promise<{
  attachments: OutgoingAttachment[];
  registeredOverflow: string[];
  duplicates: string[];
  empty: string[];
  oversized: string[];
  dropped: number;
}>;
```

- `collectOutbound` / `collectNamedOutbound` 返回类型各加 `hashes: string[]`（仅含**成功交付**文件的 sha256 hex，empty/oversized/doomed-skipped 不算）。
- `deliveryManifest(attachments, overflow?: { count: number; names: readonly string[] }): string`——第二参数可选，既有单参数调用点逐字节不变。

- [ ] **Step 1: Write the failing tests**

新建 `test/workspace-sweep.test.ts`：

```ts
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
```

`test/file-sharing.test.ts` 追加（import 区加 `createHash` from `node:crypto`）：

```ts
test("collectOutbound returns sha256 hashes of delivered files only", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  const transfer = createMemoryBlobTransferStore();
  files.set("outbox/report.csv", new Uint8Array(Buffer.from("a,b")));
  files.set("outbox/blank.txt", new Uint8Array(0));
  const { attachments, hashes } = await collectOutbound(sandbox, handle, transfer);
  assert.equal(attachments.length, 1);
  assert.deepEqual(hashes, [createHash("sha256").update(Buffer.from("a,b")).digest("hex")]);
});

test("deliveryManifest appends the overflow note when given", () => {
  const m = deliveryManifest(
    [{ name: "a.png", mimetype: "image/png", sizeBytes: 1, blobId: "B" }],
    { count: 2, names: ["b.txt", "c.txt"] },
  );
  assert.equal(m, "a.png (image/png, 1 bytes); and 2 more file(s) registered to the Files panel: b.txt, c.txt");
  assert.equal(deliveryManifest([{ name: "a.png", mimetype: "image/png", sizeBytes: 1, blobId: "B" }]), "a.png (image/png, 1 bytes)");
});
```

`test/surface-post-files.test.ts` 追加（import 区加 `createHash` from `node:crypto`；`bytes`/`fakeSandbox`/`handle` 复用文件内既有 helper）：

```ts
test("collectNamedOutbound returns sha256 hashes of delivered files", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/there.png": bytes("X") }, []);
  const r = await collectNamedOutbound(sandbox, handle, ["outbox/there.png"], transfer);
  assert.deepEqual(r.hashes, [createHash("sha256").update(bytes("X")).digest("hex")]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test test/workspace-sweep.test.ts`
Expected: FAIL（`collectWorkspaceSweep`/`workspaceSweepCommand` 等未导出，模块加载即抛）

- [ ] **Step 3: Implement**

`src/core/attachments.ts` 顶部 import 加：

```ts
import { createHash } from "node:crypto";
```

常量区（`MAX_OUTBOUND_FILES` 附近）加：

```ts
export const SWEEP_PRUNE_PATHS = [
  "./.agent-turn",
  "*/node_modules",
  "*/.git",
  "*/__pycache__",
  "./.npm",
  "./.cache",
  "./venv",
  "./.venv",
] as const;
export const SWEEP_MAX_CARDS = 5;
export const SWEEP_MAX_FILES = MAX_OUTBOUND_FILES;

export interface DeliveredTracker {
  paths: Set<string>;
  hashes: Set<string>;
}

export function normalizeWorkspacePath(p: string): string {
  return p.replace(/^\.\//, "");
}

export function workspaceSweepCommand(turnStartMs: number): string {
  const ts = `@${(turnStartMs / 1000).toFixed(3)}`;
  const prune = SWEEP_PRUNE_PATHS.map((p) => `-path '${p}'`).join(" -o ");
  return `find . \\( ${prune} \\) -prune -o -type f -newermt '${ts}' -print`;
}
```

`collectWorkspaceSweep`（放在 `collectNamedOutbound` 之后）：

```ts
export async function collectWorkspaceSweep(
  sandbox: Sandbox,
  handle: SandboxHandle,
  transfer: BlobTransferStore,
  opts: {
    turnStartMs: number;
    tracker: DeliveredTracker;
    cardBudget: number;
    register?: ArtifactRegistration;
  },
): Promise<{
  attachments: OutgoingAttachment[];
  registeredOverflow: string[];
  duplicates: string[];
  empty: string[];
  oversized: string[];
  dropped: number;
}> {
  const none = { attachments: [], registeredOverflow: [], duplicates: [], empty: [], oversized: [], dropped: 0 };
  const res = await sandbox.run(handle, workspaceSweepCommand(opts.turnStartMs), { timeoutMs: 30_000 });
  if (res.code !== 0) {
    console.error(`[attachments] workspace sweep find failed (code ${res.code}): ${res.stderr.trim()}`);
    return none;
  }
  const candidates = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(normalizeWorkspacePath)
    .sort();
  const attachments: OutgoingAttachment[] = [];
  const registeredOverflow: string[] = [];
  const duplicates: string[] = [];
  const empty: string[] = [];
  const oversized: string[] = [];
  const usedNames = new Set<string>();
  let dropped = 0;
  let registered = 0;
  for (const rel of candidates) {
    if (opts.tracker.paths.has(rel)) {
      duplicates.push(rel);
      continue;
    }
    if (registered >= SWEEP_MAX_FILES) {
      dropped++;
      continue;
    }
    const bytes = await sandbox.readFileBytes(handle, rel);
    if (!bytes) continue;
    if (bytes.length === 0) {
      empty.push(rel);
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      oversized.push(rel);
      continue;
    }
    if (opts.tracker.hashes.has(createHash("sha256").update(bytes).digest("hex"))) {
      duplicates.push(rel);
      continue;
    }
    const name = uniqueName(safeAttachmentName(rel.split("/").pop() ?? rel), usedNames);
    usedNames.add(name);
    const mimetype = mimeFromName(name);
    const { blobId } = await transfer.put(bytes);
    const artifact = opts.register
      ? await registerArtifact(opts.register, "out", registered, name, mimetype, bytes)
      : undefined;
    registered++;
    if (attachments.length < opts.cardBudget) {
      attachments.push({
        name,
        mimetype,
        sizeBytes: bytes.length,
        blobId,
        ...(artifact ? { artifactId: artifact.id, artifactViewerId: opts.register!.createdBy } : {}),
      });
    } else {
      registeredOverflow.push(name);
    }
  }
  return { attachments, registeredOverflow, duplicates, empty, oversized, dropped };
}
```

`collectOutbound` 改动（`:356-400`）：返回类型加 `hashes: string[]`；函数体加 `const hashes: string[] = [];`，在 `transfer.put(bytes)` 之后、`registerArtifact` 之前插一行 `hashes.push(createHash("sha256").update(bytes).digest("hex"));`，return 加 `hashes`。

`collectNamedOutbound` 改动（`:402` 起）：同样加 `hashes`；注意只在文件**实际交付**（过了 `doomed()` 检查、进入 attachments 的那批）时 push——即 `transfer.put(bytes)` 之后那处。

`deliveryManifest` 改动（`:340-342`）：

```ts
export function deliveryManifest(
  attachments: readonly OutgoingAttachment[],
  overflow?: { count: number; names: readonly string[] },
): string {
  const base = attachments.map((a) => `${a.name} (${a.mimetype}, ${a.sizeBytes} bytes)`).join("; ");
  if (!overflow?.count) return base;
  return `${base}; and ${overflow.count} more file(s) registered to the Files panel: ${overflow.names.join(", ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test test/workspace-sweep.test.ts test/file-sharing.test.ts test/surface-post-files.test.ts`
Expected: PASS（含既有用例无回归——`collectOutbound`/`collectNamedOutbound` 返回结构加字段不影响解构既有字段的调用方）

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck && npm run lint:ox`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/attachments.ts test/workspace-sweep.test.ts test/file-sharing.test.ts test/surface-post-files.test.ts
git commit -m "feat(core): workspace sweep collector with path+hash dedup for undelivered turn outputs (#24)"
```

---

### Task 2: config + wiring——deliverWorkspaceOutputs 开关 plumbing

**Files:**
- Modify: `src/config.ts`（Config 接口声明 + `:905` 解析行）
- Modify: `src/core/orchestrator/types.ts:101`（`OrchestratorDeps` 接口体——声明在此处，`orchestrator.ts:174` 只是 re-export，`wiring.ts:193` 的 import 经 re-export 不受影响）
- Modify: `src/wiring.ts:1025`（`orchestratorDeps` 对象字面量）
- Test: Modify `test/config.test.ts`

**Interfaces:**
- Consumes: Task 1 无依赖（独立 plumbing，但 Task 3 同时依赖 Task 1 与本任务）。
- Produces: `Config.deliverWorkspaceOutputs: boolean`（默认 `false`）；`OrchestratorDeps.deliverWorkspaceOutputs?: boolean`。Task 3 逐字依赖这两个名字。

- [ ] **Step 1: Write the failing test**

`test/config.test.ts` 中找到 `allowLocalSkillPacks`（或 `SEED_SKILLS`）的既有解析用例，照其同构写法追加一条：缺省为 `false`、`DELIVER_WORKSPACE_OUTPUTS=1` 解析为 `true`（env 名逐字固定）。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test test/config.test.ts`
Expected: FAIL（`deliverWorkspaceOutputs` 为 undefined）

- [ ] **Step 3: Implement**

`src/config.ts`：
- Config 接口在 `allowLocalSkillPacks` 声明的相邻行加 `deliverWorkspaceOutputs: boolean;`；
- 解析区 `:905` 之后插一行：

```ts
    deliverWorkspaceOutputs: boolEnvStrict("DELIVER_WORKSPACE_OUTPUTS", env.DELIVER_WORKSPACE_OUTPUTS) ?? false,
```

`src/core/orchestrator/types.ts` 的 `OrchestratorDeps` 接口（`:101`）加：

```ts
  deliverWorkspaceOutputs?: boolean;
```

`src/wiring.ts` 的 `orchestratorDeps` 对象（`:1025`）加一行：

```ts
    deliverWorkspaceOutputs: config.deliverWorkspaceOutputs,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test test/config.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/core/orchestrator/types.ts src/wiring.ts test/config.test.ts
git commit -m "feat(core): deliverWorkspaceOutputs config flag wired into orchestrator deps (#24)"
```

---

### Task 3: orchestrator 收口块接线 + surface-tools tracker 记录

**Files:**
- Modify: `src/core/orchestrator.ts`（attachments import 区 `:103` 附近；tracker 创建 `:1719` 之后；`createSurfaceToolDeps` 调用 `:1728-1742`；收口块 `:2746-2774`；delivery entry `:2815`）
- Modify: `src/core/orchestrator/surface-tools.ts`（`SurfaceToolsContext :52`、`resolveFiles :187-207`）
- Test: Modify `test/orchestrator.test.ts`（6 个集成用例）
- Test: Modify `test/surface-post-files.test.ts`（resolveFiles 记录 tracker 单测）

**Interfaces:**
- Consumes: Task 1 的 `collectWorkspaceSweep`/`DeliveredTracker`/`normalizeWorkspacePath`/`SWEEP_MAX_CARDS`/`SWEEP_MAX_FILES`；Task 2 的 `deps.deliverWorkspaceOutputs`。
- Produces: `SurfaceToolsContext.deliveredTracker?: DeliveredTracker`。

- [ ] **Step 1: Write the failing tests**

`test/surface-post-files.test.ts` 追加（照文件内 `:69-104` 既有成功/失败 post 用例的 fake 结构，补 `deliveredTracker` 字段；`bytes`/`handle` 复用文件内 helper）：

```ts
test("post(files) records delivered paths and hashes into the turn tracker", async () => {
  const tracker = { paths: new Set<string>(), hashes: new Set<string>() };
  const sandbox = fakeSandbox({ "report.pdf": bytes("pdf-bytes") }, []);
  const tools = createSurfaceToolDeps({
    deps: { deliveries: {}, sandbox },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    session: { id: "S1" },
    scopeId: "personal:U1",
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: createMemoryBlobTransferStore(),
    fileRegistration: {},
    provision: async () => handle,
    postProvenance() {
      return {};
    },
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
    deliveredTracker: tracker,
  } as unknown as SurfaceToolsContext)!;
  const r = await tools.post("hi", undefined, ["report.pdf"]);
  assert.equal(r.ok, true);
  assert.ok(tracker.paths.has("report.pdf"));
  assert.deepEqual([...tracker.hashes], [createHash("sha256").update(bytes("pdf-bytes")).digest("hex")]);
});
```

（注意：该文件的既有 fake 若缺 `deliveries`/`reachEnqueue` 通路导致 `post` 返回非 ok，照文件内既有**成功** post 用例的 fake 补齐；断言不变。）

`test/orchestrator.test.ts` 追加 6 个集成用例（`dm()`/`freshApp()` 复用文件内 helper；fake-sprites 用宿主真实 `sh` 执行，文件是真实写落的）：

```ts
test("workspace sweep: an undelivered DM turn output is delivered and registered", async () => {
  const { app } = freshApp({ deliverWorkspaceOutputs: true });
  const res = await app.turn(dm("!run printf hello > sweep-me.txt"));
  assert.equal(res.status, "ok");
  assert.deepEqual((res.attachments ?? []).map((a) => a.name), ["sweep-me.txt"]);
  const found = await app.getSession(res.sessionId!);
  const delivery = found!.entries.find((e) => e.type === "delivery");
  assert.ok(delivery, "a delivery session entry exists");
  const files = (delivery!.payload as { files: { name: string; artifactId?: string }[] }).files;
  assert.equal(files[0]!.name, "sweep-me.txt");
  assert.ok(files[0]!.artifactId, "registered as an artifact (visible in the Files panel)");
});

test("workspace sweep: a file copied to $AGENT_OUTBOX is not double-delivered (hash dedup)", async () => {
  const { app } = freshApp({ deliverWorkspaceOutputs: true });
  const res = await app.turn(dm('!run printf one > dup.txt && mkdir -p "$AGENT_OUTBOX" && cp dup.txt "$AGENT_OUTBOX/"'));
  assert.equal(res.status, "ok");
  assert.deepEqual((res.attachments ?? []).map((a) => a.name), ["dup.txt"]);
});

test("workspace sweep: dependency noise is pruned", async () => {
  const { app } = freshApp({ deliverWorkspaceOutputs: true });
  const res = await app.turn(
    dm("!run mkdir -p node_modules/dep && printf x > node_modules/dep/index.js && printf y > keep.txt"),
  );
  assert.equal(res.status, "ok");
  assert.deepEqual((res.attachments ?? []).map((a) => a.name), ["keep.txt"]);
});

test("workspace sweep: off by default (upstream semantics unchanged)", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!run printf hello > no-sweep.txt"));
  assert.equal(res.status, "ok");
  assert.deepEqual(res.attachments ?? [], []);
  const found = await app.getSession(res.sessionId!);
  assert.equal(found!.entries.some((e) => e.type === "delivery"), false);
});

test("workspace sweep: cards cap at 5, overflow is registered and noted in the delivery text", async () => {
  const { app } = freshApp({ deliverWorkspaceOutputs: true });
  const res = await app.turn(dm("!run for i in 1 2 3 4 5 6 7; do printf c$i > part-$i.txt; done"));
  assert.equal(res.status, "ok");
  assert.equal((res.attachments ?? []).length, 5);
  const found = await app.getSession(res.sessionId!);
  const delivery = found!.entries.find((e) => e.type === "delivery");
  const text = (delivery!.payload as { text: string }).text;
  assert.match(text, /and 2 more file\(s\) registered to the Files panel: part-6\.txt, part-7\.txt/);
});

test("workspace sweep: automated turns are not swept", async () => {
  const { app } = freshApp({ deliverWorkspaceOutputs: true });
  const res = await app.turn(dm("!run printf hello > cron-out.txt", { origin: { kind: "automation" } }));
  assert.equal(res.status, "ok");
  assert.deepEqual(res.attachments ?? [], []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test test/orchestrator.test.ts test/surface-post-files.test.ts`
Expected: 新增用例 FAIL（sweep 未接线：前者 attachments 为空、后者 tracker 为空）

- [ ] **Step 3: Implement**

**`src/core/orchestrator/surface-tools.ts`**：
- `SurfaceToolsContext`（`:52`）加 `deliveredTracker?: DeliveredTracker;`，import 区从 `./attachments.ts`...（核对该文件现有 attachments import 路径，实为 `../attachments.ts`）引入 `normalizeWorkspacePath` 与 `DeliveredTracker` 类型；
- `createSurfaceToolDeps` 解构处（`:88` 附近）补 `deliveredTracker`；
- `resolveFiles`（`:187-207`）在 `bad.length` 检查之后、`return { ok: true, ... }` 之前插：

```ts
    for (const p of files) deliveredTracker?.paths.add(normalizeWorkspacePath(p));
    for (const h of r.hashes) deliveredTracker?.hashes.add(h);
```

**`src/core/orchestrator.ts`**：
- attachments import 区（`:103` 附近）加 `collectWorkspaceSweep`、`SWEEP_MAX_CARDS`、`SWEEP_MAX_FILES`、`type DeliveredTracker`、`type OutgoingAttachment`（`ArtifactRegistration` 既有 import（`:116`），`OutgoingAttachment` 无既有 import、必须新增——`noSweep` 字面量的 `[] as OutgoingAttachment[]` 依赖它）；
- **`noOutbound` 字面量（`:2746`）补 `hashes` 字段**（非 DM 会话时 `outboundScoped`/`outboundScratch` 取该字面量，下方要访问 `.hashes`，缺字段是确定的 TS2339）：

```ts
        const noOutbound = { attachments: [], oversized: [], empty: [], dropped: 0, hashes: [] as string[] };
```

- `fileRegistration` 构造之后（`:1719` 后）创建 tracker：

```ts
        const deliveredTracker: DeliveredTracker = { paths: new Set(), hashes: new Set() };
```

- `createSurfaceToolDeps({...})`（`:1728-1742`）参数加一行 `deliveredTracker,`；
- 收口块（`:2761` `outboundScratch` 之后、`:2769` `const outbound` 之前）插：

```ts
        for (const h of [...outboundScoped.hashes, ...outboundScratch.hashes]) deliveredTracker.hashes.add(h);
        const noSweep = {
          attachments: [] as OutgoingAttachment[],
          registeredOverflow: [] as string[],
          duplicates: [] as string[],
          empty: [] as string[],
          oversized: [] as string[],
          dropped: 0,
        };
        const sweepEnabled = deps.deliverWorkspaceOutputs === true && harvestOutbox && !automatedTurn;
        const sweepRegistration: ArtifactRegistration = { ...fileRegistration, seed: `${fileRegistration.seed}:sweep` };
        const sweepScoped =
          sweepEnabled && box.used && box.handle
            ? await collectWorkspaceSweep(deps.sandbox, box.handle, blobTransfer, {
                turnStartMs: turnStart,
                tracker: deliveredTracker,
                cardBudget: SWEEP_MAX_CARDS,
                register: sweepRegistration,
              })
            : noSweep;
        const sweepScratch =
          sweepEnabled && scratchBox.handle
            ? await collectWorkspaceSweep(deps.sandbox, scratchBox.handle, blobTransfer, {
                turnStartMs: turnStart,
                tracker: deliveredTracker,
                cardBudget: Math.max(0, SWEEP_MAX_CARDS - sweepScoped.attachments.length),
                register: sweepRegistration,
              })
            : noSweep;
        const sweepOverflow = [...sweepScoped.registeredOverflow, ...sweepScratch.registeredOverflow];
        const sweepDupes = [...sweepScoped.duplicates, ...sweepScratch.duplicates];
        const sweepEmpty = [...sweepScoped.empty, ...sweepScratch.empty];
        const sweepOversized = [...sweepScoped.oversized, ...sweepScratch.oversized];
        const sweepDropped = sweepScoped.dropped + sweepScratch.dropped;
        if (sweepEnabled && (sweepOverflow.length || sweepDupes.length || sweepEmpty.length || sweepOversized.length || sweepDropped)) {
          console.error(
            `[orchestrator] workspace sweep session=${session.id}:` +
              ` delivered=${sweepScoped.attachments.length + sweepScratch.attachments.length}` +
              (sweepOverflow.length ? ` registered-without-card=${sweepOverflow.join(", ")}` : "") +
              (sweepDupes.length ? ` duplicates-skipped=${sweepDupes.join(", ")}` : "") +
              (sweepEmpty.length ? ` empty-skipped=${sweepEmpty.join(", ")}` : "") +
              (sweepOversized.length ? ` oversized-skipped=${sweepOversized.join(", ")}` : "") +
              (sweepDropped ? ` dropped=${sweepDropped} (cap ${SWEEP_MAX_FILES})` : ""),
          );
        }
```

- `outbound` 合流（`:2769-2774`）只把 sweep 的 **attachments** 并入（empty/oversized/dropped **不并**——那三个字段驱动「wasn't sent / too large」的用户可见 issue 文案，sweep 的对应类目只属于 operator log）：

```ts
        const outbound = {
          attachments: [
            ...outboundScoped.attachments,
            ...outboundScratch.attachments,
            ...sweepScoped.attachments,
            ...sweepScratch.attachments,
          ],
          oversized: [...outboundScoped.oversized, ...outboundScratch.oversized],
          empty: [...outboundScoped.empty, ...outboundScratch.empty],
          dropped: outboundScoped.dropped + outboundScratch.dropped,
        };
```

- delivery entry 文本（`:2815`）加尾注参数；**hidden tape note（`:2835`）保持单参数不变**（执行期留意 ②）：

```ts
                text: deliveryManifest(
                  outbound.attachments,
                  sweepOverflow.length ? { count: sweepOverflow.length, names: sweepOverflow } : undefined,
                ),
```

（`turnStart` 在 `:2343` 定义、`automatedTurn` 在 `:402` 定义，收口块均在作用域内。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test test/orchestrator.test.ts test/surface-post-files.test.ts`
Expected: PASS（既有用例无回归——特别注意「off by default」用例证明开关关闭时行为逐字节不变）

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck && npm run lint:ox`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/orchestrator.ts src/core/orchestrator/surface-tools.ts test/orchestrator.test.ts test/surface-post-files.test.ts
git commit -m "feat(core): sweep undelivered DM turn outputs into delivery at turn close (#24)"
```

---

### Task 4: pi-tools.ts——FILE_SEND_GUIDANCE 补后台任务交付边界

**Files:**
- Modify: `src/harness/pi-tools.ts:627-628`（`FILE_SEND_GUIDANCE` 字符串）

**Interfaces:**
- Consumes: 无（独立文案改动）。
- Produces: 无新接口。

- [ ] **Step 1: Implement（文案单点改动，行为断言由既有测试把守）**

`FILE_SEND_GUIDANCE` 末尾（`...then attach it from a live turn. ` 之后）追加一句：

```ts
    " Files a background job writes to the workspace after its turn has ended are not collected automatically — attach them from a live turn once the job finishes.";
```

（原字符串以空格结尾、新句带前导空格拼接，保持与现有书写风格一致。该句在开关关/开两种形态下均为真：上游开关关闭时任何 workspace 文件都不自动收集；桌面开关开启时 sweep 也只覆盖 turn 窗口内。）

- [ ] **Step 2: Run tests**

Run: `node --experimental-test-module-mocks --test test/pi-tools.test.ts`
Expected: PASS（无针对该文案逐字断言的既有用例——若有挂掉的描述断言，同步更新）

- [ ] **Step 3: Commit**

```bash
git add src/harness/pi-tools.ts
git commit -m "feat(core): note background-job delivery boundary in file-send guidance (#24)"
```

---

### Task 5: 桌面 proc.rs——env 注入开启开关

**Files:**
- Modify: `deploy/layers/meerkat/desktop/src-tauri/src/proc.rs:261`（`.env("ALLOW_LOCAL_SKILL_PACKS", "1")` 之后）

**Interfaces:**
- Consumes: Task 2 的 `DELIVER_WORKSPACE_OUTPUTS` env 名（逐字固定）。
- Produces: 无。

- [ ] **Step 1: Implement**

`.env("ALLOW_LOCAL_SKILL_PACKS", "1")` 行之后插一行：

```rust
                .env("DELIVER_WORKSPACE_OUTPUTS", "1")
```

- [ ] **Step 2: 编译验证**

Run（在 `deploy/layers/meerkat/desktop/src-tauri/` 下）: `cargo check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add deploy/layers/meerkat/desktop/src-tauri/src/proc.rs
git commit -m "feat(desktop): enable workspace output delivery via env (#24)"
```

（真机验证归发布流程：打包后让 agent 生成文件、不显式交付，断言「文件」面板可见 + 聊天挂卡；cp 进 `$AGENT_OUTBOX` 的场景断言不双卡。）

---

## Self-Review 记录

- **Spec coverage**：设计文档 §1（Task 3：`:sweep` seed、合流、扫描根）、§2（Task 2 + Task 5）、§3（Task 1：`workspaceSweepCommand` 毫秒精度 + prune）、§4（Task 1：上限/卡片额度；Task 3：尾注载体 + operator log）、§5（Task 1：双集合 + hashes 返回；Task 3：tracker 穿线 + resolveFiles 记录）、§6（Task 4）、§7（Task 3：automated turn 排除；其余为声明性边界）、§8 测试 8 用例 → Task 1 单测 7 个 + file-sharing/surface-post-files 3 个 + Task 3 集成 6 个 + surface-tools 单测 1 个（测试 ② post 去重按 Global Constraints ③ 组合覆盖）、§9 ADR-012 已就位、§10 不做项未越界。
- **Type consistency**：`DeliveredTracker`/`collectWorkspaceSweep` 签名在 Task 1 Produces 与 Task 3 Consumes 逐字一致；`hashes` 字段名三个文件一致；`deliverWorkspaceOutputs`（Config camelCase / deps 同名）与 `DELIVER_WORKSPACE_OUTPUTS`（env）逐字一致。
- **已知留白（执行期核证，非 placeholder）**：`test/config.test.ts` 的 env 解析用例确切写法照 `allowLocalSkillPacks` 先例；`test/surface-post-files.test.ts` 成功 post 的 fake 通路照文件内既有用例补齐；`orchestrator.ts` 的 attachments import 行精确位置以 `:103` 附近现状为准。

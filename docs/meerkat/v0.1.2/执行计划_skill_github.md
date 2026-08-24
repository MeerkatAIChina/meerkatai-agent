# v0.1.2 执行计划

## skill 快照随包内置，GitHub 降级为更新通道（issue #6）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面版首启 skill pack 改从随包快照本地导入（无网络、无 git 依赖），GitHub 降级为「启动单次 + 手动」的更新通道，失败静默不轰炸。

**Architecture:** 构建期 `stage-payload` 把 GitHub 仓库 `git clone --depth 1` 物化为 `payload/skillpacks/<slug>/` 快照（含 `.skillpack-meta.json` commit 指纹）并生成种子；core fetcher 对带 meta 标记的本地快照跳过 git 直读目录（ADR-003）；`SkillPack.upstreamUrl` 承载更新通道地址，import 走 `url`（本地）、sync 走 `upstreamUrl`（GitHub）（ADR-004）；web-ui 启动任务重写为「注册/匹配/迁移 → 本地导入（幂等跳过）→ 单次 onlyIfUpdate sync」；splash 加技能包黄灯行。

**Tech Stack:** TypeScript（node:test 测试）、PowerShell/Bash 构建脚本、Tauri 2（Rust，ureq 已在依赖）、plain HTML/JS splash。

**Spec:** [设计文档.md](./设计文档.md)「skill 快照随包内置」一节；ADR：[ADR.md](./ADR.md) ADR-003/ADR-004；调研：[需求调研.md](./需求调研.md)「Bug」一节。

### Global Constraints

- **零注释**（AGENTS.md）：不写任何解释性注释、docblock、TODO、注释掉的代码；意图用命名、结构、测试表达。解释器 shebang 除外。
- **Fix every instance**：同一模式的所有实例一起改（本计划显式列出每一处，如 `recordImport` 保留 commit 共 4 处）。
- **认证闸门**：web-ui 所有 `/api/*` 路由统一过 `cookieUser`（`index.ts:2758-2760`），无凭据一律 401；任何对 `/api/desktop/*` 的调用（测试、Tauri command）都必须携带 portal identity。
- **Solve at the layer all paths flow through**：共享逻辑放共享层（`upstreamSource` 放 `skill-pack-store.ts`，不进调用方各写一份）。
- **只跑受影响测试 + typecheck + lint**，不跑全套（AGENTS.md）；CI 是全量闸门。
- 文档与输出用中文；提交信息沿用仓库风格 `type(scope): subject`（英文）。
- 环境：Windows + PowerShell；bash 脚本经 Git Bash 执行；Node ≥ 24.15（`node --test` 直接跑 .ts）。
- root 测试命令形如 `node --experimental-test-module-mocks --test test/<file>.test.ts`；web-ui 测试在 `plugins/web-ui` 下、需 `NODE_ENV=test ALLOW_UNSIGNED_TEST_IDENTITY=1`。
- 每个 Task 结束：受影响测试绿 + `npm run typecheck`（web-ui 改动跑 `plugins/web-ui` 的 `npm run typecheck`）+ commit。

---

### Task 1: core — pack-fetcher 本地快照直读（ADR-003）

**Files:**
- Modify: `src/skills/pack-fetcher.ts`（`SHA_RE` 定义后加快照元数据读取；`fetch`/`resolveRef` 各加一个提前分支）
- Test: `test/pack-fetcher.test.ts`

**Interfaces:**
- Produces: 带 `.skillpack-meta.json` 的本地目录被 `fetch`/`resolveRef` 直读，commit 取自元数据；无 meta 的本地路径行为不变（后续 Task 全部依赖此语义）。meta 文件自身不进 `repo.files`。

- [ ] **Step 1: 写失败测试**

在 `test/pack-fetcher.test.ts` 末尾追加（文件已有 `mkdtempSync/mkdirSync/writeFileSync/rmSync/readFileSync` 等 import 与 `src(...)` fixture）：

```ts
const SNAPSHOT_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function makeSnapshot(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-snap-fixture-"));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: d\nscope: company\n---\n# Body",
  );
  writeFileSync(
    join(dir, ".skillpack-meta.json"),
    JSON.stringify({
      upstreamUrl: "https://example.com/org/repo.git",
      ref: "main",
      commit: SNAPSHOT_COMMIT,
      snapshotAt: "2026-08-20T00:00:00Z",
    }),
  );
  return { dir, commit: SNAPSHOT_COMMIT };
}

test("snapshot pack: fetch reads the tree directly with no git, commit from metadata", async () => {
  const { dir, commit } = makeSnapshot();
  try {
    const f = createGitFetcher({ allowLocalRepos: true, gitBin: "definitely-not-a-git-binary" });
    const repo = await f.fetch(src({ url: dir, ref: "main" }));
    assert.equal(repo.commit, commit);
    assert.ok(repo.files.some((x) => x.path === "skills/demo/SKILL.md"));
    assert.ok(!repo.files.some((x) => x.path === ".skillpack-meta.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot pack: resolveRef returns the metadata commit with no git", async () => {
  const { dir, commit } = makeSnapshot();
  try {
    const f = createGitFetcher({ allowLocalRepos: true, gitBin: "definitely-not-a-git-binary" });
    assert.equal(await f.resolveRef(src({ url: dir, ref: "main" })), commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt snapshot metadata fails explicitly", async () => {
  const { dir } = makeSnapshot();
  try {
    const f = createGitFetcher({ allowLocalRepos: true, gitBin: "definitely-not-a-git-binary" });
    writeFileSync(join(dir, ".skillpack-meta.json"), "not json");
    await assert.rejects(() => f.fetch(src({ url: dir, ref: "main" })), /snapshot metadata is corrupt/);
    writeFileSync(join(dir, ".skillpack-meta.json"), JSON.stringify({ commit: "not-a-sha" }));
    await assert.rejects(() => f.resolveRef(src({ url: dir, ref: "main" })), /snapshot metadata is corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

注：`gitBin: "definitely-not-a-git-binary"` 是「零 git 调用」的活证据——任何 git 子进程调用都会 ENOENT 炸掉。legacy 路径回归由文件首部既有测试把守（`fetches the tree at a pinned sha`，本地 repo 无 meta、走 git clone），不重复写。

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --experimental-test-module-mocks --test test/pack-fetcher.test.ts
```

预期：3 个新测试 FAIL（snapshot 场景走 git clone 报 ENOENT 或 commit 不符）。

- [ ] **Step 3: 实现**

`src/skills/pack-fetcher.ts`，在 `SHA_RE` 定义（163 行）之后加：

```ts
const SNAPSHOT_META_FILE = ".skillpack-meta.json";

async function readSnapshotCommit(dir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, SNAPSHOT_META_FILE), "utf8");
  } catch {
    return null;
  }
  let commit: unknown;
  try {
    commit = (JSON.parse(raw) as { commit?: unknown }).commit;
  } catch {
    throw new Error(`skill pack snapshot metadata is corrupt: ${dir}`);
  }
  if (typeof commit !== "string" || !SHA_RE.test(commit)) {
    throw new Error(`skill pack snapshot metadata is corrupt: ${dir}`);
  }
  return commit;
}
```

`fetch` 中 `const repo = await validateRepoUrl(...)`（277 行）之后、`resolveAuth` 之前插入：

```ts
if (allowLocal && isLocalRepoPath(repo.url)) {
  const snapshotCommit = await readSnapshotCommit(repo.url);
  if (snapshotCommit) {
    const files = (await readTree(repo.url)).filter((f) => f.path !== SNAPSHOT_META_FILE);
    return { commit: snapshotCommit, files };
  }
}
```

`resolveRef` 中 `const repo = await validateRepoUrl(...)`（297 行）之后同样插入：

```ts
if (allowLocal && isLocalRepoPath(repo.url)) {
  const snapshotCommit = await readSnapshotCommit(repo.url);
  if (snapshotCommit) return snapshotCommit;
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node --experimental-test-module-mocks --test test/pack-fetcher.test.ts
```

预期：全绿（含既有 legacy 测试）。

- [ ] **Step 5: typecheck + lint + commit**

```powershell
npm run typecheck; npm run lint:ox
git add src/skills/pack-fetcher.ts test/pack-fetcher.test.ts
git commit -m "feat(core): read bundled skill pack snapshots directly, skipping git (ADR-003)"
```

---

### Task 2: core — `SkillPack.upstreamUrl` 字段 + `upstreamSource` helper

**Files:**
- Modify: `src/skills/skill-pack-store.ts`
- Test: `test/skill-pack-store.test.ts`

**Interfaces:**
- Produces: `SkillPack.upstreamUrl?: string`（软字段，DurableMap 整条 JSON 存取，无迁移）；`upstreamSource(pack: SkillPack): SkillPack`——有 `upstreamUrl` 时返回 `{...pack, url: upstreamUrl, local: false}`，否则原样返回。Task 4（app-skills）与 Task 5（sync-engine）消费它。`local: false` 必须显式（否则 `permitsLocal` 仍为 true，语义不干净——设计评审实现注意）。

- [ ] **Step 1: 写失败测试**

先看 `test/skill-pack-store.test.ts` 现有 fixture 写法，追加（若文件风格不同则对齐其风格，断言不变）：

```ts
import { upstreamSource } from "../src/skills/skill-pack-store.ts";

test("upstreamSource swaps the fetch url to upstreamUrl and clears local", async () => {
  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "C:\\payload\\skillpacks\\triz",
    ref: "main",
    syncMode: "pinned",
    trustTier: "internal",
    targetScopeId: "org:acme",
    subset: "all",
    createdBy: "u",
    local: true,
    upstreamUrl: "https://github.com/org/repo.git",
  });
  const src = upstreamSource(pack);
  assert.equal(src.url, "https://github.com/org/repo.git");
  assert.equal(src.local, false);
  assert.equal(src.upstreamUrl, "https://github.com/org/repo.git");
});

test("upstreamSource returns the pack unchanged without upstreamUrl", async () => {
  const packs = createSkillPackStore();
  const pack = await packs.create({
    kind: "git",
    url: "https://github.com/org/repo.git",
    ref: "main",
    syncMode: "pinned",
    trustTier: "internal",
    targetScopeId: "org:acme",
    subset: "all",
    createdBy: "u",
  });
  assert.equal(upstreamSource(pack).url, "https://github.com/org/repo.git");
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --experimental-test-module-mocks --test test/skill-pack-store.test.ts
```

预期：编译/导入错误（`upstreamSource` 不存在）。

- [ ] **Step 3: 实现**

`src/skills/skill-pack-store.ts`：`SkillPack` 接口 `authCredentialSlug?: string;` 之后加 `upstreamUrl?: string;`；文件末尾（store 工厂之后）加：

```ts
export function upstreamSource(pack: SkillPack): SkillPack {
  const upstream = pack.upstreamUrl?.trim();
  return upstream ? { ...pack, url: upstream, local: false } : pack;
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```powershell
node --experimental-test-module-mocks --test test/skill-pack-store.test.ts
npm run typecheck
```

预期：全绿。typecheck 可能暴露其他构造 `SkillPack` 字面量的地方缺字段——`upstreamUrl` 是可选字段，不应有破坏；若有报错，按报错补齐。

- [ ] **Step 5: Commit**

```powershell
git add src/skills/skill-pack-store.ts test/skill-pack-store.test.ts
git commit -m "feat(core): add SkillPack.upstreamUrl with upstreamSource helper (ADR-004)"
```

---

### Task 3: core — routes 接受 `upstreamUrl`；patch 放开 `local`（含守卫）

**Files:**
- Modify: `src/api/routes/skill-packs.ts`
- Modify: `src/api/deps.ts`（`ServerDeps` 加字段）
- Modify: `src/wiring.ts`（`serverDeps()` 透传）
- Test: `test/skill-packs-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SkillPack.upstreamUrl`。
- Produces: `POST /v1/admin/skill-packs` 接受 `upstreamUrl`（https、无内嵌凭据，否则 400）；`PATCH /v1/admin/skill-packs/:id` 接受 `upstreamUrl` 与 `local:true`（守卫：`ctx.deps.allowLocalSkillPacks` 开启 ∧ 最终 url 为本地路径，否则 400）。Task 6（web-ui 迁移老 pack）依赖此守卫路径。

- [ ] **Step 1: 写失败测试**

`test/skill-packs-routes.test.ts` 已有 `start()`（`buildApp(testConfig(...))` + `createInsecureTestServer`）与 `makeFixtureRepo()`。追加一个带 local 开关的启动器与测试：

```ts
function startLocal() {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reg-routes-")), allowLocalSkillPacks: true }),
  );
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
    allowLocalSkillPacks: true,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("register accepts a validated https upstreamUrl and rejects bad ones", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const ok = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, upstreamUrl: "https://github.com/org/repo.git" }),
      }),
    );
    assert.equal(ok.pack.upstreamUrl, "https://github.com/org/repo.git");
    for (const bad of ["http://github.com/org/repo.git", "https://user:pw@github.com/org/repo.git", "not a url"]) {
      const r = await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, upstreamUrl: bad }),
      });
      assert.equal(r.status, 400, bad);
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("patch migrates a github-url pack to local snapshot + upstreamUrl under the local-packs flag", async () => {
  const repo = makeFixtureRepo();
  const s = startLocal();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: "https://github.com/org/repo.git", ref: "main" }),
      }),
    );
    const id = reg.pack.id as string;
    const patched = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
        method: "PATCH",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, upstreamUrl: "https://github.com/org/repo.git", local: true }),
      }),
    );
    assert.equal(patched.pack.url, repo.dir);
    assert.equal(patched.pack.upstreamUrl, "https://github.com/org/repo.git");
    assert.equal(patched.pack.local, true);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("patch local:true is rejected without the server flag or with a non-local url", async () => {
  const repo = makeFixtureRepo();
  const s = startLocal();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: "https://github.com/org/repo.git", ref: "main" }),
      }),
    );
    const id = reg.pack.id as string;
    const nonLocal = await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
      method: "PATCH",
      headers: ADMIN,
      body: JSON.stringify({ local: true }),
    });
    assert.equal(nonLocal.status, 400, "url stays remote");
    const s2 = start();
    try {
      const reg2 = await json(
        await fetch(`${s2.base}/v1/admin/skill-packs`, {
          method: "POST",
          headers: ADMIN,
          body: JSON.stringify({ url: repo.dir, ref: repo.sha }),
        }),
      );
      const noFlag = await fetch(`${s2.base}/v1/admin/skill-packs/${reg2.pack.id}`, {
        method: "PATCH",
        headers: ADMIN,
        body: JSON.stringify({ local: true }),
      });
      assert.equal(noFlag.status, 400, "server without the flag");
    } finally {
      await s2.close();
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --experimental-test-module-mocks --test test/skill-packs-routes.test.ts
```

预期：upstreamUrl 被忽略/校验不存在、patch local 被忽略 → 断言 FAIL。

- [ ] **Step 3: 实现**

`src/api/deps.ts` `ServerDeps`（58 行起）加字段：

```ts
allowLocalSkillPacks?: boolean;
```

`src/wiring.ts` `serverDeps()`（1613 行附近，`production:` 一行后）加：

```ts
...(config.allowLocalSkillPacks ? { allowLocalSkillPacks: true } : {}),
```

`src/api/routes/skill-packs.ts`：加校验 helper（放在 `asConfig` 之后）：

```ts
function asUpstreamUrl(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) return null;
  const trimmed = v.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return trimmed;
}
```

`registerPack` 中 `const allowLocal = ...` 之后加校验，`input` 加字段：

```ts
const upstreamUrl = asUpstreamUrl(b.upstreamUrl);
if (upstreamUrl === null) {
  return sendJson(ctx.res, 400, { error: "bad_request", message: "upstreamUrl must be a credential-free https url" });
}
```

```ts
...(upstreamUrl ? { upstreamUrl } : {}),
```

`patchPack` 中 `if (b.config !== undefined) ...` 之后加：

```ts
if (b.upstreamUrl !== undefined) {
  const upstreamUrl = asUpstreamUrl(b.upstreamUrl);
  if (!upstreamUrl) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "upstreamUrl must be a credential-free https url" });
  }
  patch.upstreamUrl = upstreamUrl;
}
if (b.local === true) {
  const current = await ctx.app.getSkillPack(ctx.params.id!);
  const targetUrl = typeof patch.url === "string" ? patch.url : (current?.url ?? "");
  if (!ctx.deps.allowLocalSkillPacks || !isLocalRepoPath(targetUrl)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "local:true requires ALLOW_LOCAL_SKILL_PACKS and a local-path url",
    });
  }
  patch.local = true;
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```powershell
node --experimental-test-module-mocks --test test/skill-packs-routes.test.ts
npm run typecheck
```

预期：全绿。若 `createInsecureTestServer` 的 deps 类型不含 `allowLocalSkillPacks` 报 TS 错，确认 `ServerOptions = Omit<ServerDeps, "control">`（`src/api/server.ts:443`）会自动带上——deps.ts 字段加对即可。

- [ ] **Step 5: Commit**

```powershell
git add src/api/routes/skill-packs.ts src/api/deps.ts src/wiring.ts test/skill-packs-routes.test.ts
git commit -m "feat(core): accept upstreamUrl on skill pack register/patch; guarded local:true patch for migration"
```

---

### Task 4: core — app-skills `onlyIfUpdate`、upstream 抓取源、失败保留 commit

**Files:**
- Modify: `src/api/app-types.ts:457`（签名扩展）
- Modify: `src/api/app-skills.ts`（`reconcilePack` 抓取源参数 + 4 处失败路径保留 commit + `syncSkillPack` 的 onlyIfUpdate）
- Modify: `src/api/routes/skill-packs.ts`（`syncPack` 透传 `onlyIfUpdate`）
- Test: `test/skill-packs-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `upstreamSource`。
- Produces: `App.syncSkillPack(id: string, opts?: { onlyIfUpdate?: boolean }): Promise<ImportResult & { upToDate?: boolean }>`。`onlyIfUpdate` 且 `lastImport.status==="ok"` 且 upstream HEAD 一致 → 返回 `{imported:[],updated:[],skipped:[],archived:[],counts,upToDate:true}`，不抓取。sync 类失败（resolveRef/fetch/apply/register 抓取共 4 处）`recordImport` 的 commit 一律 `pack.lastImport?.commit ?? pack.ref`。Task 6 依赖 `upToDate` 响应字段。

- [ ] **Step 1: 写失败测试**

`test/skill-packs-routes.test.ts` 追加（快照 fixture 与 Task 1 的 `makeSnapshot` 同构，本文件内新写一个走 HTTP 的版本）：

```ts
const SNAP_COMMIT_1 = "1111111111111111111111111111111111111111";
const SNAP_COMMIT_2 = "2222222222222222222222222222222222222222";

function makeSnapshotDir(commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-snap-routes-"));
  mkdirSync(join(dir, "skills", "snap-demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "snap-demo", "SKILL.md"), md("name: snap-demo\ndescription: d\nscope: company"));
  writeFileSync(
    join(dir, ".skillpack-meta.json"),
    JSON.stringify({ upstreamUrl: "https://example.com/org/repo.git", ref: "main", commit, snapshotAt: "2026-08-20T00:00:00Z" }),
  );
  return dir;
}

async function registerAndImport(base: string, dir: string): Promise<string> {
  const reg = await json(
    await fetch(`${base}/v1/admin/skill-packs`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ url: dir, ref: "main", allowLocal: true, trustTier: "internal", subset: "all" }),
    }),
  );
  const id = reg.pack.id as string;
  const imp = await fetch(`${base}/v1/admin/skill-packs/${id}/import`, {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ selected: "all" }),
  });
  assert.equal(imp.status, 200);
  return id;
}

test("sync onlyIfUpdate skips the fetch when upstream HEAD matches the last good commit", async () => {
  const dir = makeSnapshotDir(SNAP_COMMIT_1);
  const s = start();
  try {
    const id = await registerAndImport(s.base, dir);
    const sync = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ onlyIfUpdate: true }),
      }),
    );
    assert.equal(sync.upToDate, true);
    writeFileSync(
      join(dir, ".skillpack-meta.json"),
      JSON.stringify({ ref: "main", commit: SNAP_COMMIT_2, snapshotAt: "2026-08-20T01:00:00Z" }),
    );
    const sync2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ onlyIfUpdate: true }),
      }),
    );
    assert.notEqual(sync2.upToDate, true);
    const packs = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(packs.packs.find((p: { id: string }) => p.id === id).lastImport.commit, SNAP_COMMIT_2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a failed sync preserves the last good commit", async () => {
  const dir = makeSnapshotDir(SNAP_COMMIT_1);
  const s = start();
  try {
    const id = await registerAndImport(s.base, dir);
    await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
        method: "PATCH",
        headers: ADMIN,
        body: JSON.stringify({ url: join(dir, "does-not-exist") }),
      }),
    );
    const sync = await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({}),
    });
    assert.notEqual(sync.status, 200);
    const packs = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    const pack = packs.packs.find((p: { id: string }) => p.id === id);
    assert.equal(pack.lastImport.status, "error");
    assert.equal(pack.lastImport.commit, SNAP_COMMIT_1, "the last good commit survives the failed sync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});
```

注：第二个用例 PATCH 改 url 到不存在目录后走不带 onlyIfUpdate 的 sync，覆盖 `reconcilePack` fetch 失败路径；`onlyIfUpdate` 入口的 resolveRef 失败路径由同一保留逻辑覆盖（实现是同一行模式）。

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --experimental-test-module-mocks --test test/skill-packs-routes.test.ts
```

预期：`upToDate` 字段不存在、失败后 commit 变成 `"main"` → FAIL。

- [ ] **Step 3: 实现**

`src/api/app-types.ts:457`：

```ts
syncSkillPack(id: string, opts?: { onlyIfUpdate?: boolean }): Promise<ImportResult & { upToDate?: boolean }>;
```

`src/api/app-skills.ts`：

1. 顶部 import 更新：`import type { SkillPack, SkillPackStore } from "../skills/skill-pack-store.ts";` 改为同时引入值：`import { upstreamSource, type SkillPack, type SkillPackStore } from "../skills/skill-pack-store.ts";`
2. `reconcilePack`（98 行）签名加末参 `source?: SkillPack`，fetch 行（109）改：

```ts
repo = await fetcher.fetch(source ?? pack);
```

3. **4 处失败路径保留 commit**（AGENTS.md「Fix every instance」——现存 3 处全部统一 + 新增 1 处）：
   - `reconcilePack` fetch 失败（113 行）；
   - `applyFetched` 的 catch（179 行）；
   - `registerSkillPack` 抓取失败（310 行）——新建 pack 无 `lastImport`，`?? pack.ref` 与原式等值，统一只为消灭模式分叉；
   - 下面 `syncSkillPack` 新增的 onlyIfUpdate 预检 catch。

   统一改为：

```ts
commit: pack.lastImport?.commit ?? pack.ref,
```

4. `syncSkillPack`（357 行）整体改为：

```ts
async syncSkillPack(id, opts) {
  const { packs, fetcher } = requireRegistry(deps);
  const pack = await packs.get(id);
  if (!pack) throw new Error(`unknown skill pack: ${id}`);
  if (opts?.onlyIfUpdate) {
    let head: string;
    try {
      head = await fetcher.resolveRef(upstreamSource(pack));
    } catch (e) {
      await packs.recordImport(id, {
        at: Date.now(),
        commit: pack.lastImport?.commit ?? pack.ref,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    if (pack.lastImport?.status === "ok" && head === pack.lastImport.commit) {
      return {
        imported: [],
        updated: [],
        skipped: [],
        archived: [],
        counts: pack.lastImport.counts ?? {},
        upToDate: true,
      };
    }
  }
  const importedByScope = new Map<ScopeId, string[]>();
  for (const { scopeId, upstreamName } of await importedPackSkills(deps, id)) {
    const arr = importedByScope.get(scopeId) ?? [];
    arr.push(upstreamName);
    importedByScope.set(scopeId, arr);
  }
  const targets = [...importedByScope].map(([scopeId, selected]) => ({ scopeId, selected }));
  if (!targets.length) targets.push({ scopeId: pack.targetScopeId, selected: [] });
  return reconcilePack(deps, packs, fetcher, id, targets, upstreamSource(pack));
},
```

`src/api/routes/skill-packs.ts` `syncPack`（142 行）改为透传：

```ts
async function syncPack(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return;
  const body = (ctx.body as Record<string, unknown> | null) ?? {};
  const result = await ctx.app.syncSkillPack(ctx.params.id!, { onlyIfUpdate: body.onlyIfUpdate === true });
  audit(ctx.deps, {
    principalId: actor.id,
    action: "skill_pack.sync",
    resource: ctx.params.id!,
    scopeLabel: orgScope(ctx.deps),
  });
  sendJson(ctx.res, 200, result);
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```powershell
node --experimental-test-module-mocks --test test/skill-packs-routes.test.ts
node --experimental-test-module-mocks --test test/skill-sync-engine.test.ts
npm run typecheck
```

预期：全绿（sync-engine 测试不应受影响——它注入假 fetcher，绕过 app 层）。

- [ ] **Step 5: Commit**

```powershell
git add src/api/app-types.ts src/api/app-skills.ts src/api/routes/skill-packs.ts test/skill-packs-routes.test.ts
git commit -m "feat(core): sync skill packs from upstreamUrl with onlyIfUpdate; preserve last good commit on failure"
```

---

### Task 5: core — sync-engine 走 upstream 源

**Files:**
- Modify: `src/skills/skill-sync-engine.ts`
- Test: `test/skill-sync-engine.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `upstreamSource`。
- Produces: `syncOne` 的 `resolveRef` 对带 `upstreamUrl` 的 pack 解析 GitHub HEAD（周期 tick 开启的部署形态生效；桌面无 tick，行为不变）。

- [ ] **Step 1: 写失败测试**

`test/skill-sync-engine.test.ts` 末尾追加：

```ts
test("pack with upstreamUrl resolves the ref against the upstream source", async () => {
  const packs = createSkillPackStore();
  const s = await packs.create({
    ...base,
    syncMode: "pinned",
    ref: "c1",
    url: "C:\\payload\\skillpacks\\triz",
    local: true,
    upstreamUrl: "https://github.com/org/repo.git",
  });
  await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
  const seen: Array<{ url: string; local: unknown }> = [];
  const fetcher: SkillPackFetcher = {
    fetch: () => {
      throw new Error("the engine must not full-clone directly");
    },
    resolveRef: async (p) => {
      seen.push({ url: p.url, local: p.local });
      return "c2";
    },
  };
  const engine = createSkillSyncEngine({ packs, fetcher, reconcile: async () => {} });
  await engine.tick();
  assert.deepEqual(seen, [{ url: "https://github.com/org/repo.git", local: false }]);
  assert.equal((await packs.get(s.id))?.updateAvailable, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --experimental-test-module-mocks --test test/skill-sync-engine.test.ts
```

预期：FAIL（seen 里是本地 url）。

- [ ] **Step 3: 实现**

`src/skills/skill-sync-engine.ts`：`syncOne` 里两次 `await deps.fetcher.resolveRef(pack)`（30、34 行）合并上提为一次、走 upstream 源（顺带消除重复调用，符合「simpler not more complex」）：

```ts
import { upstreamSource, type SkillPackStore } from "./skill-pack-store.ts";
```

```ts
async function syncOne(packId: string): Promise<void> {
  const pack = await deps.packs.get(packId);
  if (!pack) return;
  const head = await deps.fetcher.resolveRef(upstreamSource(pack));
  if (pack.syncMode === "tracked") {
    if (pack.lastImport?.status === "ok" && head === pack.lastImport.commit) return;
    await deps.reconcile(packId);
  } else {
    const available = pack.lastImport ? head !== pack.lastImport.commit : false;
    if (available !== Boolean(pack.updateAvailable)) {
      await deps.packs.update(packId, { updateAvailable: available });
    }
  }
}
```

注意 import 行原本是 `import type { SkillPackStore } ...`，改为值+类型混合导入。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```powershell
node --experimental-test-module-mocks --test test/skill-sync-engine.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```powershell
git add src/skills/skill-sync-engine.ts test/skill-sync-engine.test.ts
git commit -m "feat(core): resolve skill sync refs against upstreamUrl when present"
```

---

### Task 6: web-ui — 启动任务重构 + 状态端点

**Files:**
- Modify: `plugins/web-ui/server/index.ts`（`SeedSkillPack`、`ensureSkillPacks` 重写、新增状态端点）
- Test: `plugins/web-ui/test/skillpacks-desktop.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 meta 直读（core 侧）、Task 3 的 register/patch `upstreamUrl` 与 `local` 迁移守卫、Task 4 的 `sync {onlyIfUpdate}` 与 `upToDate` 响应。
- Produces: `GET /api/desktop/skill-packs/status` → `{packs: [{name, phase: "pending"|"importing"|"ready"|"degraded", detail?, updateAvailable?}]}`；种子新增字段 `name`/`upstreamUrl`；`url` 支持相对 payload 根的路径。Task 7（构建脚本生成种子）与 Task 8（splash 轮询）依赖此形状。

- [ ] **Step 1: 写失败测试**

新建 `plugins/web-ui/test/skillpacks-desktop.test.ts`。模式：mock core 持有状态（参照 `deployments-server-route.test.ts`），portal token 触发现有 `authenticate → maybeStartSkillPacks` 链路（参照 `signed-identity.test.ts` 的 `mintPortalIdentity`）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const META_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const payload = mkdtempSync(join(tmpdir(), "meerkat-payload-"));
mkdirSync(join(payload, "config", "seeds"), { recursive: true });
mkdirSync(join(payload, "skillpacks", "triz", "skills", "demo"), { recursive: true });
writeFileSync(
  join(payload, "skillpacks", "triz", ".skillpack-meta.json"),
  JSON.stringify({ upstreamUrl: "https://github.com/org/triz.git", ref: "main", commit: META_COMMIT, snapshotAt: "2026-08-20T00:00:00Z" }),
);
writeFileSync(join(payload, "skillpacks", "triz", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
writeFileSync(
  join(payload, "config", "seeds", "skillpacks.json"),
  JSON.stringify({
    packs: [
      { name: "triz", url: "skillpacks/triz", upstreamUrl: "https://github.com/org/triz.git", ref: "main", local: true },
    ],
  }),
);

interface PackState {
  id: string;
  url: string;
  upstreamUrl?: string;
  local?: boolean;
  lastImport?: { at: number; commit: string; status: string };
}
const state: { packs: PackState[]; registers: unknown[]; imports: string[]; syncs: unknown[]; patches: unknown[] } = {
  packs: [],
  registers: [],
  imports: [],
  syncs: [],
  patches: [],
};

const core = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const u = new URL(req.url ?? "/", "http://core");
    const send = (obj: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/v1/admin/whoami") return send({ isAdmin: true });
    if (u.pathname === "/v1/admin/skill-packs" && req.method === "GET") return send({ packs: state.packs });
    if (u.pathname === "/v1/admin/skill-packs" && req.method === "POST") {
      state.registers.push(body);
      const pack: PackState = { id: "p1", url: String(body.url), ...(body.upstreamUrl ? { upstreamUrl: String(body.upstreamUrl) } : {}) };
      state.packs = [pack];
      return send({ pack });
    }
    const m = u.pathname.match(/^\/v1\/admin\/skill-packs\/([^/]+)(?:\/(import|sync))?$/);
    if (m && req.method === "PATCH") {
      state.patches.push(body);
      const cur = state.packs[0];
      state.packs = [{ ...cur, ...(body as object) } as PackState];
      return send({ pack: state.packs[0] });
    }
    if (m && m[2] === "import") {
      state.imports.push(m[1]);
      state.packs = [{ ...state.packs[0], lastImport: { at: 1, commit: META_COMMIT, status: "ok" } }];
      return send({ imported: ["demo"], updated: [], skipped: [], archived: [], counts: {} });
    }
    if (m && m[2] === "sync") {
      state.syncs.push(body);
      return send({ imported: [], updated: [], skipped: [], archived: [], counts: {}, upToDate: true });
    }
    send({});
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "skillpacks-desktop-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.MEERKAT_DESKTOP = "1";
process.env.MEERKAT_SEEDS_DIR = join(payload, "config", "seeds");

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
  rmSync(payload, { recursive: true, force: true });
});

const waitFor = async (phase: string, token: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await fetch(`${base}/api/desktop/skill-packs/status`, {
      headers: { [PORTAL_IDENTITY_HEADER]: token },
    });
    const body = (await r.json()) as { packs?: Array<Record<string, unknown>> };
    const pack = body.packs?.find((p) => p.name === "triz");
    if (pack?.phase === phase) return pack;
    if (Date.now() > deadline) throw new Error(`timed out waiting for phase ${phase}; last: ${JSON.stringify(body)}`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
};

test("first boot: resolves the relative seed url, registers with upstreamUrl, imports, syncs once", async () => {
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  await fetch(`${base}/api/memory`, { headers: { [PORTAL_IDENTITY_HEADER]: token } });
  const pack = await waitFor("ready", token);
  assert.equal(pack.phase, "ready");
  assert.equal(state.registers.length, 1);
  const reg = state.registers[0] as Record<string, unknown>;
  assert.equal(reg.allowLocal, true);
  assert.equal(reg.upstreamUrl, "https://github.com/org/triz.git");
  assert.ok(String(reg.url).endsWith(join("skillpacks", "triz")), `absolute snapshot path, got ${reg.url}`);
  assert.ok(String(reg.url).startsWith(payload), "relative seed url resolved against the payload root");
  assert.equal(state.imports.length, 1);
  assert.equal(state.syncs.length, 1);
  assert.equal((state.syncs[0] as Record<string, unknown>).onlyIfUpdate, true);
});

test("second boot: import skipped when lastImport matches the snapshot commit, sync still runs once", async () => {
  const before = state.imports.length;
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET);
  const r = await fetch(`${base}/api/desktop/skill-packs/retry`, {
    method: "POST",
    headers: { [PORTAL_IDENTITY_HEADER]: token },
  });
  assert.equal(r.status, 200);
  await waitFor("ready", token);
  assert.equal(state.imports.length, before, "no re-import of an unchanged snapshot");
  assert.equal(state.syncs.length, 2);
});
```

注意：第二个用例依赖重跑流程时 `fetchPackList` 返回的 `lastImport.commit === META_COMMIT`（mock 在 import 时写入了）。若真实实现里 `skillPacksRunning` 单飞影响 retry 触发时机，测试用 `waitFor` 轮询兜底。**所有对 `/api/desktop/*` 的调用都必须带 portal token**——`/api/*` 统一过 `cookieUser` 认证闸门（`index.ts:2758-2760`），裸调用一律 401；DESKTOP 下 `authenticate` 认 `x-portal-identity` header 与 `?portal_token=` query（`index.ts:273-275`），且带有效 token 的请求会顺带触发 `maybeStartSkillPacks()`（`index.ts:282-285`），单飞幂等，无害。

- [ ] **Step 2: 跑测试确认失败**

```powershell
cd plugins\web-ui
$env:NODE_ENV="test"; $env:ALLOW_UNSIGNED_TEST_IDENTITY="1"; node --test test/skillpacks-desktop.test.ts
```

预期：FAIL（status 端点 404、retry 走旧流程带退避重试、register 不带 upstreamUrl）。

- [ ] **Step 3: 实现**

`plugins/web-ui/server/index.ts`：

1. `SeedSkillPack`（910 行）扩展，**并同步加宽 `maybeStartSkillPacks` 的类型守卫（923 行）与 `ensureSkillPacks` 形参（937 行）——漏掉这两处 typecheck 必挂**：

```ts
interface SeedSkillPack {
  name?: unknown;
  url?: unknown;
  ref?: unknown;
  local?: unknown;
  upstreamUrl?: unknown;
}
```

```ts
const packs = (seed?.packs ?? []).filter(
  (p): p is SeedSkillPack & { url: string } => typeof p?.url === "string" && p.url.trim().length > 0,
);
```

```ts
async function ensureSkillPacks(packs: Array<SeedSkillPack & { url: string }>): Promise<void> {
```

2. `SEEDS_DIR` 常量（821 行）之后加：

```ts
const PAYLOAD_ROOT = SEEDS_DIR ? join(SEEDS_DIR, "..", "..") : null;

type SkillPackPhase = "pending" | "importing" | "ready" | "degraded";
interface SkillPackStatusEntry {
  name: string;
  phase: SkillPackPhase;
  detail?: string;
  updateAvailable?: boolean;
}
const skillPackStatus = new Map<string, SkillPackStatusEntry>();

function isAbsLocalPath(raw: string): boolean {
  return raw.startsWith("/") || raw.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(raw);
}

function resolveSeedUrl(raw: string): string {
  return isAbsLocalPath(raw) || !PAYLOAD_ROOT ? raw : join(PAYLOAD_ROOT, raw);
}

function readSnapshotCommit(dir: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, ".skillpack-meta.json"), "utf8")) as { commit?: unknown };
    return typeof meta.commit === "string" && meta.commit.trim() ? meta.commit.trim() : null;
  } catch {
    return null;
  }
}
```

注意：`PAYLOAD_ROOT` 的 `"..", ".."` 推导依赖桌面运行时 `MEERKAT_SEEDS_DIR` 恒为 `<payload>/config/seeds`（`proc.rs:294` 注入时写死的布局）；该布局若变，这里必须同步。

3. `ensureSkillPacks`（937-1035 行）：**保留 940-969 行的 admin readiness 等待原样**，把其后的 per-pack 循环（970-1034）整体替换。`fetchPackList` 的返回类型加宽：

```ts
const fetchPackList = async (): Promise<
  Array<{ id: string; url: string; upstreamUrl?: string; lastImport?: { status?: string; commit?: string } }>
> => {
```

per-pack 循环替换为：

```ts
for (const p of packs) {
  const rawUrl = p.url.trim();
  const url = resolveSeedUrl(rawUrl);
  const ref = typeof p.ref === "string" && p.ref.trim() ? p.ref.trim() : "main";
  const upstreamUrl = typeof p.upstreamUrl === "string" && p.upstreamUrl.trim() ? p.upstreamUrl.trim() : undefined;
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : rawUrl;
  const isLocal = p.local === true;
  const snapshotCommit = isLocal ? readSnapshotCommit(url) : null;
  skillPackStatus.set(name, { name, phase: "importing" });
  let packId: string | null = null;
  try {
    const existing = await fetchPackList();
    const found = existing.find(
      (x) => x.url === url || (upstreamUrl !== undefined && (x.url === upstreamUrl || x.upstreamUrl === upstreamUrl)),
    );
    if (found && upstreamUrl && !found.upstreamUrl && found.url === upstreamUrl) {
      const mig = await coreFetch(
        "PATCH",
        `/v1/admin/skill-packs/${found.id}`,
        JSON.stringify({ url, upstreamUrl, local: true }),
        30_000,
        authHeaders(),
      );
      if (mig.status !== 200) throw new Error(`migrate failed (${mig.status}): ${mig.text.slice(0, 200)}`);
      console.log(`[web-ui] skill pack migrated to bundled snapshot (${upstreamUrl})`);
    }
    packId = found?.id ?? null;
    if (!packId) {
      const reg = await coreFetch(
        "POST",
        "/v1/admin/skill-packs",
        JSON.stringify({
          url,
          ref,
          trustTier: "internal",
          subset: "all",
          ...(upstreamUrl ? { upstreamUrl } : {}),
          ...(isLocal ? { allowLocal: true } : {}),
        }),
        60_000,
        authHeaders(),
      );
      if (reg.status !== 200) throw new Error(`register failed (${reg.status}): ${reg.text.slice(0, 200)}`);
      packId = (JSON.parse(reg.text) as { pack?: { id?: string } }).pack?.id ?? null;
      if (!packId) throw new Error("no pack id after register");
    }
    const already =
      snapshotCommit !== null && found?.lastImport?.status === "ok" && found.lastImport.commit === snapshotCommit;
    if (already) {
      console.log(`[web-ui] skill pack snapshot unchanged, import skipped (${name})`);
    } else {
      const imp = await coreFetch(
        "POST",
        `/v1/admin/skill-packs/${packId}/import`,
        JSON.stringify({ selected: "all" }),
        180_000,
        authHeaders(),
      );
      if (imp.status !== 200) throw new Error(`import failed (${imp.status}): ${imp.text.slice(0, 200)}`);
      console.log(`[web-ui] skill pack import ok (${name})`);
    }
    skillPackStatus.set(name, { name, phase: "ready" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    skillPackStatus.set(name, { name, phase: "degraded", detail });
    console.warn(`[web-ui] skill pack local import failed (${name}): ${detail}`);
    continue;
  }
  if (upstreamUrl) {
    try {
      const sync = await coreFetch(
        "POST",
        `/v1/admin/skill-packs/${packId}/sync`,
        JSON.stringify({ onlyIfUpdate: true }),
        180_000,
        authHeaders(),
      );
      if (sync.status !== 200) {
        console.warn(`[web-ui] skill pack upstream sync failed (${sync.status}) ${upstreamUrl}: ${sync.text.slice(0, 200)}`);
      } else {
        const synced = JSON.parse(sync.text) as { upToDate?: boolean };
        console.log(`[web-ui] skill pack upstream sync ${synced.upToDate ? "up-to-date" : "updated"} (${name})`);
      }
    } catch (e) {
      console.warn(`[web-ui] skill pack upstream sync error (${upstreamUrl}):`, e instanceof Error ? e.message : e);
    }
  }
}
```

旧的 4 次退避重试逻辑随循环整体删除。

4. 新增状态端点（放在 `/api/desktop/skill-packs/retry` 路由旁，1203-1212 行区域）：

```ts
{
  method: "GET",
  path: "/api/desktop/skill-packs/status",
  handle: async (c) => {
    const { res } = c;
    if (!DESKTOP) return json(res, 404, { error: "not found" });
    const seed = readSeed<{ packs?: SeedSkillPack[] }>("skillpacks.json");
    const seeds = (seed?.packs ?? []).filter(
      (p): p is SeedSkillPack & { url: string } => typeof p?.url === "string" && p.url.trim().length > 0,
    );
    const missing = seeds.filter((p) => {
      const n = typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.url.trim();
      return !skillPackStatus.has(n);
    });
    let remote: Array<{
      url: string;
      upstreamUrl?: string;
      lastImport?: { status?: string; error?: string };
      updateAvailable?: boolean;
    }> = [];
    if (missing.length && desktopPortalToken) {
      try {
        const list = await coreFetch("GET", "/v1/admin/skill-packs", "", 5_000, {
          [PORTAL_IDENTITY_HEADER]: desktopPortalToken,
        });
        if (list.status === 200) remote = (JSON.parse(list.text) as { packs?: typeof remote }).packs ?? [];
      } catch (e) {
        swallow("skillpacks:status", e);
      }
    }
    const out: SkillPackStatusEntry[] = seeds.map((p) => {
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.url.trim();
      const mem = skillPackStatus.get(name);
      if (mem) return mem;
      const absUrl = resolveSeedUrl(p.url.trim());
      const upstream = typeof p.upstreamUrl === "string" ? p.upstreamUrl.trim() : "";
      const pack = remote.find((x) => x.url === absUrl || (upstream && (x.url === upstream || x.upstreamUrl === upstream)));
      if (!pack) return { name, phase: "pending" };
      if (pack.lastImport?.status === "ok") {
        return { name, phase: "ready", ...(pack.updateAvailable ? { updateAvailable: true } : {}) };
      }
      return { name, phase: "degraded", detail: pack.lastImport?.error ?? "尚未导入" };
    });
    return json(res, 200, { packs: out });
  },
},
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```powershell
cd plugins\web-ui
$env:NODE_ENV="test"; $env:ALLOW_UNSIGNED_TEST_IDENTITY="1"; node --test test/skillpacks-desktop.test.ts
npm run typecheck
```

预期：两用例全绿。再跑相关旧测试防回归：

```powershell
$env:NODE_ENV="test"; $env:ALLOW_UNSIGNED_TEST_IDENTITY="1"; node --test test/signed-identity.test.ts test/auth-mode-portal.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add plugins/web-ui/server/index.ts plugins/web-ui/test/skillpacks-desktop.test.ts
git commit -m "feat(web-ui): import desktop skill packs from bundled snapshots, single-shot upstream sync, status endpoint"
```

---

### Task 7: desktop — 构建脚本快照 + 删手工种子

**Files:**
- Modify: `deploy/layers/meerkat/desktop/scripts/stage-payload.sh`
- Modify: `deploy/layers/meerkat/desktop/scripts/stage-payload.ps1`
- Delete: `deploy/layers/meerkat/desktop/seeds/skillpacks.json`

**Interfaces:**
- Consumes: `deploy/layers/meerkat/skillpacks.conf`（`SKILLPACKS` 数组，`"url|ref"` 行）。
- Produces: `payload/skillpacks/<slug>/`（无 `.git`）+ `.skillpack-meta.json` + 生成的 `payload/config/seeds/skillpacks.json`——即 Task 6 消费的种子形状（`{name, url: "skillpacks/<slug>", upstreamUrl, ref, local: true}`）。**双脚本同步修改是纪律**（设计 §2）。

- [ ] **Step 1: stage-payload.sh**

`cp -r "$DESKTOP/seeds"/* "$PAYLOAD/config/seeds/"`（71 行）之后插入：

```bash
source "$ROOT/deploy/layers/meerkat/skillpacks.conf"
mkdir -p "$PAYLOAD/skillpacks"
SEED_OUT="$PAYLOAD/config/seeds/skillpacks.json"
first=1
printf '{"packs":[' > "$SEED_OUT"
for entry in "${SKILLPACKS[@]}"; do
  url="${entry%%|*}"
  ref="${entry#*|}"; [ "$ref" = "$url" ] && ref="main"
  slug="$(basename "$url" .git)"
  dest="$PAYLOAD/skillpacks/$slug"
  echo "snapshot $url#$ref -> payload/skillpacks/$slug"
  git clone --depth 1 --branch "$ref" --quiet "$url" "$dest"
  commit="$(git -C "$dest" rev-parse HEAD)"
  rm -rf "$dest/.git"
  printf '{"upstreamUrl":"%s","ref":"%s","commit":"%s","snapshotAt":"%s"}' \
    "$url" "$ref" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/.skillpack-meta.json"
  [ "$first" -eq 0 ] && printf ',' >> "$SEED_OUT"
  first=0
  printf '{"name":"%s","url":"skillpacks/%s","upstreamUrl":"%s","ref":"%s","local":true}' \
    "$slug" "$slug" "$url" "$ref" >> "$SEED_OUT"
done
printf ']}' >> "$SEED_OUT"
```

`set -euo pipefail` 保证 clone 失败即构建失败。同时 `git rm deploy/layers/meerkat/desktop/seeds/skillpacks.json`（唯一运行时消费者是 web-ui 的 `readSeed("skillpacks.json")`，构建后由生成文件顶替；dev 流 `scripts/meerkat-local-up.sh:82` 直接 source conf，不受影响）。

`skillpacks.conf` 从此有两个消费者、两种语义，头部注释第 3-4 行（「core 每次导入都会现场拉取仓库最新内容，改完 skills 只需 push 后重跑脚本」）对桌面通道不再成立，一并更新为：

```bash
# Meerkat Skills 仓库清单 —— 每个 GitHub 仓库 = 一个 skill pack
# 格式："仓库地址|分支"（分支可省，默认 main）；新增仓库往数组里加一行即可
# 两个消费者：桌面包构建（stage-payload.sh/.ps1 构建期克隆为快照随包内置，skills 更新随新包发布）；
# dev 流（bash scripts/meerkat-local-up.sh：注册 GitHub url，core 导入时现场拉取最新内容）
```

- [ ] **Step 2: stage-payload.ps1**

`Copy-Item -Recurse (Join-Path $Desktop "seeds\*") "$Payload\config\seeds\"`（42 行）之后插入。**注意 JSON 写文件必须无 BOM**（web-ui `readSeed` 的 `JSON.parse` 不容 BOM），用 `[System.IO.File]::WriteAllText` 而非 `Out-File`：

```powershell
$entries = Select-String -Path (Join-Path $Root "deploy\layers\meerkat\skillpacks.conf") -Pattern '^\s*"([^"]+)"' |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
New-Item -ItemType Directory -Force -Path "$Payload\skillpacks" | Out-Null
$seedPacks = @()
foreach ($entry in $entries) {
  $parts = $entry.Split("|")
  $url = $parts[0]
  $ref = if ($parts.Length -gt 1) { $parts[1] } else { "main" }
  $slug = [System.IO.Path]::GetFileNameWithoutExtension($url)
  $dest = Join-Path $Payload "skillpacks\$slug"
  Write-Host "snapshot $url#$ref -> payload/skillpacks/$slug"
  git clone --depth 1 --branch $ref --quiet $url $dest
  if ($LASTEXITCODE -ne 0) { throw "git clone failed: $url" }
  $commit = (git -C $dest rev-parse HEAD).Trim()
  Remove-Item -Recurse -Force (Join-Path $dest ".git")
  $meta = @{ upstreamUrl = $url; ref = $ref; commit = $commit; snapshotAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  [System.IO.File]::WriteAllText((Join-Path $dest ".skillpack-meta.json"), ($meta | ConvertTo-Json -Compress))
  $seedPacks += @{ name = $slug; url = "skillpacks/$slug"; upstreamUrl = $url; ref = $ref; local = $true }
}
[System.IO.File]::WriteAllText("$Payload\config\seeds\skillpacks.json", (@{ packs = $seedPacks } | ConvertTo-Json -Compress))
```

- [ ] **Step 3: 跑构建验证三件套**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\layers\meerkat\desktop\scripts\stage-payload.ps1
```

断言（PowerShell）：

```powershell
$snap = "deploy\layers\meerkat\desktop\payload\skillpacks\meerkat-skills-triz"
Test-Path $snap                                  # 快照存在
-not (Test-Path "$snap\.git")                    # 无 .git
$m = Get-Content "$snap\.skillpack-meta.json" -Raw | ConvertFrom-Json
$m.commit -match "^[0-9a-f]{40}$"                # commit 指纹
(git ls-remote https://github.com/MeerkatAIChina/meerkat-skills-triz.git main).Split()[0] -eq $m.commit  # 与仓库 HEAD 一致
$s = Get-Content "deploy\layers\meerkat\desktop\payload\config\seeds\skillpacks.json" -Raw | ConvertFrom-Json
$s.packs[0].url -eq "skillpacks/meerkat-skills-triz" -and $s.packs[0].local -eq $true -and $s.packs[0].upstreamUrl -like "https://*"
```

预期：全 True。构建需要网络（克隆 GitHub）；`bash` 版改动在 Git Bash 下做语法自检即可（`bash -n stage-payload.sh`），完整 sh 构建可选跑。

- [ ] **Step 4: Commit**

```powershell
git add deploy/layers/meerkat/desktop/scripts/stage-payload.sh deploy/layers/meerkat/desktop/scripts/stage-payload.ps1 deploy/layers/meerkat/skillpacks.conf
git rm deploy/layers/meerkat/desktop/seeds/skillpacks.json
git commit -m "feat(desktop): bundle skill pack snapshots into the payload, generate the seed at build time"
```

---

### Task 8: desktop — splash 技能包行 + Tauri `skillpacks_status` command

**Files:**
- Modify: `deploy/layers/meerkat/desktop/src-tauri/src/main.rs`
- Modify: `deploy/layers/meerkat/desktop/ui/index.html`

**Interfaces:**
- Consumes: Task 6 的 `GET /api/desktop/skill-packs/status`。
- Produces: Tauri command `skillpacks_status() -> Result<serde_json::Value, String>`（ureq 转发并附 `x-portal-identity` 头，ureq 已在依赖，无新 crate）；splash「技能包」行，黄灯降级语义，`maybeEnter()` 不等待。

- [ ] **Step 1: Rust command**

**前置约束（P0）**：web-ui 的 `/api/*` 统一过 `cookieUser` 认证闸门（`index.ts:2758-2760`），裸 GET 一律 401，且 ureq 3 默认把 4xx 当 Err → splash 轮询 catch 后无限重试，技能包行永远 pending。command 必须像 `portal_token`（`main.rs:27-29`）一样用 `auth::mint_portal_identity` 现铸 token 附在 `x-portal-identity` header 上（DESKTOP 下 `authenticate` 认这个 header，`index.ts:273-275`）。fatal 路径下 `StackCtx` 未 manage（`main.rs:118-133` 只 manage `shared_stack`/`PortsState`），所以用 `try_state` 兜底而不是 `State<>`。ureq 3 的 builder 方法是 `.header()`（2.x 的 `.set()` 已改名）。

`main.rs` 的 `status` command（46-50 行）之后加：

```rust
#[tauri::command]
fn skillpacks_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let ports = {
        let state = app
            .try_state::<proc::PortsState>()
            .ok_or_else(|| "ports not ready".to_string())?;
        *state.0.lock().map_err(|e| e.to_string())?
    };
    let ctx = app
        .try_state::<proc::StackCtx>()
        .ok_or_else(|| "stack not ready".to_string())?;
    let token = auth::mint_portal_identity(&ctx.secrets.portal_identity_secret);
    let mut resp = ureq::get(format!(
        "http://127.0.0.1:{}/api/desktop/skill-packs/status",
        ports.web_ui
    ))
    .header("x-portal-identity", &token)
    .call()
    .map_err(|e| e.to_string())?;
    let text = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
```

`generate_handler!` 列表（55-64 行）加 `skillpacks_status`。

验证编译：

```powershell
cd deploy\layers\meerkat\desktop\src-tauri
cargo check
```

- [ ] **Step 2: splash 行**

`ui/index.html`：`item-sandbox` 的 div（128-134 行）之后加：

```html
<div class="item pending" id="item-skillpacks">
  <span class="dot"></span>
  <div class="body">
    <div class="row"><span class="name">技能包</span><span class="meta"></span></div>
    <div class="reason" hidden></div>
  </div>
</div>
```

JS：`state`（150 行）加 `skillpacks: "pending"`；`invoke("ports").then(...)`（239-242 行）块内启动轮询，新增函数：

```js
let skillpacksPolling = false;
async function pollSkillpacks() {
  if (skillpacksPolling || !ports) return;
  skillpacksPolling = true;
  try {
    for (;;) {
      try {
        const data = await invoke("skillpacks_status");
        const packs = data.packs ?? [];
        const next = packs.some((p) => p.phase === "degraded")
          ? "degraded"
          : packs.length > 0 && packs.every((p) => p.phase === "ready")
            ? "ready"
            : "pending";
        if (next !== state.skillpacks) {
          state.skillpacks = next;
          render("skillpacks");
        }
        const bad = packs.filter((p) => p.phase === "degraded");
        if (bad.length) setReason("skillpacks", bad.map((p) => p.detail || p.name).join("；"));
        if (next === "pending") setMeta("skillpacks", "同步中");
        if (next !== "pending") break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    skillpacksPolling = false;
  }
}
```

`invoke("ports").then((p) => { ports = p; pollSkillpacks(); maybeEnter(); });`

`maybeEnter()` 保持只等 core + web_ui——技能包行永不阻断进主界面（黄灯降级纪律）。

- [ ] **Step 3: 验证**

`cargo check` 绿。splash 是 Tauri webview、Task 9 的活体脚本不起 Tauri app，本行只能靠真机手动验证——Step 1 的认证问题正是只有真机 splash 才能暴露的那类 bug。构建一个 debug 包跑最小 checklist：

- 正常首启：技能包行 pending（「同步中」）→ 导入完成后转绿；
- 断网首启：本地导入成功 → 行转绿（upstream sync 失败不影响）；
- 人为损坏快照目录（模拟打包事故）：行转黄、reason 可见，且**不阻断** `maybeEnter()` 进主界面；
- 全程 DevTools console 无 `skillpacks_status` 的 401/持续报错（确认 token 附上了）。

- [ ] **Step 4: Commit**

```powershell
git add deploy/layers/meerkat/desktop/src-tauri/src/main.rs deploy/layers/meerkat/desktop/ui/index.html
git commit -m "feat(desktop): show skill pack status on the boot checklist via a tauri command"
```

---

### Task 9: desktop — 活体验证脚本 verify-issue6.ts

**Files:**
- Create: `deploy/layers/meerkat/desktop/scripts/verify-issue6.ts`

**Interfaces:**
- Consumes: Task 1/3/4 的全部 core 行为（直读、allowLocal 注册、onlyIfUpdate、失败保留 commit）。
- Produces: 可重复运行的活体断言脚本，照 `verify-issue5.ts` 先例（`buildApp` + `createInsecureTestServer` 真 core）。

- [ ] **Step 1: 写脚本并运行**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../../../../../src/config.ts";
import { buildApp } from "../../../../../src/wiring.ts";
import { createInsecureTestServer } from "../../../../../src/api/server.ts";

const COMMIT_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADMIN = { "x-admin-actor": "admin-alice@meerkat", "content-type": "application/json" };

const dataDir = mkdtempSync(join(tmpdir(), "meerkat-verify6-"));
const snap = mkdtempSync(join(tmpdir(), "meerkat-verify6-snap-"));
mkdirSync(join(snap, "skills", "triz-demo"), { recursive: true });
writeFileSync(
  join(snap, "skills", "triz-demo", "SKILL.md"),
  "---\nname: triz-demo\ndescription: d\nscope: company\n---\n# Body\n",
);
const writeMeta = (commit: string) =>
  writeFileSync(
    join(snap, ".skillpack-meta.json"),
    JSON.stringify({ upstreamUrl: "https://upstream.invalid/repo.git", ref: "main", commit, snapshotAt: "2026-08-20T00:00:00Z" }),
  );
writeMeta(COMMIT_1);

const built = buildApp({
  ...loadConfig({}),
  port: 0,
  dataDir,
  allowLocalSkillPacks: true,
  sessionStore: "sqlite",
  sqlitePath: join(dataDir, "meerkat.db"),
  harness: "mock",
  connectorSecretKey: "dev-connector-key",
  capabilitySecret: "dev-capability-key",
});
const server = createInsecureTestServer(built.app, {
  admin: built.admin,
  auditLog: built.auditLog,
  sessions: built.sessions,
  errors: built.errors,
  allowLocalSkillPacks: true,
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: ADMIN,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const reg = await call("POST", "/v1/admin/skill-packs", {
  url: snap,
  ref: "main",
  allowLocal: true,
  trustTier: "internal",
  subset: "all",
  upstreamUrl: "https://upstream.invalid/repo.git",
});
if (reg.status !== 200) fail(`register: ${JSON.stringify(reg.body)}`);
const packId = reg.body.pack.id;
if (reg.body.pack.upstreamUrl !== "https://upstream.invalid/repo.git") fail("upstreamUrl not stored");

const imp = await call("POST", `/v1/admin/skill-packs/${packId}/import`, { selected: "all" });
if (imp.status !== 200) fail(`local snapshot import: ${JSON.stringify(imp.body)}`);
console.log("local snapshot import ok (no git, no network)");

const t0 = Date.now();
const syncFail = await call("POST", `/v1/admin/skill-packs/${packId}/sync`, { onlyIfUpdate: true });
const elapsed = Date.now() - t0;
if (syncFail.status === 200) fail("sync against an unreachable upstream must fail");
if (elapsed > 20_000) fail(`sync took ${elapsed}ms — looks like retry/backoff, want a single attempt`);
const afterFail = await call("GET", "/v1/admin/skill-packs");
const packAfterFail = afterFail.body.packs.find((p) => p.id === packId);
if (packAfterFail.lastImport?.status !== "error") fail("failed sync must record an error");
if (packAfterFail.lastImport?.commit !== COMMIT_1) fail(`commit clobbered: ${packAfterFail.lastImport?.commit}`);
console.log(`unreachable upstream: single fast failure (${elapsed}ms), last good commit preserved`);

const local = await call("POST", "/v1/admin/skill-packs", {
  url: snap,
  ref: "main",
  allowLocal: true,
  trustTier: "internal",
  subset: "all",
});
const localId = local.body.pack.id;
await call("POST", `/v1/admin/skill-packs/${localId}/import`, { selected: "all" });
const skip = await call("POST", `/v1/admin/skill-packs/${localId}/sync`, { onlyIfUpdate: true });
if (skip.body.upToDate !== true) fail(`expected upToDate skip, got ${JSON.stringify(skip.body)}`);
console.log("onlyIfUpdate skips the fetch when the snapshot is unchanged");

writeMeta(COMMIT_2);
const bumped = await call("POST", `/v1/admin/skill-packs/${localId}/sync`, { onlyIfUpdate: true });
if (bumped.status !== 200 || bumped.body.upToDate === true) fail("bumped snapshot commit must trigger a re-import");
const afterBump = await call("GET", "/v1/admin/skill-packs");
if (afterBump.body.packs.find((p) => p.id === localId).lastImport?.commit !== COMMIT_2) fail("commit not advanced");
console.log("bumped snapshot commit re-imports and advances lastImport");

server.close();
rmSync(dataDir, { recursive: true, force: true });
rmSync(snap, { recursive: true, force: true });
console.log("PASS: issue #6 core flows verified");
```

运行：

```powershell
node deploy\layers\meerkat\desktop\scripts\verify-issue6.ts
```

预期：四段 console.log 全出、末尾 PASS。注意 `upstream.invalid` 走 core 的 SSRF 校验路径（DNS 解析失败 → 快速报错），天然满足「单次、快速、保留 commit」的断言。

- [ ] **Step 2: Commit**

```powershell
git add deploy/layers/meerkat/desktop/scripts/verify-issue6.ts
git commit -m "test(desktop): live verification script for bundled skill pack snapshots (#6)"
```

---

### Task 10: 收尾 — 全量回归 + 需求描述勾销

- [ ] **Step 1: 受影响测试总跑**

```powershell
node --experimental-test-module-mocks --test test/pack-fetcher.test.ts test/skill-pack-store.test.ts test/skill-packs-routes.test.ts test/skill-sync-engine.test.ts
cd plugins\web-ui; $env:NODE_ENV="test"; $env:ALLOW_UNSIGNED_TEST_IDENTITY="1"; npm test; cd ..\..
npm run typecheck
cd plugins\web-ui; npm run typecheck; cd ..\..
npm run lint:ox
```

- [ ] **Step 2: fresh-context 代码评审**（AGENTS.md 硬要求：不能自审）——对全部改动 dispatch `/code-review` 或独立评审 agent，重点 lens：内核缝（pack-fetcher 直读）、迁移守卫、竞态（skillPacksRunning 单飞 + retry 端点）。

- [ ] **Step 3: Commit 收尾（如有评审修复）**

```powershell
git commit -m "fix(core): review follow-ups for skill pack snapshot channel (#6)"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计 §2 构建快照 → Task 7；§3.1 直读 → Task 1；§3.2 字段 → Task 2；§3.3 routes/守卫 → Task 3；§3.4 onlyIfUpdate/源/保留 commit → Task 4；§3.5 engine upstream → Task 5；§4 启动任务 → Task 6；§5 可见性 → Task 6（端点）+ Task 8（行）；§6 错误矩阵 → 各 Task 测试断言 + Task 9 活体；§7 测试 → 各 Task Step 内。设置页按钮（优化 2）明确不做。
- **Placeholder 扫描**：无 TBD/TODO；所有测试与实现代码完整给出。
- **类型一致性**：`upstreamSource`（Task 2 定义）在 Task 4/5 同名消费；`upToDate` 响应字段 Task 4 产出、Task 6/9 消费；`SkillPackStatusEntry` 形状 Task 6 产出、Task 8 消费；`skillpacks_status` command Task 8 定义与消费一致。

## 评审修订（2026-08-20 二轮评审后）

- **P0 认证闸门（已修）**：`/api/*` 统一过 `cookieUser`（`index.ts:2758-2760`），原稿三处裸调用（Task 6 测试的 status 轮询与 retry、Task 8 Rust ureq GET）全部会 401——Rust 侧 401 在 ureq 3 下是 Err，splash 会无限重试、技能包行永远 pending，且 Task 9 活体脚本覆盖不到。已修：Task 6 测试所有 `/api/desktop/*` 调用带 mint 的 portal token；Task 8 Rust command 改为 `AppHandle` + `try_state` + `auth::mint_portal_identity` 附 `x-portal-identity` 头；Global Constraints 增加认证闸门条目。
- **类型加宽补列（已修）**：`maybeStartSkillPacks` 类型守卫（923 行）与 `ensureSkillPacks` 形参（937 行）随 `SeedSkillPack` 一并加宽，Task 6 Step 3 第 1 条已显式列出（漏了 typecheck 必挂）。
- **保留 commit 统一为 4 处（已修）**：补入 `registerSkillPack`（310 行）——新建 pack 无 `lastImport`，`?? pack.ref` 等值，统一为消灭模式分叉，符合 Fix every instance。
- **conf 头部注释随 Task 7 更新（已修）**：`skillpacks.conf` 从此有两个消费者（stage-payload 构建期快照 + `scripts/meerkat-local-up.sh:82` dev 流现场拉取），原注释「每次导入现场拉取最新内容」对桌面通道不再成立。
- **PAYLOAD_ROOT 布局依赖点明（已修）**：`"..", ".."` 推导依赖 `proc.rs:294` 写死的 `<payload>/config/seeds` 布局，Task 6 Step 3 加注。
- **splash 手动验证 checklist（已修）**：Task 8 Step 3 补四条真机 checklist（含 DevTools 确认无 401）。

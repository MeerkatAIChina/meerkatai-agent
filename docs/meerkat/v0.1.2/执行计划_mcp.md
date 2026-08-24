# 接入 MCP Server 服务（需求 3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面版可按需接入自定义 header 鉴权的 MCP 服务（lawaken-memory-dev），core 补 header 单头认证模式，设置页提供 MCP 配置表单并连带落地优化 2 最小版（回访入口 + secret 留空=不修改）。

**Architecture:** core 的 MCP 子系统新增 `"header"` 认证模式（store 类型 → client → tool-service 映射 → admin 路由校验/redact，全链路联动点逐一列全）；web-ui server 加 `/api/setup/mcp-servers[/:id]` 转发路由（照 `registerProviders` 模式）；setup.html 加 MCP 管理区块；SPA shell 加带 `portal_token` 的设置入口。

**Tech Stack:** Node 24（node:test）、TypeScript（core）、无构建内联 HTML/JS（setup.html）、Lit（web-ui SPA）。

**Spec:** [设计文档.md](./设计文档.md)「接入 MCP Server 服务（需求 3，lawaken-memory-dev）」一节 —— 拍板记录与四个钉死项是裁决依据，执行前必读。

## Global Constraints

- **分支**：全部在 `feature/meerkat` 上开发，不动 `main`。
- **中性实现**：core（`src/`）改动与测试中**禁止出现 meerkat / lawaken 字样**；测试统一用中性头名 `X-Custom-Key`。meerkat 侧配置只出现在 `plugins/web-ui` 的桌面路由与文档中。
- **零注释**：仓规为零注释（无解释性注释、无 TODO、无 lint 抑制），意图靠命名、结构与测试表达，理由写 commit message。
- **签名联动点必须列全**（前序教训）：`McpServerAuthMode` 联合类型扩大波及 4 处——`mcp-server-store.ts`（类型）、`mcp-client.ts`（`McpAuth` + `authHeaders()`）、`mcp-tool-service.ts`（`authOf()`）、`mcp-servers.ts`（`AUTH_MODES` + 校验 + `redact()` 签名）。Task 1/2 的文件清单已逐一对应，不得遗漏。
- **钉死项**（设计文档概述，复述于此）：① 转发路由照 `registerProviders` 模式，GET 透传 redact 结果；② secret（含 `headerValue`）留空=保留，与 core PUT 现有行为对齐；③ 手填 `validate:true`（probe 失败=保存失败，fail-closed 是刻意姿态）；④ redact 扩展列入内核缝清单随 ADR。
- **测试命令**（Windows PowerShell 可直接执行）：
  - core 定向测试：`node --experimental-test-module-mocks --test test/mcp-connectors.test.ts test/mcp-servers-route.test.ts`
  - core typecheck：`npm run typecheck`
  - web-ui 定向测试（在 `plugins/web-ui/` 下）：`$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/mcp-servers-setup.test.ts test/mcp-servers-setup-nondesktop.test.ts test/setup-register.test.ts`
  - web-ui typecheck（在 `plugins/web-ui/` 下）：`npm run typecheck`
- **提交**：每个 Task 末尾按步骤 commit，message 带需求引用（如 `（需求 3）`）。core 内核缝改动在 Task 6 统一记 ADR-009（ADR-007/008 已被占用）。

---

### Task 1: core——header 认证传输层（store 类型 + client + tool-service 映射）

**Files:**
- Modify: `src/mcp/mcp-server-store.ts`（`McpServerAuthMode`、`McpServer`）
- Modify: `src/mcp/mcp-client.ts`（`McpAuth`、`authHeaders()`）
- Modify: `src/mcp/mcp-tool-service.ts`（`authOf()`）
- Test: `test/mcp-connectors.test.ts`

**Interfaces:**
- Consumes: 现有 `McpServer` / `McpAuth` / `createMcpClient` / `createMcpToolService`（签名不变，仅联合类型加成员）。
- Produces: `McpServerAuthMode = "none" | "bearer" | "client-credentials" | "header"`；`McpServer.headerName?: string`、`McpServer.headerValue?: string`；`McpAuth` 新增 `{ mode: "header"; name: string; value: string }`。Task 2 的路由校验与 Task 3 的转发体依赖这组字段名，逐字固定。

- [ ] **Step 1: Write the failing tests**

在 `test/mcp-connectors.test.ts` 中先扩展 `fakeServerFetch`，加 `requireHeader` 选项（紧跟现有 `requireBearer` 分支之后）：

```ts
function fakeServerFetch(opts?: { requireBearer?: string; requireHeader?: { name: string; value: string }; sse?: boolean }): {
  fetch: McpFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (opts?.requireHeader && init.headers[opts.requireHeader.name.toLowerCase()] !== opts.requireHeader.value) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}
```

再追加两个测试（放在 `"mcp client sends bearer auth"` 之后）：

```ts
test("mcp client sends a custom auth header", async () => {
  const { fetch } = fakeServerFetch({ requireHeader: { name: "X-Custom-Key", value: "sekret" } });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "header", name: "X-Custom-Key", value: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "header", name: "X-Custom-Key", value: "wrong" },
    fetchImpl: fetch,
  });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("tool service maps a header-auth server to the client", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch({ requireHeader: { name: "X-Custom-Key", value: "sekret" } });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server({ auth: "header", headerName: "X-Custom-Key", headerValue: "sekret" }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  const out = await service.call("crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test test/mcp-connectors.test.ts`
Expected: FAIL —— `auth: { mode: "header", ... }` 类型不存在（TS 编译错误）或运行时 401。

- [ ] **Step 3: Implement — store 类型**

`src/mcp/mcp-server-store.ts`：

```ts
export type McpServerAuthMode = "none" | "bearer" | "client-credentials" | "header";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  headerName?: string;
  headerValue?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}
```

- [ ] **Step 4: Implement — client**

`src/mcp/mcp-client.ts` 的 `McpAuth` 与 `authHeaders()`：

```ts
export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string }
  | { mode: "header"; name: string; value: string };
```

`authHeaders()` 在 `bearer` 分支后加：

```ts
if (auth.mode === "header") return { [auth.name.toLowerCase()]: auth.value };
```

- [ ] **Step 5: Implement — tool-service 映射**

`src/mcp/mcp-tool-service.ts` 的 `authOf()` 加一个分支：

```ts
if (server.auth === "header")
  return { mode: "header", name: server.headerName ?? "", value: server.headerValue ?? "" };
```

- [ ] **Step 6: Run tests + typecheck**

Run: `node --experimental-test-module-mocks --test test/mcp-connectors.test.ts && npm run typecheck`
Expected: 测试全 PASS，typecheck 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/mcp/mcp-server-store.ts src/mcp/mcp-client.ts src/mcp/mcp-tool-service.ts test/mcp-connectors.test.ts
git commit -m "feat(core): add single-header auth mode to MCP client transport (需求 3)"
```

---

### Task 2: core——admin 路由校验与 redact 扩展

**Files:**
- Modify: `src/api/routes/admin/mcp-servers.ts`（`AUTH_MODES`、`putMcpServer` 校验、`redact`）
- Test: `test/mcp-servers-route.test.ts`（新建，模式照 `test/custom-provider-route.test.ts`）

**Interfaces:**
- Consumes: Task 1 的 `McpServerAuthMode` / `headerName` / `headerValue`。
- Produces: PUT 请求体接受 `headerName`（string，新建与更新均必填）、`headerValue`（string，新建必填、更新留空=保留）；GET/PUT 响应在 redact 结果中含 `hasHeaderValue: boolean`，`headerName` 明文返回、`headerValue` 永不返回。Task 3 的转发与 Task 5 的表单逐字依赖此契约。

- [ ] **Step 1: Write the failing tests**

新建 `test/mcp-servers-route.test.ts`。骨架照 `custom-provider-route.test.ts`（`buildApp` + `createInsecureTestServer`，把 `built.mcpServers` / `built.mcpToolService` 传进 deps；admin 头用 `x-admin-actor`）：

```ts
import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "mcp-servers-route-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BODY = {
  name: "Memory",
  url: "https://mcp.example.com/api/memory/mcp",
  auth: "header",
  headerName: "X-Custom-Key",
  headerValue: "hdr-sekret",
  validate: false,
};

function put(base: string, id: string, body: unknown) {
  return fetch(`${base}/v1/admin/mcp-servers/${id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });
}

test("header auth registers, redacts the value, and keeps it on a blank update", async () => {
  const srv = start();
  try {
    const created = await put(srv.base, "memory", BODY);
    assert.equal(created.status, 200);
    const createdText = await created.text();
    assert.equal(createdText.includes("hdr-sekret"), false, "secret never echoed");
    assert.ok(createdText.includes("X-Custom-Key"), "headerName is not a secret and stays visible");

    const list = await fetch(`${srv.base}/v1/admin/mcp-servers`, { headers: ADMIN });
    const listed = (await list.json()) as { servers: Array<Record<string, unknown>> };
    const row = listed.servers.find((s) => s.id === "memory")!;
    assert.equal(row.hasHeaderValue, true);
    assert.equal(row.headerName, "X-Custom-Key");
    assert.equal("headerValue" in row, false);

    const update = await put(srv.base, "memory", { ...BODY, headerValue: "", name: "Memory Renamed" });
    assert.equal(update.status, 200);
    const stored = await srv.built.mcpServers.get("memory");
    assert.equal(stored?.headerValue, "hdr-sekret", "blank headerValue keeps the stored secret");
    assert.equal(stored?.name, "Memory Renamed");
  } finally {
    await srv.close();
  }
});

test("headerName is validated: token shape and reserved names, case-insensitive", async () => {
  const srv = start();
  try {
    for (const headerName of ["bad name", "", "Authorization", "CONTENT-TYPE", "Host"]) {
      const res = await put(srv.base, "memory", { ...BODY, headerName });
      assert.equal(res.status, 400, `headerName ${JSON.stringify(headerName)} must be rejected`);
    }
    const res = await put(srv.base, "memory", { ...BODY, headerName: undefined, headerValue: "x" });
    assert.equal(res.status, 400, "headerName is required on create and update");
  } finally {
    await srv.close();
  }
});

test("headerValue is required on create", async () => {
  const srv = start();
  try {
    const res = await put(srv.base, "memory", { ...BODY, headerValue: "" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /headerValue/);
  } finally {
    await srv.close();
  }
});

test("switching auth modes drops the previous mode's secrets", async () => {
  const srv = start();
  try {
    assert.equal((await put(srv.base, "memory", { ...BODY, auth: "bearer", bearerToken: "tok" })).status, 200);
    assert.equal((await put(srv.base, "memory", BODY)).status, 200);
    const stored = await srv.built.mcpServers.get("memory");
    assert.equal(stored?.bearerToken, undefined, "bearer secret dropped on switch to header");
    assert.equal(stored?.headerValue, "hdr-sekret");
  } finally {
    await srv.close();
  }
});

test("default validate probes tools/list and fails closed when unreachable", async () => {
  const srv = start();
  try {
    const down = await put(srv.base, "memory", { ...BODY, url: "http://127.0.0.1:1/mcp", validate: undefined });
    assert.equal(down.status, 400);
    assert.equal(((await down.json()) as { error: string }).error, "unreachable");
    assert.equal(await srv.built.mcpServers.get("memory"), null, "failed probe means nothing is stored");

    const stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const rpc = JSON.parse(raw) as { id: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "recall", description: "d", inputSchema: { type: "object" } }] } }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, r));
    const port = (stub.address() as AddressInfo).port;
    const ok = await put(srv.base, "memory", { ...BODY, url: `http://127.0.0.1:${port}/mcp`, validate: undefined });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { tools?: string[] };
    assert.deepEqual(okBody.tools, ["recall"]);
    stub.close();
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test test/mcp-servers-route.test.ts`
Expected: FAIL —— `auth: "header"` 被 `AUTH_MODES` 拒绝（400 `auth must be one of ...`）。

- [ ] **Step 3: Implement**

`src/api/routes/admin/mcp-servers.ts`：

① `AUTH_MODES` 加成员，文件顶部加两个常量：

```ts
const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials", "header"];
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "host",
  "content-type",
  "accept",
  "content-length",
  "connection",
  "transfer-encoding",
]);
```

② `redact()` 扩展：

```ts
function redact(server: McpServer): Omit<McpServer, "bearerToken" | "clientSecret" | "headerValue"> & {
  hasBearerToken: boolean;
  hasClientSecret: boolean;
  hasHeaderValue: boolean;
} {
  const { bearerToken, clientSecret, headerValue, ...rest } = server;
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret, hasHeaderValue: !!headerValue };
}
```

③ `putMcpServer` 中 `auth` 校验之后、构造 `server` 之前加 headerName 校验：

```ts
const headerName = typeof b.headerName === "string" ? b.headerName.trim() : "";
if (auth === "header") {
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "header auth requires headerName to be a valid HTTP header token" });
  }
  if (RESERVED_HEADER_NAMES.has(headerName.toLowerCase())) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `headerName must not be ${headerName}` });
  }
}
```

④ `server` 构造中加条件 spread（与 bearer/client-credentials 并列；不进 spread 即清旧值，切换 auth 自动丢弃旧 secret）：

```ts
...(auth === "header"
  ? {
      headerName,
      headerValue: typeof b.headerValue === "string" && b.headerValue ? b.headerValue : existing?.headerValue,
    }
  : {}),
```

⑤ 必填检查（紧跟现有 bearer 检查之后）：

```ts
if (auth === "header" && !server.headerValue) {
  return sendJson(ctx.res, 400, { error: "bad_request", message: "header auth requires headerValue" });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --experimental-test-module-mocks --test test/mcp-servers-route.test.ts test/mcp-connectors.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/admin/mcp-servers.ts test/mcp-servers-route.test.ts
git commit -m "feat(core): validate and redact header auth on MCP server admin routes (需求 3)"
```

---

### Task 3: web-ui server——/api/setup/mcp-servers 转发路由

**Files:**
- Modify: `plugins/web-ui/server/index.ts`（`apiRoutes` 加 3 条 + `forwardCore` 助手）
- Test: `plugins/web-ui/test/mcp-servers-setup.test.ts`（新建，模式照 `skillpacks-desktop.test.ts`）
- Test: `plugins/web-ui/test/mcp-servers-setup-nondesktop.test.ts`（新建小文件，非 DESKTOP 404）

**Interfaces:**
- Consumes: Task 2 的 core 契约（redact 含 `hasHeaderValue`；400 body 为 `{error, message}`）。
- Produces（Task 5 表单逐字依赖）:
  - `GET /api/setup/mcp-servers` → 200 透传 core body `{servers: [...redact], tools: [...]}`；
  - `PUT /api/setup/mcp-servers/:id` → body 为 core PUT 体（`headerValue`/`bearerToken` 为空字符串时转发前剥离该键）；200 透传，core 400 透 `{error, message}`，其余 core 非 200 归 502 `{error: "core_error"}`；
  - `DELETE /api/setup/mcp-servers/:id` → 200 `{ok:true}`，core 404 原样透。

- [ ] **Step 1: Write the failing tests**

新建 `plugins/web-ui/test/mcp-servers-setup.test.ts`（mock core + `mintPortalIdentity` + 起真 handler，与 `skillpacks-desktop.test.ts` 同构）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const state: { servers: Record<string, unknown>[]; puts: Record<string, unknown>[]; deletes: string[] } = {
  servers: [],
  puts: [],
  deletes: [],
};

const core = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const u = new URL(req.url ?? "/", "http://core");
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/v1/admin/whoami") return send(200, { isAdmin: true });
    if (u.pathname === "/v1/admin/mcp-servers" && req.method === "GET") {
      return send(200, {
        servers: state.servers,
        tools: [{ name: "memory_recall", serverId: "memory", description: "recall", readOnly: true }],
      });
    }
    const m = u.pathname.match(/^\/v1\/admin\/mcp-servers\/([^/]+)$/);
    if (m && req.method === "PUT") {
      state.puts.push(body);
      if (body.url === "https://down.example.com/mcp") {
        return send(400, { error: "unreachable", message: `tools/list against down.example.com failed: connect ECONNREFUSED` });
      }
      const server = {
        id: m[1],
        name: body.name ?? m[1],
        url: body.url,
        auth: body.auth ?? "none",
        ...(body.headerName ? { headerName: body.headerName } : {}),
        hasBearerToken: false,
        hasClientSecret: false,
        hasHeaderValue: typeof body.headerValue === "string" && body.headerValue.length > 0,
        readOnly: body.readOnly !== false,
        enabled: body.enabled !== false,
      };
      state.servers = [...state.servers.filter((s) => s.id !== server.id), server];
      return send(200, { ok: true, server, tools: ["recall"] });
    }
    if (m && req.method === "DELETE") {
      state.deletes.push(m[1]!);
      state.servers = state.servers.filter((s) => s.id !== m[1]);
      return send(200, { ok: true });
    }
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "mcp-servers-setup-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.MEERKAT_DESKTOP = "1";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const authed = () => ({ [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) });

test("GET forwards the redacted server list and tool snapshot", async () => {
  state.servers = [
    { id: "memory", name: "Memory", url: "https://mcp.example.com/mcp", auth: "header", headerName: "X-Custom-Key", hasHeaderValue: true, readOnly: true, enabled: true },
  ];
  const r = await fetch(`${base}/api/setup/mcp-servers`, { headers: authed() });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { servers: Array<Record<string, unknown>>; tools: unknown[] };
  assert.equal(body.servers[0]!.hasHeaderValue, true);
  assert.equal(body.servers[0]!.headerName, "X-Custom-Key");
  assert.equal("headerValue" in body.servers[0]!, false, "secret key must never appear in the forwarded body");
  assert.equal(body.tools.length, 1);
});

test("PUT strips blank secret fields before forwarding and defaults validate on", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, {
    method: "PUT",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify({ name: "Memory", url: "https://mcp.example.com/mcp", auth: "header", headerName: "X-Custom-Key", headerValue: "", bearerToken: "" }),
  });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.equal("headerValue" in forwarded, false, "blank headerValue stripped, core keeps the stored secret");
  assert.equal("bearerToken" in forwarded, false);
  assert.equal(forwarded.validate, undefined, "validate defaults to core's probe-on behavior");
});

test("core 400 passes its message through unchanged", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, {
    method: "PUT",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify({ name: "Memory", url: "https://down.example.com/mcp", auth: "none" }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string; message: string };
  assert.equal(body.error, "unreachable");
  assert.match(body.message, /tools\/list against down\.example\.com failed/);
});

test("DELETE forwards to core", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "DELETE", headers: authed() });
  assert.equal(r.status, 200);
  assert.deepEqual(state.deletes, ["memory"]);
});
```

新建 `plugins/web-ui/test/mcp-servers-setup-nondesktop.test.ts`（不设置 `MEERKAT_DESKTOP`，三条路由全部 404）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "mcp-servers-setup-nondesktop-test-secret";
process.env.CORE_API_URL = "http://127.0.0.1:1";
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.MEERKAT_DESKTOP;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => surface.close());

const authed = () => ({ [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) });

test("mcp setup routes are desktop-only", async () => {
  const get = await fetch(`${base}/api/setup/mcp-servers`, { headers: authed() });
  assert.equal(get.status, 404);
  const put = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "PUT", headers: { ...authed(), "content-type": "application/json" }, body: "{}" });
  assert.equal(put.status, 404);
  const del = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "DELETE", headers: authed() });
  assert.equal(del.status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run（在 `plugins/web-ui/` 下）: `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/mcp-servers-setup.test.ts test/mcp-servers-setup-nondesktop.test.ts`
Expected: FAIL —— 三条路由均 404（尚未存在）。

- [ ] **Step 3: Implement**

`plugins/web-ui/server/index.ts`：

① 在 `registerProviders` 附近加转发助手：

```ts
async function forwardCore(res: ServerResponse, r: { status: number; text: string }): Promise<void> {
  let body: unknown = {};
  try {
    body = JSON.parse(r.text);
  } catch (e) {
    swallow("setup:mcp-forward", e);
  }
  if (r.status === 200) return json(res, 200, body);
  if (r.status === 400 || r.status === 404) return json(res, r.status, body);
  return json(res, 502, { error: "core_error", message: `core returned HTTP ${r.status}` });
}
```

② `apiRoutes` 数组中（`/api/setup/register` 条目之后）加三条：

```ts
{
  method: "GET",
  path: "/api/setup/mcp-servers",
  handle: async (c) => {
    const { res } = c;
    if (!DESKTOP) return json(res, 404, { error: "not found" });
    return forwardCore(res, await coreFetch("GET", "/v1/admin/mcp-servers"));
  },
},
{
  method: "PUT",
  path: "/api/setup/mcp-servers/:id",
  handle: async (c) => {
    const { req, res, params } = c;
    if (!DESKTOP) return json(res, 404, { error: "not found" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "bad_request" });
    }
    for (const key of ["bearerToken", "clientSecret", "headerValue"]) {
      if (body[key] === "") delete body[key];
    }
    return forwardCore(
      res,
      await coreFetch("PUT", `/v1/admin/mcp-servers/${encodeURIComponent(params.id ?? "")}`, JSON.stringify(body)),
    );
  },
},
{
  method: "DELETE",
  path: "/api/setup/mcp-servers/:id",
  handle: async (c) => {
    const { res, params } = c;
    if (!DESKTOP) return json(res, 404, { error: "not found" });
    return forwardCore(res, await coreFetch("DELETE", `/v1/admin/mcp-servers/${encodeURIComponent(params.id ?? "")}`));
  },
},
```

注意：web-ui **不做 id 预校验**（设计钉死：core 单点校验，400 message 透传）；`validate` 键不主动设置，core 缺省即 probe 开启。DESKTOP 404 body 用 `{ error: "not found" }`（带空格）——与 `index.ts` 现有七处 DESKTOP 守卫（如 :1275）的惯例一致，勿写成 `not_found`。

- [ ] **Step 4: Run tests + typecheck**

Run（在 `plugins/web-ui/` 下）: `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/mcp-servers-setup.test.ts test/mcp-servers-setup-nondesktop.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
git add plugins/web-ui/server/index.ts plugins/web-ui/test/mcp-servers-setup.test.ts plugins/web-ui/test/mcp-servers-setup-nondesktop.test.ts
git commit -m "feat(web-ui): forward /api/setup/mcp-servers routes to core admin API (需求 3)"
```

---

### Task 4: 优化 2 最小版——registerProviders 留空=不修改 + SPA 设置入口

**Files:**
- Modify: `plugins/web-ui/server/index.ts`（`registerProviders`、`/api/setup/defaults` 响应）
- Modify: `plugins/web-ui/server/setup.html`（token 字段提示与前端必填逻辑、返回主界面链接）
- Modify: `plugins/web-ui/src/shell.ts`（设置按钮 + lucide `Settings` 图标 import）
- Test: `plugins/web-ui/test/setup-register.test.ts`（新建）

**Interfaces:**
- Consumes: `needsSetup()`（`index.ts` 现有，10s 缓存）；`isDesktop()`（`plugins/web-ui/src/composer.ts:94` 导出）；`withPortalToken()`（`plugins/web-ui/src/core-bridge.ts:17` 导出）。
- Produces: `/api/setup/defaults` 响应新增 `needsSetup: boolean`（setup.html 据此区分首启/回访）；shell 设置按钮仅在 `isDesktop()` 为真时渲染，href 为 `withPortalToken(withBase("/setup"))`。

- [ ] **Step 1: Write the failing tests**

新建 `plugins/web-ui/test/setup-register.test.ts`（同 mock-core 模式；core 侧记录 custom-providers PUT 体，`GET /v1/admin/custom-providers` 返回可编程的 providers 列表）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const state: { providers: Record<string, unknown>[]; puts: Record<string, unknown>[] } = { providers: [], puts: [] };

const core = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const u = new URL(req.url ?? "/", "http://core");
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/v1/admin/whoami") return send(200, { isAdmin: true });
    if (u.pathname === "/v1/admin/custom-providers" && req.method === "GET") return send(200, { providers: state.providers });
    const m = u.pathname.match(/^\/v1\/admin\/custom-providers\/([^/]+)$/);
    if (m && req.method === "PUT") {
      state.puts.push(body);
      state.providers = [...state.providers.filter((p) => p.id !== m[1]), { id: m[1] }];
      return send(200, { ok: true });
    }
    if (u.pathname.startsWith("/v1/admin/scopes/")) return send(200, { ok: true });
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "setup-register-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.MEERKAT_DESKTOP = "1";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const authed = () => ({ [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) });

const register = (body: Record<string, unknown>) =>
  fetch(`${base}/api/setup/register`, {
    method: "POST",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("first boot still requires the service token", async () => {
  state.providers = [];
  const r = await register({ token: "" });
  assert.equal(r.status, 400);
});

test("revisit with a blank token keeps the stored key (apiKey stripped from the PUT)", async () => {
  state.providers = [{ id: "tensoris" }];
  const before = state.puts.length;
  const r = await register({ token: "" });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.ok(state.puts.length > before);
  assert.equal("apiKey" in forwarded, false, "blank token means core keeps the stored key");
});

test("revisit with a fresh token forwards it", async () => {
  state.providers = [{ id: "tensoris" }];
  const r = await register({ token: "new-token" });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.equal(forwarded.apiKey, "new-token");
});

test("setup defaults reports needsSetup for the page's first-boot copy", async () => {
  state.providers = [];
  const empty = await fetch(`${base}/api/setup/defaults`, { headers: authed() });
  assert.equal(((await empty.json()) as { needsSetup: boolean }).needsSetup, true);
  state.providers = [{ id: "tensoris" }];
  await new Promise((r) => setTimeout(r, 100));
  const filled = await fetch(`${base}/api/setup/defaults`, { headers: authed() });
  assert.equal(((await filled.json()) as { needsSetup: boolean }).needsSetup, false);
});
```

注意：`needsSetup()` 有 10s 缓存，实现时 `registerProviders` 成功路径已 `setupCache = null`；测试中先读 defaults（写入缓存）再改 state 的场景靠 register 的缓存失效覆盖——`needsSetup` 用例放在 register 用例之后，或直接接受缓存语义：先调 register（清缓存）再读 defaults。若时序脆弱，把 `needsSetup` 用例拆到本文件最前并注释顺序约束——以实际运行绿为准，允许微调用例顺序。

- [ ] **Step 2: Run tests to verify they fail**

Run（在 `plugins/web-ui/` 下）: `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/setup-register.test.ts`
Expected: FAIL —— 回访空 token 仍 400（`service token is required`）；`needsSetup` 字段不存在。

- [ ] **Step 3: Implement — registerProviders 与 defaults**

`plugins/web-ui/server/index.ts`：

① `registerProviders` 的 token 校验改为首启必填、回访剥离：

```ts
const token = typeof body.token === "string" ? body.token.trim() : "";
const firstBoot = await needsSetup();
if (firstBoot && !token) return json(res, 400, { error: "bad_request", message: "service token is required" });
```

② tensoris PUT 体的 `apiKey: token` 改为条件 spread：

```ts
JSON.stringify({
  name: tensoris.name,
  protocol: tensoris.protocol,
  baseUrl: tensoris.baseUrl,
  models: tensoris.models,
  ...(token ? { apiKey: token } : {}),
}),
```

③ `/api/setup/defaults` 响应加 `needsSetup`：

```ts
return json(res, 200, { ...setupDefaults(), gitProxy: readGitProxy(), needsSetup: await needsSetup() });
```

- [ ] **Step 4: Implement — setup.html 首启/回访文案 + 返回链接**

`plugins/web-ui/server/setup.html`：

① token 字段的 `<small>必填</small>` 改为 `<small id="token-rule">首次必填</small>`（placeholder **不动**——静态写死会让首启必填场景看到「留空表示不修改」，自相矛盾；placeholder 在 ② 里按 `needsSetup` 动态切换）。

② defaults 拉取处（现有 `fetch("/api/setup/defaults", ...)` 回调内）加：

```js
if (d && d.needsSetup === false) {
  document.querySelector("h1").textContent = "Meerkat 设置";
  document.querySelector(".sub").textContent = "修改配置后保存即可生效；密钥类字段留空表示不修改。";
  document.getElementById("token").placeholder = "已配置过时留空表示不修改";
}
```

③ 保存按钮的拦截逻辑改为按 `needsSetup` 判定（在 IIFE 顶部声明 `var needsSetup = true;`，defaults 回调里赋值）：

```js
saveBtn.addEventListener("click", function () {
  if (needsSetup && !tokenInput.value.trim()) {
    say("请先粘贴服务令牌", "err");
    return;
  }
  ...
```

④ `</main>` 前加返回链接（script 内设置 href 带 token）：

```html
<p class="hint" style="text-align:center"><a id="back-home" href="/" style="color:var(--muted)">返回主界面</a></p>
```

```js
document.getElementById("back-home").href = "/?portal_token=" + encodeURIComponent(portal);
```

- [ ] **Step 5: Implement — SPA 设置按钮 + i18n 词条**

`plugins/web-ui/src/shell.ts`：

① lucide import 列表加 `Settings`（字母序插入 `Search` 与 `ShieldCheck` 之间）。

② 从 `./composer` 的 import 加 `isDesktop`；`./core-bridge` 的 import 只需新增 `withPortalToken`——`withBase` 已在导入列表（`shell.ts:29`），重复导入会编译失败。

③ 底部栏（`theme-toggle` 之前）加：

```ts
${isDesktop()
  ? html`<a class="icon-btn subtle" href=${withPortalToken(withBase("/setup"))} title=${i18n("Settings")} aria-label=${i18n("Settings")}>${icon(Settings, 17)}</a>`
  : nothing}
```

`${i18n("Settings")}` 直接可用——`zh-cn.ts:532` 已有 `"Settings": "设置"` 词条，**不要**重复添加（object literal 重复 key 触发 eslint `no-dupe-keys`）。

- [ ] **Step 6: Run tests + typecheck**

Run（在 `plugins/web-ui/` 下）: `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/setup-register.test.ts && npm run typecheck`
Expected: 全 PASS，typecheck 无错误。

- [ ] **Step 7: Commit**

```bash
git add plugins/web-ui/server/index.ts plugins/web-ui/server/setup.html plugins/web-ui/src/shell.ts plugins/web-ui/test/setup-register.test.ts
git commit -m "feat(web-ui): revisit-safe setup page with SPA settings entry (优化 2 / 需求 3)"
```

---

### Task 5: setup.html MCP 服务管理区块

**Files:**
- Modify: `plugins/web-ui/server/setup.html`（MCP 列表 + 表单 + 删除确认）

**Interfaces:**
- Consumes: Task 3 的三条路由；core redact 字段（`hasHeaderValue`/`hasBearerToken`/`headerName` 明文）。
- Produces: 无代码接口——纯页面区块；真机验收（Task 6）的操作面。

- [ ] **Step 1: 结构改动（HTML/CSS）**

在「网络代理」`</section>` 之后插入：

```html
<section id="mcp-section">
  <label>MCP 服务 <small>选填，按需配置</small></label>
  <div id="mcp-list"></div>
  <div id="mcp-form" hidden>
    <label for="mcp-id">服务 ID <small>小写字母开头，小写+数字+连字符，2-40 位</small></label>
    <input id="mcp-id" type="text" autocomplete="off" placeholder="如 memory" />
    <label for="mcp-name" style="margin-top:10px">显示名称</label>
    <input id="mcp-name" type="text" autocomplete="off" placeholder="如 记忆服务" />
    <label for="mcp-url" style="margin-top:10px">服务地址</label>
    <input id="mcp-url" type="text" autocomplete="off" placeholder="https://example.com/api/memory/mcp" />
    <label for="mcp-auth" style="margin-top:10px">鉴权方式</label>
    <select id="mcp-auth" style="width:100%;font:inherit;font-size:13px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)">
      <option value="none">无</option>
      <option value="bearer">Bearer 令牌</option>
      <option value="header">自定义请求头</option>
    </select>
    <div id="mcp-bearer-row" hidden style="margin-top:10px">
      <label for="mcp-token">Bearer 令牌</label>
      <input id="mcp-token" type="password" autocomplete="off" />
    </div>
    <div id="mcp-header-rows" hidden style="margin-top:10px">
      <label for="mcp-header-name">请求头名称</label>
      <input id="mcp-header-name" type="text" autocomplete="off" placeholder="如 X-Custom-Key" />
      <label for="mcp-header-value" style="margin-top:10px">请求头密钥</label>
      <input id="mcp-header-value" type="password" autocomplete="off" />
    </div>
    <p class="hint" style="margin-top:10px">
      <label style="display:inline-flex;align-items:center;gap:6px;margin:0"><input id="mcp-readonly" type="checkbox" checked style="width:auto" /> 只读（推荐，agent 不会写入该服务）</label>
      <br />
      <label style="display:inline-flex;align-items:center;gap:6px;margin:6px 0 0"><input id="mcp-enabled" type="checkbox" checked style="width:auto" /> 启用</label>
    </p>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="mcp-save" style="margin-top:0">验证并保存</button>
      <button type="button" id="mcp-cancel" style="margin-top:0;background:var(--line)">取消</button>
    </div>
    <p class="hint" id="mcp-form-status"></p>
  </div>
  <button type="button" id="mcp-add" style="width:auto;padding:8px 16px;font-size:13px">添加 MCP 服务</button>
  <p class="hint">接入外部 MCP 工具服务。保存时会先验证连通性，连不通不会保存。</p>
</section>
```

CSS（`<style>` 内追加）：

```css
.mcp-row { display:flex; align-items:center; gap:8px; padding:8px 0; border-top:1px solid var(--line); font-size:13px; }
.mcp-row .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mcp-row .meta { color:var(--muted); font-size:12px; }
.mcp-row button { width:auto; padding:4px 10px; font-size:12px; margin:0; background:var(--line); }
```

- [ ] **Step 2: 行为改动（页面 script 内追加）**

在 IIFE 内（`saveBtn` 逻辑之后）追加完整 MCP 管理逻辑：

```js
var mcpList = document.getElementById("mcp-list");
var mcpForm = document.getElementById("mcp-form");
var mcpAddBtn = document.getElementById("mcp-add");
var mcpFormStatus = document.getElementById("mcp-form-status");
var editingId = null;

function mcpSay(text, cls) {
  mcpFormStatus.textContent = text;
  mcpFormStatus.style.color = cls === "err" ? "var(--red)" : "var(--muted)";
}

function mcpApi(path, init) {
  return fetch(path, {
    method: (init && init.method) || "GET",
    headers: { "content-type": "application/json", "x-portal-identity": portal },
    body: init && init.body ? JSON.stringify(init.body) : undefined,
  }).then(async function (r) {
    var body = await r.json().catch(function () { return {}; });
    return { status: r.status, body: body };
  });
}

function loadMcp() {
  mcpApi("/api/setup/mcp-servers").then(function (r) {
    if (r.status !== 200) { mcpList.innerHTML = ""; return; }
    var servers = (r.body && r.body.servers) || [];
    var tools = (r.body && r.body.tools) || [];
    mcpList.innerHTML = "";
    servers.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "mcp-row";
      var toolCount = tools.filter(function (t) { return t.serverId === s.id; }).length;
      var secretState = s.auth === "header" ? (s.hasHeaderValue ? "密钥已配置" : "密钥未配置")
        : s.auth === "bearer" ? (s.hasBearerToken ? "令牌已配置" : "令牌未配置") : "无鉴权";
      var info = document.createElement("div");
      info.className = "grow";
      info.innerHTML = "<div>" + (s.name || s.id) + " <span class='meta'>(" + s.id + ")</span></div>" +
        "<div class='meta'>" + s.url + " · " + secretState + " · 工具 " + toolCount + " 个" +
        (s.readOnly ? " · 只读" : "") + (s.enabled ? "" : " · 已停用") + "</div>";
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "编辑";
      edit.addEventListener("click", function () { openMcpForm(s); });
      var del = document.createElement("button");
      del.type = "button";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除后该服务的所有工具将立即下线，确认删除 " + s.id + "？")) return;
        mcpApi("/api/setup/mcp-servers/" + encodeURIComponent(s.id), { method: "DELETE" }).then(function () { loadMcp(); });
      });
      row.appendChild(info); row.appendChild(edit); row.appendChild(del);
      mcpList.appendChild(row);
    });
  });
}

function openMcpForm(s) {
  editingId = s ? s.id : null;
  document.getElementById("mcp-id").value = s ? s.id : "";
  document.getElementById("mcp-id").disabled = !!s;
  document.getElementById("mcp-name").value = s ? s.name || "" : "";
  document.getElementById("mcp-url").value = s ? s.url : "";
  document.getElementById("mcp-auth").value = s ? s.auth : "header";
  document.getElementById("mcp-token").value = "";
  document.getElementById("mcp-header-name").value = s && s.headerName ? s.headerName : "";
  document.getElementById("mcp-header-value").value = "";
  document.getElementById("mcp-readonly").checked = s ? s.readOnly !== false : true;
  document.getElementById("mcp-enabled").checked = s ? s.enabled !== false : true;
  syncMcpAuthRows(s ? s : null);
  mcpForm.hidden = false;
  mcpAddBtn.hidden = true;
  mcpSay("");
}

function syncMcpAuthRows(s) {
  var auth = document.getElementById("mcp-auth").value;
  document.getElementById("mcp-bearer-row").hidden = auth !== "bearer";
  document.getElementById("mcp-header-rows").hidden = auth !== "header";
  var hasSecret = s && (auth === "header" ? s.hasHeaderValue : s.hasBearerToken);
  var keepHint = hasSecret ? "已配置，留空则不修改" : "";
  document.getElementById("mcp-token").placeholder = auth === "bearer" ? keepHint : "";
  document.getElementById("mcp-header-value").placeholder = auth === "header" ? keepHint : "";
}

document.getElementById("mcp-auth").addEventListener("change", function () { syncMcpAuthRows(null); });
mcpAddBtn.addEventListener("click", function () { openMcpForm(null); });
document.getElementById("mcp-cancel").addEventListener("click", function () {
  mcpForm.hidden = true;
  mcpAddBtn.hidden = false;
});
document.getElementById("mcp-save").addEventListener("click", function () {
  var id = editingId || document.getElementById("mcp-id").value.trim();
  var auth = document.getElementById("mcp-auth").value;
  if (!id) { mcpSay("请填写服务 ID", "err"); return; }
  var body = {
    name: document.getElementById("mcp-name").value.trim() || id,
    url: document.getElementById("mcp-url").value.trim(),
    auth: auth,
    readOnly: document.getElementById("mcp-readonly").checked,
    enabled: document.getElementById("mcp-enabled").checked,
  };
  if (auth === "bearer") body.bearerToken = document.getElementById("mcp-token").value;
  if (auth === "header") {
    body.headerName = document.getElementById("mcp-header-name").value.trim();
    body.headerValue = document.getElementById("mcp-header-value").value;
  }
  mcpSay("正在验证并保存…");
  mcpApi("/api/setup/mcp-servers/" + encodeURIComponent(id), { method: "PUT", body: body }).then(function (r) {
    if (r.status !== 200) { mcpSay("保存失败：" + (r.body.message || r.status), "err"); return; }
    mcpForm.hidden = true;
    mcpAddBtn.hidden = false;
    loadMcp();
  });
});

loadMcp();
```

要点（与设计逐条对应）：secret 框留空 → 提交空字符串 → Task 3 路由剥离 → core 保留旧值；「验证并保存」失败（probe 不可达）时 core 400 message 直接显示在表单内（fail-closed）；编辑时 id 禁用；删除有 `confirm` 二次确认。

- [ ] **Step 3: 手动验证（无构建内联页，无单测基建）**

Run（在 `plugins/web-ui/` 下）: `npm run typecheck`（server tsconfig 覆盖 index.ts，setup.html 为静态文件不参与）+ `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/mcp-servers-setup.test.ts test/setup-register.test.ts`
Expected: 全 PASS（回归 Task 3/4，证明本步纯页面改动未动服务端）。
页面行为的最终验证并入 Task 6 真机验收。

- [ ] **Step 4: Commit**

```bash
git add plugins/web-ui/server/setup.html
git commit -m "feat(web-ui): MCP server management section on the desktop setup page (需求 3)"
```

---

### Task 6: ADR-009 + 全量验证 + 真机验收

**Files:**
- Modify: `docs/meerkat/v0.1.2/ADR.md`（新增 ADR-009）

**Interfaces:**
- Consumes: Task 1-5 全部产物。

- [ ] **Step 1: 写 ADR-009**

`docs/meerkat/v0.1.2/ADR.md` 末尾追加：

```markdown
## ADR-009：MCP server 认证支持自定义单头模式——YAGNI 否决任意字典，secret 语义对齐既有凭据

- **状态**：已接受（需求 3，Brainstorming 2026-08-24 拍板）
- **背景**：桌面版需接入 lawaken memory MCP 服务，其鉴权方式为非标准自定义头（`X-Lawaken-MCP-Key`）；core 的 MCP client 只支持 `none / bearer / client-credentials`，`authHeaders()` 只会产出 `Authorization` 头，无法发出自定义头。
- **决策**：`McpServerAuthMode` 新增 `"header"` 单头模式：`McpServer` 增加 `headerName?` / `headerValue?` 两个字段，`authHeaders()` 产出 `{ [name.toLowerCase()]: value }`；路由校验 headerName 为合法 HTTP header token 且大小写不敏感地不在保留名单（authorization/host/content-type/accept/content-length/connection/transfer-encoding）内；`headerValue` 与 `bearerToken`/`clientSecret` 同等待遇（新建必填、更新留空=保留、GET redact 不回明文、不进沙箱）；`redact()` 同步扩展 `hasHeaderValue`。实现保持上游可贡献形态：代码与测试零 meerkat/lawaken 字样，测试用中性头名 `X-Custom-Key`，保留 upstream-pr 送回主仓的选项。
- **被否决**：
  - 任意字典 `Record<string,string>` —— lawaken 只需一个头，X-API-Key 类服务也几乎都是单头；Record 是为「一个调用方都没有的模式」造的抽象（AGENTS.md 明确反对），且每个 key 都要重复保留名单校验、鼓励塞非鉴权头，语义变浑；
  - lawaken 侧兼容 `Authorization: Bearer` —— 依赖外部团队排期，且需求给定的鉴权方式就是自定义头；
  - 本地 sidecar 代理改写头 —— 零内核改动但多一个常驻组件，key 的管理面反而变大。
- **后果**：内核缝改动四处——`mcp-server-store.ts`（类型）、`mcp-client.ts`（`McpAuth` + `authHeaders()`）、`mcp-servers.ts`（`AUTH_MODES` + 校验 + `redact()` 签名扩展）、`mcp-tool-service.ts`（`authOf()` 映射）；存量 none/bearer/client-credentials 注册行为逐字节不变；回归测试把守（`test/mcp-connectors.test.ts` 传输层、`test/mcp-servers-route.test.ts` 路由校验/redact/留空=保留/切换清 secret/probe fail-closed）。
```

- [ ] **Step 2: 全量受影响测试 + typecheck + lint**

Run（仓根）: `node --experimental-test-module-mocks --test test/mcp-connectors.test.ts test/mcp-servers-route.test.ts && npm run typecheck`
Run（`plugins/web-ui/`）: `$env:NODE_ENV='test'; $env:ALLOW_UNSIGNED_TEST_IDENTITY='1'; node --test test/mcp-servers-setup.test.ts test/mcp-servers-setup-nondesktop.test.ts test/setup-register.test.ts test/skillpacks-desktop.test.ts test/locale.test.ts && npm run typecheck`
Run（仓根）: `npx eslint src/mcp src/api/routes/admin/mcp-servers.ts plugins/web-ui/server plugins/web-ui/src/shell.ts plugins/web-ui/src/locale`
Expected: 全绿。

- [ ] **Step 3: 真机验收（手动，验收而非兜底）**

启动桌面形态的 dev 环境（Git Bash，仓根；`MEERKAT_DESKTOP=1` 必须显式带上，脚本自身不设——否则 `/api/setup/mcp-servers` 全 404、设置按钮不渲染）：

```bash
MEERKAT_DESKTOP=1 bash scripts/meerkat-local-up.sh
```

脚本会拉起 sidecar :8090 / core :8081 / web-ui :8096（env 由父 shell 继承进 web-ui 子进程）。浏览器开 `http://localhost:8096`，任意 id 登录，从底栏设置按钮（带 token）进 `/setup`。在设置页用真实 lawaken dev 地址 + key 注册 `lawaken-memory-dev`，确认：

1. probe 通过，保存成功，列表显示工具数（>0）；
2. GET `/api/setup/mcp-servers` 响应与页面中均不出现 key 明文（`hasHeaderValue: true`）；
3. 新会话里 agent 能调用 `lawaken-memory-dev_*` 工具召回记忆；
4. 编辑该 server 留空密钥保存 → 密钥保留（工具仍可用）；
5. 主界面设置按钮带 token 跳转 `/setup`（连续运行超 24h 场景可用旧 token 复现验证自愈逻辑），返回主界面链接闭环。

- [ ] **Step 4: Commit**

```bash
git add docs/meerkat/v0.1.2/ADR.md
git commit -m "docs(adr): ADR-009 custom single-header auth for MCP servers (需求 3)"
```

---

## Self-Review 记录

**Spec coverage**：设计文档七节 → Task 映射：第一节 core 认证扩展 → Task 1/2；第二节转发路由 → Task 3；第三节表单+回访入口 → Task 4/5；第四节数据流/错误处理 → 无独立代码（机制性描述，由 Task 2 probe fail-closed 测试与 Task 5 表单错误展示承接）；第五节测试验收 → 各 Task TDD + Task 6 真机验收；第六节 ADR 义务 → Task 6 Step 1；第七节不做 → 计划中无对应任务（已核对：无种子预置、无 client-credentials 表单项、无写能力、无 SPA Lit 视图、无 id 预校验、无非 DESKTOP UI）。

**签名联动点核对**（Global Constraints 要求列全）：`McpServerAuthMode` 波及点 = Task 1（store/client/tool-service 三处）+ Task 2（路由 `AUTH_MODES`/校验/`redact` 三处）——六处全部入列，无遗漏。

**Type consistency**：`headerName`/`headerValue`/`hasHeaderValue` 三个字段名在 Task 1（定义）→ Task 2（校验/redact）→ Task 3（剥离键名）→ Task 5（表单 body/列表显示）逐字一致；路由路径 `/api/setup/mcp-servers[/:id]` 在 Task 3/5 一致；`needsSetup` 响应字段在 Task 4 服务端与 setup.html 一致。

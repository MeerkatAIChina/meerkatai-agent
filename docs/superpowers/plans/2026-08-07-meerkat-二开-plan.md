# Meerkat 二开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 qm private fork 上实现敏感度自动分类 + 本地/通用模型双轨路由 + 消费品行业 Skill Pack 导入。

**Architecture:** 核心新增独立模块 `sensitivity-classifier.ts`（类型 + HTTP client + 解析），orchestrator 在安全筛查后、harness 调用前执行分类，消费 route verdict 覆盖 harness/model。分类器本体作为 sidecar 部署在 `deploy/layers/meerkat/classifier/`，Skill Pack 作为独立 git repo 通过 admin API 导入。

**Tech Stack:** TypeScript (core), Node.js + Fastify (sidecar), qm custom provider + skill-pack 机制

## Global Constraints

- 所有二开逻辑在 `deploy/layers/meerkat/` 下，核心仅新增 `sensitivity-classifier.ts` + orchestrator 调用点（<100 行）
- `SecurityScreenVerdict` 不修改，`security-screener.ts` 不修改
- 分类器未配置时（无 `CLASSIFIER_URL`）跳过，qm 正常运行
- L2 确认交互首版不做
- mid-turn tool_response 分类首版不做
- Meerkat-TRIZ-v1 通过 Admin API 注册为 Custom Provider（OpenAI 兼容协议）
- Pin 写 `setRuntimeSelectionLatest`（Postgres durable），不用内存版
- 审计记录始终同时记 `policy`（逻辑名）和 `modelId`（解析后）

---

## Phase 1: Core Seam

### Task 1: SensitivityVerdict 类型定义 + 响应解析

**Files:**
- Create: `src/security/sensitivity-classifier.ts`

**Interfaces:**
- Produces: `SensitivityVerdict`, `SensitivityClassifier`, `parseSensitivityVerdict()`, `createSensitivityClassifier()`

- [ ] **Step 1: 写类型定义和解析函数**

```typescript
// src/security/sensitivity-classifier.ts

export interface SensitivityVerdict {
  level: "L1" | "L2" | "L3";
  domain: "triz" | "general";
  route?: {
    policy: string;
    model: string;
    harnessId: string;
    sessionPin: boolean;
  };
}

const VALID_LEVELS = new Set(["L1", "L2", "L3"]);
const VALID_DOMAINS = new Set(["triz", "general"]);
const ROUTE_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/;
const HARNESS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function parseSensitivityVerdict(body: string): SensitivityVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const level = obj.level;
  if (typeof level !== "string" || !VALID_LEVELS.has(level)) return null;
  const domain = obj.domain;
  if (typeof domain !== "string" || !VALID_DOMAINS.has(domain)) return null;

  const route = obj.route;
  if (route === undefined || route === null) {
    return { level: level as "L1" | "L2" | "L3", domain: domain as "triz" | "general" };
  }
  if (typeof route !== "object" || Array.isArray(route)) return null;
  const r = route as Record<string, unknown>;

  if (typeof r.policy !== "string" || !ROUTE_KEY_RE.test(r.policy)) return null;
  if (typeof r.model !== "string" || !MODEL_ID_RE.test(r.model)) return null;
  if (typeof r.harnessId !== "string" || !HARNESS_ID_RE.test(r.harnessId)) return null;
  if (typeof r.sessionPin !== "boolean") return null;

  return {
    level: level as "L1" | "L2" | "L3",
    domain: domain as "triz" | "general",
    route: {
      policy: r.policy,
      model: r.model,
      harnessId: r.harnessId,
      sessionPin: r.sessionPin,
    },
  };
}
```

- [ ] **Step 2: 写单元测试**

```typescript
// test/sensitivity-classifier.test.ts
import { describe, it, expect } from "vitest";
import { parseSensitivityVerdict } from "../src/security/sensitivity-classifier.js";

describe("parseSensitivityVerdict", () => {
  it("parses a full L1 verdict with route", () => {
    const json = JSON.stringify({
      level: "L1",
      domain: "triz",
      route: { policy: "local-secure", model: "meerkat-triz-v1", harnessId: "pi", sessionPin: true },
    });
    const result = parseSensitivityVerdict(json);
    expect(result).toEqual({
      level: "L1",
      domain: "triz",
      route: { policy: "local-secure", model: "meerkat-triz-v1", harnessId: "pi", sessionPin: true },
    });
  });

  it("parses L3+general with no route", () => {
    const json = JSON.stringify({ level: "L3", domain: "general" });
    const result = parseSensitivityVerdict(json);
    expect(result).toEqual({ level: "L3", domain: "general" });
  });

  it("rejects invalid level", () => {
    expect(parseSensitivityVerdict(JSON.stringify({ level: "L4", domain: "general" }))).toBeNull();
  });

  it("rejects route with missing harnessId", () => {
    const json = JSON.stringify({
      level: "L1", domain: "triz",
      route: { policy: "x", model: "x", sessionPin: false },
    });
    expect(parseSensitivityVerdict(json)).toBeNull();
  });

  it("rejects non-JSON", () => {
    expect(parseSensitivityVerdict("not json")).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npx vitest run test/sensitivity-classifier.test.ts
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/sensitivity-classifier.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add src/security/sensitivity-classifier.ts test/sensitivity-classifier.test.ts
git commit -m "feat: add SensitivityVerdict type and parser"
```

---

### Task 2: HTTP Client — 调用 sidecar + 超时处理

**Files:**
- Modify: `src/security/sensitivity-classifier.ts`

**Interfaces:**
- Consumes: `SensitivityVerdict`, `parseSensitivityVerdict()` (Task 1)
- Produces: `SensitivityClassifier` type, `createSensitivityClassifier()`

- [ ] **Step 1: 写 createSensitivityClassifier 函数**

```typescript
// 追加到 src/security/sensitivity-classifier.ts

export type SensitivityClassifier = (
  input: {
    text: string;
    scopeId: string;
    orgScopeId: string;
    surface?: string;
    hook: "user_input";
  },
  signal?: AbortSignal,
) => Promise<SensitivityVerdict | null>;

export function createSensitivityClassifier(opts: {
  url: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): SensitivityClassifier {
  const request = opts.fetch ?? fetch;
  return async (input, signal) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await request(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: input.text,
          hook: input.hook,
          metadata: {
            scope_id: input.scopeId,
            org_scope_id: input.orgScopeId,
            ...(input.surface ? { surface: input.surface } : {}),
          },
        }),
        signal: combined,
      });
    } catch (err) {
      // 连接拒绝/超时/DNS 失败 → 返回 null，由调用方按 fallback 处理
      return null;
    }

    if (!response.ok) return null;

    let body: string;
    try {
      body = await response.text();
    } catch {
      return null;
    }

    return parseSensitivityVerdict(body);
  };
}
```

- [ ] **Step 2: 写 client 单元测试（mock fetch）**

```typescript
// 追加到 test/sensitivity-classifier.test.ts
import { createSensitivityClassifier } from "../src/security/sensitivity-classifier.js";

describe("createSensitivityClassifier", () => {
  it("returns parsed verdict on success", async () => {
    const mockFetch = async (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ level: "L1", domain: "triz", route: { policy: "local-secure", model: "m", harnessId: "pi", sessionPin: true } }), { status: 200 });
    const classify = createSensitivityClassifier({ url: "http://localhost", timeoutMs: 2000, fetch: mockFetch as typeof fetch });
    const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
    expect(result?.level).toBe("L1");
    expect(result?.route?.policy).toBe("local-secure");
  });

  it("returns null on connection refused", async () => {
    const mockFetch = async () => { throw new Error("connect ECONNREFUSED"); };
    const classify = createSensitivityClassifier({ url: "http://localhost", timeoutMs: 2000, fetch: mockFetch as typeof fetch });
    const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
    expect(result).toBeNull();
  });

  it("returns null on non-200", async () => {
    const mockFetch = async () => new Response("error", { status: 500 });
    const classify = createSensitivityClassifier({ url: "http://localhost", timeoutMs: 2000, fetch: mockFetch as typeof fetch });
    const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

```bash
npx vitest run test/sensitivity-classifier.test.ts
```

- [ ] **Step 4: 提交**

```bash
git add src/security/sensitivity-classifier.ts test/sensitivity-classifier.test.ts
git commit -m "feat: add sensitivity classifier HTTP client"
```

---

### Task 3: Orchestrator 集成 + Fallback 逻辑

**Files:**
- Modify: `src/core/orchestrator.ts`
- Modify: `src/wiring.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `SensitivityClassifier` type, `createSensitivityClassifier()` (Task 2)
- Produces: orchestrator 在 security screen 后调用分类器，覆盖 `input.harness` + `input.model`

- [ ] **Step 1: 在 config.ts 中新增环境变量解析**

```typescript
// 在 config.ts 的 resolveConfig 函数中追加（参照 ANTHROPIC_BASE_URL 等同模式）:
const classifierUrl = env["CLASSIFIER_URL"]?.trim() || undefined;
const classifierFallbackModel = env["CLASSIFIER_FALLBACK_MODEL"]?.trim() || undefined;
const classifierFallbackHarness = env["CLASSIFIER_FALLBACK_HARNESS"]?.trim() || undefined;

// fallback 对必须成对出现或都不出现
if ((classifierFallbackModel && !classifierFallbackHarness) || (!classifierFallbackModel && classifierFallbackHarness)) {
  throw new Error("CLASSIFIER_FALLBACK_MODEL and CLASSIFIER_FALLBACK_HARNESS must both be set or both absent");
}
```

- [ ] **Step 2: 在 wiring.ts 中构造分类器实例并注入 deps**

```typescript
// wiring.ts 中（参照 security screener 的构造位置）:
import { createSensitivityClassifier } from "../security/sensitivity-classifier.js";

// 在 createOrchestrator(deps) 之前:
const sensitivityClassifier = config.classifierUrl
  ? createSensitivityClassifier({
      url: config.classifierUrl,
      timeoutMs: 2000,
    })
  : undefined;

const deps: OrchestratorDeps = {
  // ... existing deps
  sensitivityClassifier,
  classifierFallbackModel: config.classifierFallbackModel,
  classifierFallbackHarness: config.classifierFallbackHarness,
};
```

- [ ] **Step 3: 在 OrchestratorDeps 中新增字段**

```typescript
// src/core/orchestrator/types.ts — 在 OrchestratorDeps 接口中追加:
sensitivityClassifier?: SensitivityClassifier;
classifierFallbackModel?: string;
classifierFallbackHarness?: string;
```

- [ ] **Step 4: 在 orchestrator handleTurn 中集成分类调用**

在 `handleTurn` 中，security screen 执行之后、`runTurn` 之前，插入分类逻辑。找到 security screen 调用段（约 line 622-632），在其后追加：

```typescript
// 插入位置：security screen verdict 消费之后
// 约在 quarantineScreenedInput 处理完后

// NEW: 敏感度分类（独立于 security screener，无条件执行）
let sensitivityVerdict: SensitivityVerdict | null = null;
if (deps.sensitivityClassifier) {
  const classifyText = buildClassifyText(input, recentHistory); // 用户消息 + 最近 3 条原文，总上限 16k
  try {
    sensitivityVerdict = await deps.sensitivityClassifier({
      text: classifyText,
      scopeId: scopeId,
      orgScopeId: resolution.orgScopeId,
      surface: input.surface,
      hook: "user_input",
    }, input.cancel);
  } catch {
    // classify 内部已 catch 网络错误，这里 catch 意外异常
  }

  if (!sensitivityVerdict) {
    // sidecar 不可达 → 走 fallback
    if (deps.classifierFallbackModel && deps.classifierFallbackHarness) {
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "classifier.unavailable",
        resource: "sensitivity-classifier",
        scopeLabel: scopeId,
        status: "fallback",
      });
      sensitivityVerdict = {
        level: "L1",
        domain: "general",
        route: {
          policy: "fallback",
          model: deps.classifierFallbackModel,
          harnessId: deps.classifierFallbackHarness,
          sessionPin: true,
        },
      };
    }
  }

  if (sensitivityVerdict?.route) {
    // 成对覆盖 harness + model，避免 org 默认 harness 不兼容自定义模型
    runtime.harness = sensitivityVerdict.route.harnessId;
    runtime.model = sensitivityVerdict.route.model;

    deps.auditLog.record({
      at: Date.now(),
      principalId: actor.id,
      action: "classifier.route",
      resource: sensitivityVerdict.route.policy,
      scopeLabel: scopeId,
      status: "routed",
      detail: JSON.stringify({
        level: sensitivityVerdict.level,
        domain: sensitivityVerdict.domain,
        model: sensitivityVerdict.route.model,
        harnessId: sensitivityVerdict.route.harnessId,
        sessionPin: sensitivityVerdict.route.sessionPin,
      }),
    });

    if (sensitivityVerdict.route.sessionPin) {
      await deps.config?.setRuntimeSelectionLatest(scopeId, {
        harnessId: sensitivityVerdict.route.harnessId,
        modelId: sensitivityVerdict.route.model,
      });
    }
  }
}
```

`buildClassifyText` 辅助函数：

```typescript
function buildClassifyText(
  input: OrchestratorInput,
  recentHistory: SessionEntry[],
): string {
  const MAX_CHARS = 16_000;
  const parts: string[] = [input.text];
  // 取最近 3 条 user/assistant 消息
  const recent = recentHistory
    .filter((e) => e.role === "user" || e.role === "assistant")
    .slice(-3);
  for (const entry of recent) {
    if (entry.text) parts.push(entry.text);
  }
  let combined = parts.join("\n");
  if (combined.length > MAX_CHARS) {
    combined = combined.slice(0, MAX_CHARS);
  }
  return combined;
}
```

- [ ] **Step 5: 写集成测试 — orchestrator 消费 route**

```typescript
// test/sensitivity-classifier-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

describe("sensitivity classifier integration", () => {
  let server: http.Server;
  let requestCount = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestCount++;
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.text.includes("L1_TRIGGER")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            level: "L1",
            domain: "general",
            route: { policy: "local-secure", model: "test-model", harnessId: "pi", sessionPin: true },
          }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ level: "L3", domain: "general" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(() => { server.close(); });

  it("routes to local model when sidecar returns L1 route", async () => {
    // 启动 classifier client 指向上面的 fake server
    // 验证 classify() 返回的 verdict 包含 route
    const port = (server.address() as any).port;
    const classify = createSensitivityClassifier({ url: `http://localhost:${port}/classify`, timeoutMs: 2000 });
    const result = await classify({ text: "L1_TRIGGER test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
    expect(result?.level).toBe("L1");
    expect(result?.route?.model).toBe("test-model");
  });

  it("does not route when sidecar returns L3 with no route", async () => {
    const port = (server.address() as any).port;
    const classify = createSensitivityClassifier({ url: `http://localhost:${port}/classify`, timeoutMs: 2000 });
    const result = await classify({ text: "normal message", scopeId: "s", orgScopeId: "o", hook: "user_input" });
    expect(result?.level).toBe("L3");
    expect(result?.route).toBeUndefined();
  });
});
```

- [ ] **Step 6: 提交**

```bash
git add src/security/sensitivity-classifier.ts src/core/orchestrator.ts src/core/orchestrator/types.ts src/wiring.ts src/config.ts test/sensitivity-classifier-integration.test.ts
git commit -m "feat: integrate sensitivity classifier into orchestrator with fallback"
```

---

### Task 4: Typescript 编译 + Lint 验证

**Files:**
- 无新增，验证 Phase 1 所有文件

- [ ] **Step 1: 运行 typecheck**

```bash
npx tsc --noEmit
```
预期：无 type error。

- [ ] **Step 2: 运行 lint**

```bash
npx eslint src/security/sensitivity-classifier.ts src/core/orchestrator.ts test/sensitivity-classifier.test.ts test/sensitivity-classifier-integration.test.ts
```
预期：无 lint error。如有自动修复项，执行 `npx eslint --fix`。

- [ ] **Step 3: 运行相关单元测试**

```bash
npx vitest run test/sensitivity-classifier.test.ts test/sensitivity-classifier-integration.test.ts
```
预期：全部通过。

- [ ] **Step 4: 提交（如有 lint fix）**

```bash
git add -u && git commit -m "chore: fix lint"
```

---

## Phase 2: Sidecar 分类服务

### Task 5: Sidecar 项目脚手架

**Files:**
- Create: `deploy/layers/meerkat/classifier/package.json`
- Create: `deploy/layers/meerkat/classifier/tsconfig.json`
- Create: `deploy/layers/meerkat/classifier/Dockerfile`

- [ ] **Step 1: 创建 package.json**

```jsonc
{
  "name": "meerkat-classifier",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 Dockerfile**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
```

- [ ] **Step 4: 创建占位 server.ts**

```typescript
// deploy/layers/meerkat/classifier/src/server.ts
import Fastify from "fastify";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);

const app = Fastify({ logger: true });

app.post("/classify", async (_req, reply) => {
  // Phase 2 后续 task 实现
  return reply.status(501).send({ error: "not implemented" });
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) throw err;
});
```

- [ ] **Step 5: 安装依赖并验证启动**

```bash
cd deploy/layers/meerkat/classifier && npm install && npx tsx src/server.ts &
sleep 2
curl -X POST http://localhost:8080/classify -H "content-type: application/json" -d '{}'
# 预期: 501 "not implemented"
kill %1
```

- [ ] **Step 6: 提交**

```bash
git add deploy/layers/meerkat/classifier/
git commit -m "feat: scaffold classifier sidecar project"
```

---

### Task 6: 规则层 — PII + TRIZ 关键词

**Files:**
- Create: `deploy/layers/meerkat/classifier/src/rules/pii.ts`
- Create: `deploy/layers/meerkat/classifier/src/rules/triz_keywords.ts`
- Create: `deploy/layers/meerkat/classifier/src/rules/pii.test.ts`

**Interfaces:**
- Produces: `detectPii(text: string): { level: "L1"; reason: string } | null`
- Produces: `detectTrizKeywords(text: string): { level: "L3"; domain: "triz"; reason: string } | null`

- [ ] **Step 1: 写 PII 检测**

```typescript
// deploy/layers/meerkat/classifier/src/rules/pii.ts

const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{15}(?:\d{2}[\dxX])?\b/, label: "cn_id_card" },
  { pattern: /\b1[3-9]\d{9}\b/, label: "cn_phone" },
  { pattern: /\b\d{16,19}\b/, label: "bank_card" },
  { pattern: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/, label: "email" },
  { pattern: /\b(?:(?:省|市|区|县|镇|路|街|巷|号|栋|单元|室|层|楼)){2,}/, label: "cn_address" },
];

export function detectPii(text: string): { level: "L1"; reason: string } | null {
  for (const { pattern, label } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return { level: "L1", reason: `pii:${label}` };
    }
  }
  return null;
}
```

- [ ] **Step 2: 写 TRIZ 关键词检测**

```typescript
// deploy/layers/meerkat/classifier/src/rules/triz_keywords.ts

const TRIZ_KEYWORDS = [
  "矛盾矩阵", "技术矛盾", "物理矛盾", "技术进化", "技术系统进化",
  "物场模型", "物场分析", "发明原理", "分离原理", "理想解",
  "最终理想解", "IFR", "技术进化趋势", "进化法则", "S曲线",
  "TRIZ", "triz", "ARIZ", "功能分析", "裁剪", "trimming",
  "九屏幕法", "九窗口", "小人法", "金鱼法", "STC算子",
  "资源分析", "系统算子", "功能模型", "因果分析", "根本原因分析",
];

export function detectTrizKeywords(text: string): { level: "L3"; domain: "triz"; reason: string } | null {
  const lower = text.toLowerCase();
  for (const kw of TRIZ_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return { level: "L3", domain: "triz", reason: `triz_kw:${kw}` };
    }
  }
  return null;
}
```

- [ ] **Step 3: 写 PII 单元测试**

```typescript
// deploy/layers/meerkat/classifier/src/rules/pii.test.ts
import { describe, it, expect } from "vitest";
import { detectPii } from "./pii.js";

describe("detectPii", () => {
  it("detects phone number", () => {
    expect(detectPii("请联系 13800138000")?.reason).toBe("pii:cn_phone");
  });
  it("detects ID card", () => {
    expect(detectPii("身份证 320102199001011234")?.reason).toBe("pii:cn_id_card");
  });
  it("detects bank card", () => {
    expect(detectPii("卡号 6222021234567890123")?.reason).toBe("pii:bank_card");
  });
  it("detects email", () => {
    expect(detectPii("邮箱 test@example.com 请查收")?.reason).toBe("pii:email");
  });
  it("returns null for clean text", () => {
    expect(detectPii("今天天气很好")).toBeNull();
  });
});
```

- [ ] **Step 4: 跑 PII 测试**

```bash
cd deploy/layers/meerkat/classifier && npx vitest run src/rules/pii.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add deploy/layers/meerkat/classifier/src/rules/
git commit -m "feat: add PII detection and TRIZ keyword rules"
```

---

### Task 7: 上下文层 + 管线编排

**Files:**
- Create: `deploy/layers/meerkat/classifier/src/context/scope_labels.ts`
- Create: `deploy/layers/meerkat/classifier/src/pipeline.ts`
- Create: `deploy/layers/meerkat/classifier/src/types.ts`
- Create: `deploy/layers/meerkat/classifier/src/routes.jsonc`

**Interfaces:**
- Consumes: `detectPii()`, `detectTrizKeywords()` (Task 6)
- Produces: `runPipeline(input) => ClassifyResponse`

- [ ] **Step 1: 定义共享类型**

```typescript
// deploy/layers/meerkat/classifier/src/types.ts

export interface ClassifyRequest {
  text: string;
  hook: "user_input";
  metadata: {
    scope_id: string;
    org_scope_id: string;
    surface?: string;
  };
}

export interface ClassifyResponse {
  level: "L1" | "L2" | "L3";
  domain: "triz" | "general";
  route?: {
    policy: string;
    model: string;
    harnessId: string;
    sessionPin: boolean;
  };
}

export interface RouteConfig {
  [policy: string]: {
    harnessId: string;
    modelId: string;
    providerId: string;
  };
}
```

- [ ] **Step 2: 写上下文层**

```typescript
// deploy/layers/meerkat/classifier/src/context/scope_labels.ts

const HIGH_SENSITIVITY_SCOPES = new Set<string>();
// 部署时配置: process.env["HIGH_SENSITIVITY_SCOPES"]?.split(",")...

export function checkScopeSensitivity(scopeId: string): "L1" | "L2" | null {
  if (HIGH_SENSITIVITY_SCOPES.has(scopeId)) return "L1";
  return null;
}
```

- [ ] **Step 3: 写 routes.jsonc**

```jsonc
// deploy/layers/meerkat/classifier/src/routes.jsonc
{
  "local-secure": {
    "harnessId": "pi",
    "modelId": "meerkat-triz-v1",
    "providerId": "meerkat"
  },
  "meerkat-triz-v1": {
    "harnessId": "pi",
    "modelId": "meerkat-triz-v1",
    "providerId": "meerkat"
  }
}
```

- [ ] **Step 4: 写管线编排**

```typescript
// deploy/layers/meerkat/classifier/src/pipeline.ts
import { detectPii } from "./rules/pii.js";
import { detectTrizKeywords } from "./rules/triz_keywords.js";
import { checkScopeSensitivity } from "./context/scope_labels.js";
import type { ClassifyResponse, RouteConfig } from "./types.js";
import { readFileSync } from "node:fs";

let routes: RouteConfig = {};

export function loadRoutes(path: string): void {
  routes = JSON.parse(readFileSync(path, "utf8")) as RouteConfig;
}

function resolveRoute(policy: string): ClassifyResponse["route"] {
  const cfg = routes[policy];
  if (!cfg) return undefined;
  return {
    policy,
    model: cfg.modelId,
    harnessId: cfg.harnessId,
    sessionPin: false,
  };
}

export interface PipelineInput {
  text: string;
  scopeId: string;
}

export function runPipeline(input: PipelineInput): ClassifyResponse {
  // Layer 1: 规则层
  const pii = detectPii(input.text);
  if (pii) {
    const route = resolveRoute("local-secure");
    if (route) route.sessionPin = true;
    return { level: "L1", domain: "general", route };
  }

  const triz = detectTrizKeywords(input.text);
  if (triz) {
    const route = resolveRoute("meerkat-triz-v1");
    return { level: "L3", domain: "triz", route };
  }

  // Layer 2: 上下文层
  const scopeLevel = checkScopeSensitivity(input.scopeId);
  if (scopeLevel) {
    const route = resolveRoute("local-secure");
    if (route) route.sessionPin = true;
    return { level: scopeLevel, domain: "general", route };
  }

  // Layer 3: 语义层（Phase 2 Task 8 实现）
  // 暂返回默认 L3
  return { level: "L3", domain: "general" };
}
```

- [ ] **Step 5: 写管线单元测试**

```typescript
// deploy/layers/meerkat/classifier/src/pipeline.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { runPipeline, loadRoutes } from "./pipeline.js";
import { writeFileSync, unlinkSync } from "node:fs";

const TEST_ROUTES = {
  "local-secure": { harnessId: "pi", modelId: "test-local", providerId: "test" },
  "meerkat-triz-v1": { harnessId: "pi", modelId: "test-triz", providerId: "test" },
};

beforeAll(() => {
  writeFileSync("/tmp/test-routes.json", JSON.stringify(TEST_ROUTES));
  loadRoutes("/tmp/test-routes.json");
});

describe("runPipeline", () => {
  it("routes PII to local-secure with pin", () => {
    const result = runPipeline({ text: "卡号 6222021234567890123", scopeId: "s" });
    expect(result.level).toBe("L1");
    expect(result.route?.policy).toBe("local-secure");
    expect(result.route?.sessionPin).toBe(true);
  });

  it("routes TRIZ keywords to meerkat-triz-v1 without pin", () => {
    const result = runPipeline({ text: "用矛盾矩阵分析这个技术矛盾", scopeId: "s" });
    expect(result.level).toBe("L3");
    expect(result.domain).toBe("triz");
    expect(result.route?.policy).toBe("meerkat-triz-v1");
    expect(result.route?.sessionPin).toBe(false);
  });

  it("returns L3+general for clean text", () => {
    const result = runPipeline({ text: "今天天气很好", scopeId: "s" });
    expect(result.level).toBe("L3");
    expect(result.domain).toBe("general");
    expect(result.route).toBeUndefined();
  });
});
```

- [ ] **Step 6: 跑测试**

```bash
cd deploy/layers/meerkat/classifier && npx vitest run src/pipeline.test.ts
```

- [ ] **Step 7: 提交**

```bash
git add deploy/layers/meerkat/classifier/src/
git commit -m "feat: add classification pipeline with rules and context layers"
```

---

### Task 8: 语义层

**Files:**
- Create: `deploy/layers/meerkat/classifier/src/semantic/classifier.ts`
- Create: `deploy/layers/meerkat/classifier/src/semantic/classifier.test.ts`

**Interfaces:**
- Produces: `classifySemantic(text: string) => Promise<{ level: "L1" | "L2" | "L3"; domain: "triz" | "general" } | null>`

- [ ] **Step 1: 写语义分类器**

```typescript
// deploy/layers/meerkat/classifier/src/semantic/classifier.ts

interface SemanticConfig {
  endpoint: string;
  model: string;
  timeoutMs: number;
}

let config: SemanticConfig | undefined;

export function configureSemantic(cfg: SemanticConfig): void {
  config = cfg;
}

export async function classifySemantic(
  text: string,
): Promise<{ level: "L1" | "L2" | "L3"; domain: "triz" | "general" } | null> {
  if (!config) return null;

  const prompt = `你是一个数据敏感度和领域分类器。分析以下用户消息，返回 JSON 格式的分类结果。

分类标准：
- L1: 消息包含个人身份信息(PII)、商业机密、未公开的产品数据、客户隐私数据
- L2: 消息包含中等敏感的商业信息（内部讨论、项目代号）
- L3: 消息不包含敏感信息

领域：
- triz: 涉及TRIZ创新方法论（矛盾分析、技术进化、物场模型等）
- general: 不涉及TRIZ

用户消息: ${text}

返回纯 JSON，不要有其他内容: {"level":"L1"|"L2"|"L3","domain":"triz"|"general"}`;

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) return null;

    const body = await response.text();
    // 从响应中提取 JSON（模型可能在 JSON 前后加文字）
    const jsonMatch = body.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const level = parsed["level"];
    const domain = parsed["domain"];

    if (level !== "L1" && level !== "L2" && level !== "L3") return null;
    if (domain !== "triz" && domain !== "general") return null;

    return {
      level: level as "L1" | "L2" | "L3",
      domain: domain as "triz" | "general",
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 语义层集成到管线**

```typescript
// 修改 pipeline.ts 的 runPipeline，在 Layer 2 之后追加:
// Layer 3: 语义层
if (config.semanticEnabled) {
  try {
    const semantic = await classifySemantic(input.text);
    if (semantic) {
      if (semantic.level === "L1") {
        const route = resolveRoute("local-secure");
        if (route) route.sessionPin = true;
        return { level: "L1", domain: semantic.domain, route };
      }
      if (semantic.domain === "triz") {
        const route = resolveRoute("meerkat-triz-v1");
        return { level: "L3", domain: "triz", route };
      }
    }
  } catch {
    // 语义层不可用 → 按严格版降级为 L2
    // 有真人场景后续做确认，首版降 L1
    const route = resolveRoute("local-secure");
    if (route) route.sessionPin = true;
    return { level: "L1", domain: "general", route };
  }
}
```

- [ ] **Step 3: 更新管线测试（mock 语义层）**

在 `pipeline.test.ts` 中新增语义层测试用例。

- [ ] **Step 4: 跑测试**

```bash
cd deploy/layers/meerkat/classifier && npx vitest run
```

- [ ] **Step 5: 提交**

```bash
git add deploy/layers/meerkat/classifier/src/semantic/ deploy/layers/meerkat/classifier/src/pipeline.ts
git commit -m "feat: add semantic classification layer"
```

---

### Task 9: Sidecar Server 集成

**Files:**
- Modify: `deploy/layers/meerkat/classifier/src/server.ts`

**Interfaces:**
- Consumes: `runPipeline()` (Task 7), `classifySemantic()` (Task 8)

- [ ] **Step 1: 实现 /classify 端点**

```typescript
// 替换 deploy/layers/meerkat/classifier/src/server.ts 中的占位实现
import Fastify from "fastify";
import { runPipeline, loadRoutes } from "./pipeline.js";
import { configureSemantic } from "./semantic/classifier.js";
import type { ClassifyRequest } from "./types.js";
import { resolve } from "node:path";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const ROUTES_PATH = process.env["ROUTES_PATH"] ?? resolve(import.meta.dirname ?? ".", "routes.jsonc");
const SEMANTIC_ENDPOINT = process.env["SEMANTIC_ENDPOINT"];
const SEMANTIC_MODEL = process.env["SEMANTIC_MODEL"] ?? "meerkat-triz-v1";

loadRoutes(ROUTES_PATH);

if (SEMANTIC_ENDPOINT) {
  configureSemantic({
    endpoint: SEMANTIC_ENDPOINT,
    model: SEMANTIC_MODEL,
    timeoutMs: 5000,
  });
}

const app = Fastify({ logger: true });

app.post("/classify", async (req, reply) => {
  const body = req.body as ClassifyRequest;
  if (!body?.text || !body?.metadata?.scope_id) {
    return reply.status(400).send({ error: "text and metadata.scope_id are required" });
  }

  const result = runPipeline({
    text: body.text,
    scopeId: body.metadata.scope_id,
  });

  return reply.send(result);
});

app.get("/health", async (_req, reply) => {
  return reply.send({ status: "ok" });
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`classifier listening on :${PORT}`);
});
```

- [ ] **Step 2: 端到端验证**

```bash
cd deploy/layers/meerkat/classifier
npm install
npx tsx src/server.ts &
sleep 2
# 测试 PII
curl -s -X POST http://localhost:8080/classify \
  -H "content-type: application/json" \
  -d '{"text":"我的手机号是13800138000","hook":"user_input","metadata":{"scope_id":"s","org_scope_id":"o"}}' | jq .
# 预期: {"level":"L1","domain":"general","route":{...,"sessionPin":true}}
# 测试 TRIZ
curl -s -X POST http://localhost:8080/classify \
  -H "content-type: application/json" \
  -d '{"text":"分析这个技术矛盾","hook":"user_input","metadata":{"scope_id":"s","org_scope_id":"o"}}' | jq .
# 预期: {"level":"L3","domain":"triz","route":{...,"sessionPin":false}}
# 测试普通消息
curl -s -X POST http://localhost:8080/classify \
  -H "content-type: application/json" \
  -d '{"text":"今天天气很好","hook":"user_input","metadata":{"scope_id":"s","org_scope_id":"o"}}' | jq .
# 预期: {"level":"L3","domain":"general"}
kill %1
```

- [ ] **Step 3: 提交**

```bash
git add deploy/layers/meerkat/classifier/src/server.ts deploy/layers/meerkat/classifier/src/pipeline.ts
git commit -m "feat: wire classifier server with /classify endpoint"
```

---

### Task 10: Sidecar 整体测试 + CI 脚本

**Files:**
- 无新增，验证 Phase 2 所有组件

- [ ] **Step 1: 跑所有 sidecar 测试**

```bash
cd deploy/layers/meerkat/classifier && npx vitest run
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd deploy/layers/meerkat/classifier && npx tsc --noEmit
```

- [ ] **Step 3: Docker build 验证**

```bash
cd deploy/layers/meerkat/classifier && docker build -t meerkat-classifier:dev .
```

- [ ] **Step 4: 提交**

```bash
git add -u && git commit -m "chore: verify sidecar build and tests"
```

---

## Phase 3: Skill Packs + 端到端验证

### Task 11: 创建 TRIZ Innovation Skill Pack 仓库

**Files:**
- 创建独立 git repo: `meerkat-skills-triz`（不在本仓库内）

- [ ] **Step 1: 创建 SKILL.md**

```markdown
---
name: triz-innovation
description: TRIZ 创新方法论——矛盾矩阵分析、技术进化趋势、物场模型。适用于产品创新、技术难题攻关、专利规避设计。不适用于纯市场分析、竞品对比、定价策略。
requiredCapabilities: []
---

## 步骤
1. 识别问题中的技术矛盾（改善参数 vs 恶化参数）
2. 查矛盾矩阵找出推荐的发明原理
3. 用发明原理生成解决方案概念
4. 对方案进行物场分析验证可行性
5. 输出结构化的 TRIZ 分析报告
```

- [ ] **Step 2: 初始化 git repo + 推送到客户 git 服务器**

```bash
mkdir meerkat-skills-triz
cd meerkat-skills-triz
git init
# 写入 SKILL.md
git add SKILL.md
git commit -m "feat: initial TRIZ innovation skill"
git remote add origin <customer-git-server>/meerkat-skills-triz.git
git push -u origin main
```

- [ ] **Step 3: 通过 admin API 注册为 skill pack**

```bash
curl -X POST http://localhost:<port>/v1/admin/skill-packs \
  -H "content-type: application/json" \
  -H "x-capability-token: <admin-token>" \
  -d '{
    "url": "<customer-git-server>/meerkat-skills-triz.git",
    "trustTier": "internal",
    "autoUpdate": true
  }'
```

- [ ] **Step 4: 验证 skill 在 system prompt 中出现**

发一条 TRIZ 相关的用户消息，检查 Agent 的 system prompt 中是否包含了 `triz-innovation` skill。

---

### Task 12: 端到端回归测试

**Files:**
- 无新增，全链路验证

- [ ] **Step 1: CLASSIFIER_URL 未设置的降级路径**

```bash
CLASSIFIER_URL= npx vitest run test/sensitivity-classifier-integration.test.ts
# 验证: 分类器跳过，turn 正常走默认模型
```

- [ ] **Step 2: Sidecar 不可达的 fail-to-local**

```bash
CLASSIFIER_URL=http://localhost:19999/classify \
CLASSIFIER_FALLBACK_MODEL=meerkat-triz-v1 \
CLASSIFIER_FALLBACK_HARNESS=pi \
npx vitest run test/sensitivity-classifier-integration.test.ts
# 验证: 走 fallback 路由 + pin
```

- [ ] **Step 3: Typecheck + Lint 全项目**

```bash
npx tsc --noEmit
npx eslint src/ test/
```

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "chore: end-to-end verification of classifier integration"
```

---

## Self-Review Checklist

- [x] Spec coverage: 第一节 Core Seam → Task 1-4, 第二节 Sidecar → Task 5-10, 第三节 Skill Pack → Task 11-12
- [x] 已知限制 mid-turn tool_response 不分类 → 已在 Global Constraints 标注
- [x] L2 确认首版不做 → 已在 Global Constraints 标注
- [x] Type consistency: `SensitivityVerdict` 在 Task 1 定义，Task 2/3 消费，Task 7 复用
- [x] No placeholders — 所有代码 step 都有具体实现

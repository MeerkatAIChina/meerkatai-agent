# qm 二开设计文档

## 概述

在 qm private fork 上实现企业级消费品行业 Agent 平台，包含三个子系统：

1. **模型路由** — 数据敏感度自动分类 + 通用模型/本地模型双轨路由
2. **业务领域包** — 消费品行业 Skills（TRIZ、产品概念、电商文案等）
3. **全插件化** — 所有二开逻辑在 `deploy/layers/<org>/` 内，核心改动 <100 行

---

## 第一节：Core Seam

### 设计原则

- 核心不感知分类逻辑。分类器是独立模块，类型和调用路径均不与 security screener 耦合
- 路由分类不受 security posture 门控（dangerous/auto/strict 均执行）
- 分类器未配置时（无 `CLASSIFIER_URL`），整个路径跳过，qm 正常运行
- 利用现有 `requested.modelId` 覆盖位和 `setRuntimeSelectionLatest` pin 机制
- 无 route 响应 = 不干预模型选择，走 org 默认解析

### 新增文件：`src/security/sensitivity-classifier.ts`

独立的类型定义 + HTTP client + 响应解析。与 `security-screener.ts` 共享 transport 形态（JSON POST → sidecar）但不共享任何解析逻辑。

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

export type SensitivityClassifier = (
  input: {
    text: string;
    scopeId: string;
    orgScopeId: string;
    hook: "user_input";
  },
  signal?: AbortSignal,
) => Promise<SensitivityVerdict | null>;
```

`SensitivityVerdict` 是独立类型——安全 verdict 和路由 verdict 是两回事。`SecurityScreenVerdict` 不动。

### 分类输入构造

用户消息本体 + 最近 3 条会话消息原文，各自截断，总上限 16k 字符（对齐现有 `MAX_SECURITY_SCREEN_CHARS`）。不做摘要——不做第二次模型调用。

### Orchestrator 集成

`src/core/orchestrator.ts` 约 +30 行：

```text
turn 开始
  │
  ├─ 1. [现有] security screener（posture 门控）
  │    输入: screenPayload(externalData)
  │    输出: SecurityScreenVerdict
  │
  ├─ 2. [NEW] 敏感度分类器（CLASSIFIER_URL 已配置时无条件执行，否则跳过）
  │    输入: { text: userMessage + 最近 3 条消息原文, scopeId, orgScopeId }
  │    输出: SensitivityVerdict | null
  │
  └─ 3. [NEW] 消费 route
      if verdict.route → input.model = verdict.route.model
      if verdict.route.sessionPin →
        setRuntimeSelectionLatest(scopeId, {
          harnessId: verdict.route.harnessId,
          modelId: verdict.route.model,
        })
      if !verdict.route → 不干预（走 org 默认）
```

### 约束与注记

1. **Pin 必须带 harnessId**。`setRuntimeSelectionLatest` 存 `{harnessId, modelId}` 对。自定义模型仅对 pi/opencode/mock harness 可用（`modelSupportedByHarness`），部署时需确保目标 harness 在 org 的 `approvedHarnesses` 列表中。
2. **Unpin 语义**。用户显式切换模型即覆盖 pin；新会话不继承 pin（pin 写在会话 scope 上）。无需额外机制。
3. **无 route = 不干预**。L3 + general 时 sidecar 不返回 `route` 字段，core 不做任何模型覆盖，走 org 默认的 `resolveRuntimeChoice`。

### 不改动的文件

- `src/security/security-posture.ts` — 不动，`SecurityScreenVerdict` 不加字段
- `src/security/security-screener.ts` — 不动，分类器独立解析
- `src/sessions/session-store.ts` — 不动，pin 复用已有 `ScopedConfigStore`
- `src/harness/harness-router.ts` — 不动，`requested.modelId` 覆盖和白名单校验已原生支持

### 部署前提

- `CLASSIFIER_URL` 环境变量指向 sidecar 地址。未设置时 orchestrator 跳过分类
- 目标 harness（默认 `pi`）必须在 org 的 `approvedHarnesses` 列表中

---

## 第二节：Sidecar 分类服务

### 部署位置

```text
deploy/layers/<org>/classifier/
  src/
    server.ts           # HTTP sidecar 入口
    pipeline.ts         # 多层级分类编排
    routes.jsonc        # 路由目标映射
    rules/
      pii.ts            # PII 正则检测
      triz_keywords.ts  # TRIZ 领域关键词
    context/
      scope_labels.ts   # scope → 默认敏感级映射
    semantic/
      classifier.ts     # 语义分类（调用独立分类模型）
  package.json
  Dockerfile
```

### API 契约

**请求** `POST /classify`：

```json
{
  "text": "用户消息本体 + 最近 3 条会话消息原文（各自截断，总上限 16k 字符）",
  "hook": "user_input",
  "metadata": {
    "scope_id": "personal:xxx",
    "org_scope_id": "org:yyy",
    "surface": "slack"
  }
}
```

**响应**（L1 示例）：

```json
{
  "level": "L1",
  "domain": "triz",
  "route": {
    "policy": "local-secure",
    "model": "meerkat-triz-v1",
    "harnessId": "pi",
    "session_pin": true
  }
}
```

**响应**（L3 + TRIZ，能力路由，无 pin）：

```json
{
  "level": "L3",
  "domain": "triz",
  "route": {
    "policy": "meerkat-triz-v1",
    "model": "meerkat-triz-v1",
    "harnessId": "pi",
    "session_pin": false
  }
}
```

**响应**（L3 + general，默认不干预）：

```json
{
  "level": "L3",
  "domain": "general"
}
```

| 字段 | 含义 | Core 行为 |
|------|------|----------|
| `level` | 隐私敏感级 L1/L2/L3 | 决定是否 pin、是否需确认 |
| `domain` | 领域命中 triz/general | 审计 |
| `route` | 可选，不存在时不干预 | 存在时消费 model/harnessId/sessionPin |
| `route.policy` | 逻辑名 | 仅进审计日志，core 不做逻辑名解析 |
| `route.model` | 已解析的具体 modelId | 直接设到 `requested.modelId` |
| `route.harnessId` | 对应 harness | pin 时写入 `setRuntimeSelectionLatest` |
| `route.session_pin` | 是否钉住会话 | 写入 scope 级 runtime selection（durable） |

路由映射在 sidecar 内完成解析，响应中 `route.model` 是具体模型 id——`resolveRuntimeChoice` 的 `modelSupportedByHarness` 和白名单校验可直接消费。

### 路由目标映射

```jsonc
// deploy/layers/<org>/classifier/routes.jsonc
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

将来本地部署了通用模型，只需改配置：

```jsonc
"local-secure": { "harnessId": "pi", "modelId": "qwen-7b", "providerId": "meerkat" }
```

### 三级分类管线

```text
用户消息
  │
  ├─ Layer 1: 规则层 (< 1ms)
  │   ├─ PII 正则：身份证 / 银行卡 / 手机号 / 邮箱 / 地址
  │   ├─ TRIZ 关键词：矛盾矩阵 / 技术进化 / 物场模型 / …
  │   └─ 命中 → 直接返回，跳过后续层
  │
  ├─ Layer 2: 上下文层 (< 1ms)
  │   ├─ scope 在白名单 → 该 scope 所有消息默认 L1/L2
  │   └─ 无标记 → 继续
  │
  └─ Layer 3: 语义层 (~500ms)
      ├─ 调用分类模型做 zero-shot 判断
      └─ 返回敏感级 + 领域命中 + 置信度
```

### 分级矩阵

隐私级 × 领域命中 = 路由决策：

| 隐私级 | 领域 | 触发条件 | policy | model | Pin | 确认 |
| ------ | ---- | -------- | ------ | ----- | --- | ---- |
| L1 | - | PII / scope 白名单 / 语义高置信 | `local-secure` | meerkat-triz-v1 | ✅ | 无 |
| L2 | - | 语义中置信 | `local-secure` | meerkat-triz-v1 | ❌ | 需确认（首版降 L1） |
| L3 | TRIZ | TRIZ 关键词 / 语义命中 | `meerkat-triz-v1` | meerkat-triz-v1 | ❌ | 无 |
| L3 | general | 默认 | 无 route | 不干预 | - | - |

关键区别：TRIZ 是**能力路由**不是隐私路由。TRIZ 命中但无敏感数据 → 直接走 TRIZ 模型，不 pin、不确认——下一条消息可能是电商文案，自动回通用模型。L3 + general 不返回 route，core 不干预模型选择。

### 降级策略

| 场景 | 行为 | 审计 |
|------|------|------|
| Sidecar 连接拒绝 | → L1, `local-secure` | `classifier.unavailable` |
| Sidecar 超时（2s） | → L1, `local-secure` | `classifier.timeout` |
| Sidecar 返回 5xx | → L1, `local-secure` | `classifier.error` |
| 语义层不可用 | → L2（有真人：确认；无真人：降 L1, `local-secure`） | `classifier.semantic_unavailable` |
| `local-secure` 也挂了 | 阻断，返回错误 | `route.unavailable` |

安全语义：**fail-to-local，不 fail-open**。分类不可用就假定最坏情况。语义层不可用选严格版（与总原则自洽），规则层无法覆盖所有 PII 变体，语义层不可用时不能默默放行。

### 无人确认 turn

| 隐私级 | 有真人 | 无真人（cron/monitor） |
|--------|--------|----------------------|
| L1 | 强制 `local-secure` | 强制 `local-secure` |
| L2 | 挂起等确认 | 降级 L1, `local-secure` |
| L3 + TRIZ | `meerkat-triz-v1` | `meerkat-triz-v1` |
| L3 + general | 通用模型 | 通用模型 |

### L2 确认交互

首版不做——L2 遇无人确认降级 L1，遇真人场景暂降 L1。后续独立工作项对标 ToolApproval 的挂起→推送→恢复模式实现。

### 实现注记

- Pin 写 `setRuntimeSelectionLatest`（Postgres durable），不用内存版
- 审计记录始终同时记 `policy`（逻辑名）和 `modelId`（解析后），保证模型替换后审计无歧义

### 验收标准

| 指标 | 目标 | 方法 |
|------|------|------|
| PII 规则覆盖 | ≥ 5 类（身份证/手机号/银行卡/邮箱/地址） | 单元测试 |
| 语义层准确率 | ≥ 85% | 50-100 条标注样本 |
| 语义层时延 | P95 ≤ 500ms | 压测 |
| 分类器整体可用率 | ≥ 99.5% | 运维监控 |

若 Meerkat-TRIZ-v1 做语义分类不达标 → 换独立分类模型（如 Qwen-7B / BGE-reranker）。

---

## 第三节：业务领域 Skill Pack

### 机制

- 导入 API：`/v1/admin/skill-packs`（admin 鉴权），含注册/列表/catalog 预览/导入
- 版本追踪：`pack-fetcher.ts` 带认证、ref 锁定、SSRF 防护；`updateAvailable` 检测上游更新
- 打包形态：独立 repo（按领域独立版本化）或 mono-repo（维护成本低）。初始建议独立 repo

### 领域包清单

| Skill 名 | 描述 | 触发场景 / 不适用 |
|----------|------|------------------|
| `triz-innovation` | TRIZ 矛盾矩阵分析、技术进化趋势、物场模型 | 产品创新攻关；不适用于纯市场分析 |
| `product-concept` | 消费品概念生成与验证框架 | 新品立项、概念测试；不适用于已有产品改款 |
| `market-valuation` | 市场规模估算、商业价值 TAM/SAM/SOM | 机会评估；不适用于已上市产品销售预测 |
| `selling-points` | 产品卖点提炼、FAB 矩阵、包装文案 | 营销策划、详情页；不适用于技术白皮书 |
| `ecommerce-copy` | 电商文案（详情页/主图/短视频脚本） | 电商运营；不适用于品牌战略文档 |
| `product-opportunity` | 消费者痛点分析、品类机会挖掘 | 品类战略；不适用于已确定 roadmap 执行 |

### Skill 模板

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

### 关键约束

- **零 capability**：领域包只是方法论大纲 + 参考数据，`requiredCapabilities: []`
- **最低 trust tier**：`internal`，无外部依赖
- **Description 写作规范**：必须含触发场景 + 反例（"不适用于 xxx"），因为 Agent 在 system prompt 的 skill index 中只能看到 description 这一行

### 验收标准

| 指标 | 目标 | 方法 |
|------|------|------|
| 命中准确率 | ≥ 90% | 每个领域 30-50 条（含正例+负例），负例 = 像但不该命中的问法 |
| 误命中率 | 0 | 负例中任何一个被误命中即为不通过 |
| 未命中率 | ≤ 5% | 正例漏掉（Agent 没读 skill）的比例 |
| Pin 会话端到端 | 通过 | L1 会话中用 `meerkat-triz-v1` 完整跑通 `triz-innovation` 五步流程 |

最后一条是关键约束：TRIZ 微调模型的指令遵循能力可能扛不住复杂 SKILL.md。如果跑不通，降低步骤复杂度，不要假设本地模型和通用模型能力相当。

### 与分类路由的联动

- L1 会话 pin 到 `local-secure` 后，Agent 仍然看到完整的 skill index
- 用户问 TRIZ → Agent 读 `triz-innovation/SKILL.md`，本地模型按步骤执行
- 若本地模型执行质量不达标：降低 skill 复杂度，或在 `routes.jsonc` 中换更强本地模型

---

## 已知限制

1. **mid-turn tool_response 不分类**。分类仅在 turn 开始的 `user_input` 执行。Agent 中途调工具获取的敏感数据（查订单库、读内部文档）不经过分类器，直接进入模型上下文。涉及的数据出口：
   - Agent 查询了含敏感字段的工具输出，内容被注入后续 prompt
   - 文件下载、数据库查询结果直接作为 tool_result 传给模型
   首版不做 mid-turn 分类。缓解措施：scope 白名单覆盖高敏感项目/频道的所有 turn；后续版本可复用 screener 的 `tool_response` hook trigger（security-screener.ts:8），在 tool_result 被注入模型前触发二次分类。

2. **L2 确认交互首版不做**。有真人场景下 L2 也暂时降级 L1，后续独立工作项。

3. **分类器语义层依赖 TRIZ 模型质量**。Meerkat-TRIZ-v1 是领域微调模型，zero-shot 通用判别能力可能退化。验收标准中已包含回退方案（换独立分类模型）。

---

## 测试计划

### 单元测试

| 测试目标 | 文件 | 覆盖内容 |
|---------|------|---------|
| `SensitivityVerdict` 解析 | `test/sensitivity-classifier.test.ts` | 合法响应、缺少字段、level 非法值、route 可选 |
| PII 正则 | `deploy/layers/<org>/classifier/tests/pii.test.ts` | 5 类 PII 命中/漏检，边界值 |
| 管线编排 | `deploy/layers/<org>/classifier/tests/pipeline.test.ts` | 规则层早停、上下文层判断、降级路径 |

### 集成测试

| 测试目标 | 覆盖内容 |
|---------|---------|
| orchestrator 消费 route | 起假 sidecar → 发 turn → 断言 `input.model` 被覆盖（参照 `test/custom-provider-e2e.test.ts` 的 fake server 模式） |
| fail-to-local 三分支 | Sidecar 拒绝/超时/5xx → 断言走 `local-secure` |
| CLASSIFIER_URL 未设置 | 断言跳过分类，turn 正常执行 |
| Pin 写入/解除 | L1 turn → 断言 `setRuntimeSelectionLatest` 被调用；用户手工切模型 → 断言覆盖 |

---

## 全局约束

1. **所有二开逻辑在 `deploy/layers/<org>/` 下**，核心仅新增 `sensitivity-classifier.ts` + orchestrator 调用点（<100 行）
2. **版本可随上游升级**：核心改动是纯新增模块，不修改现有文件的核心逻辑；合并冲突概率极低
3. **L2 确认交互首版不做**，后续独立工作项
4. **mid-turn tool_response 分类首版不做**，见已知限制
5. **Meerkat-TRIZ-v1** 通过 Admin API 注册为 Custom Provider（OpenAI 兼容协议）
6. **分类器语义层可用率**列为运维监控指标

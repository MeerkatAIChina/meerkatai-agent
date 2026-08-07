# Architecture Decision Record（架构决策记录）

> 版本：v1.0（数据分级模型路由 + 消费品行业领域 Skills 包）
> 设计依据：[设计文档.md](./设计文档.md)；调研依据：[需求调研.md](./需求调研.md)
> 每条 ADR 记录一个关键取舍：背景 → 决策 → 被否决方案及原因 → 后果。

---

## ADR-001：Meerkat-TRIZ-v1 以 Custom Provider 接入，零内核改动

- **状态**：已接受
- **背景**：平台需要同时运行通用大模型和本地自训练模型 Meerkat-TRIZ-v1。
- **决策**：用 vLLM / Ollama 将 Meerkat-TRIZ-v1 以 OpenAI-compatible 端点暴露在内网，通过 qm 管理后台（`/v1/admin/custom-providers`）注册为自定义 provider。
- **理由**：qm 的 custom provider 机制（`src/model/custom-providers.ts`）原生支持 OpenAI/Anthropic 兼容协议的第三方端点，注册后与内置模型同等进入目录与被调用，密钥走加密存储。
- **被否决**：修改内核模型注册表（`src/model/pi-models.ts`）内置该模型 —— 污染 core，破坏跟随上游升级。
- **后果**：模型接入是纯运维配置；注意自定义模型仅对 pi/opencode/mock harness 可用，部署时须将对应 harness 加入 org 的 `approvedHarnesses`。

## ADR-002：敏感度分类采用「sidecar 服务 + 内核极小 seam」，而非纯插件或内核规则引擎

- **状态**：已接受
- **背景**：模型路由需按数据敏感度（L1/L2/L3）决策，但 qm 内核没有暴露任何「turn 开始前干预模型选择」的钩子。
- **决策**：分类逻辑全部放在 `deploy/layers/<org>/classifier/`（独立 HTTP sidecar，fork 私有）；内核只新增 `src/security/sensitivity-classifier.ts`（独立 client + 解析）和 orchestrator 的一个调用点，核心改动 <100 行、纯新增。该 seam 设计为通用能力，后续走 `upstream-pr` 回馈上游。
- **被否决**：
  - 分类器放 `sandbox/tools/`（方案 A 原稿）—— sandbox 工具由 Agent 在 turn 内调用，时序上模型已选定、数据已出站，无法做 pre-turn 路由；
  - 声明式路由规则引擎进内核（方案 C）—— 内核改动最大（~200 行），规则表达力有限，且配置即行为的灵活性可以改由 sidecar 内的 `routes.jsonc` 获得；
  - 纯插件零内核改动 —— 经调研不存在这样的挂载点，承诺零改动不现实。
- **后果**：fork 需维护 <100 行内核差异，上游 merge 冲突概率低；`upstream-pr` 被接受后差异归零。

## ADR-003：分类器独立于 security screener，不共用 payload 与解析

- **状态**：已接受
- **背景**：初版方案拟「搭车」 security screener 管道（复用其 payload 构造与 verdict 传输）。
- **决策**：分类器是独立模块，独立类型 `SensitivityVerdict`、独立调用、独立解析；`SecurityScreenVerdict`、`security-screener.ts` 均不改动。仅共享 transport 形态（JSON POST → HTTP sidecar）。
- **理由**（调研发现的三个硬性不兼容）：
  1. screener 的 `securityScreenPayload` 只收集不可信外部数据，**不含用户本人消息**——而敏感度分级的首要对象恰是用户消息；
  2. screener 受 security posture 门控（`dangerous`/`strict` 姿态下 `inboundScreening: "off"`），搭车会导致最严格姿态下反而没有路由；
  3. screener 的 `score >= threshold → decision:"strict"` 语义会把高敏感正常消息误判为「恶意输入」并触发 quarantine 语义与审计。
- **后果**：核心多一个新增文件，但语义干净、审计不混淆；两条管道各自独立演进。

## ADR-004：路由消费复用 `requested` 覆盖位与 `setRuntimeSelectionLatest`，不动 harness-router 与 session-store

- **状态**：已接受
- **决策**：orchestrator 消费 `verdict.route` 时成对覆盖 `input.harness` + `input.model`（走 `resolveRuntimeChoice` 已有的 requested 覆盖位，免费获得白名单校验）；session pin 复用 durable 的 `setRuntimeSelectionLatest(scopeId, {harnessId, modelId})`，router 下个 turn 自动读取。
- **理由**：这两个机制是现成的收口点，复用后 `harness-router.ts`、`session-store.ts` 零改动；pin 与「用户手动切模型」天然同槽位，unpin 语义无需新机制。
- **被否决**：给 session-store 新增 `setPinnedModel` 字段 —— 重复造已有能力，且内存态 pin 违反 durable-by-default（蓝绿多实例会被部署冲掉）。
- **后果**：harness 与 model 必须成对覆盖，否则 org 默认 harness 为 claude/codex 时自定义模型校验失败、turn 抛错（spec 已写明）。

## ADR-005：隐私路由 × 能力路由二维拆分；逻辑名解析在 sidecar，L3+general 不干预

- **状态**：已接受
- **背景**：初版分级矩阵把「TRIZ 话题路由」和「隐私路由」混为一谈，TRIZ 命中被标 L2 需确认；且路由目标硬编码 TRIZ 模型。
- **决策**：
  - 矩阵拆为「隐私级（L1/L2/L3，决定能否出内网）× 领域命中（triz/general，决定谁回答更好）」两维；TRIZ 命中不 pin、不确认；
  - sidecar 响应的 `route.model` 携带**解析后的具体 modelId**，逻辑名（如 `local-secure`）仅进审计；`routes.jsonc` 映射在 sidecar 内，将来换本地模型只改配置；
  - L3+general 时响应**不返回 route 字段**，core 不干预，走 org 默认解析。
- **被否决**：core 侧做逻辑名解析 —— 会让 core 感知业务策略，且 sidecar 不可用时 core 的 fallback 无法依赖逻辑名（见 ADR-006）。
- **后果**：PII 类 L1 问题由「本地安全模型」而非「TRIZ 领域模型」回答，两者当前恰好是同一模型，配置层已预留分离路径。

## ADR-006：降级语义 fail-to-local，core 持独立兜底配置

- **状态**：已接受
- **决策**：sidecar 不可达 / 超时（2s）/ 5xx → core 按 `CLASSIFIER_FALLBACK_MODEL` + `CLASSIFIER_FALLBACK_HARNESS`（具体值，非逻辑名）路由 + pin；语义层单独不可用时按 L2 处理（严格版）；`local-secure` 也不可用则阻断 turn。分类不可用即假定最坏情况，不 fail-open。
- **理由**：隐私场景的合理默认是「宁可错杀」；语义层不可用若默默放行（只用规则层结果），regex 未覆盖的敏感内容会出站，与总原则矛盾。
- **后果**：sidecar 宕机期间大部分流量涌向本地模型，需容量预案；分类器可用率 ≥99.5% 列为运维监控指标；建议启动期校验：配了 `CLASSIFIER_URL` 就强制要求 FALLBACK 对存在。

## ADR-007：领域包采用 git skill-pack 导入，零 capability + internal trust tier

- **状态**：已接受
- **决策**：每个业务领域一个独立 git repo（SKILL.md + 参考数据），通过 `/v1/admin/skill-packs` 导入，`ref` 锁定版本、`updateAvailable` 感知更新；所有领域包 `requiredCapabilities: []`、`trustTier: "internal"`。
- **被否决**：放进 `skills-seed/`（属 core，污染上游）或 `plugins/*/skills/`（同属 core）；直接放 `deploy/layers/<org>/skills/` 亦可行（boot 时 upsert），但 skill-pack 提供版本化与更新检测，更适合需要持续迭代的业务知识。
- **后果**：领域知识是业务方资产，需业务侧后期单独提供内容与验收语料（每领域 30-50 条正负例）；命中质量依赖 description 写作规范（触发场景 + 反例）。

## ADR-008：首版范围裁剪——L2 确认交互与 mid-turn tool_response 分类不做

- **状态**：已接受
- **决策**：首版中，L2 一律降级按 L1 处理（含真人场景）；分类仅在 turn 开始的 `user_input` 执行，turn 中途工具返回的敏感数据不经分类。
- **理由**：L2 的「挂起 → 推送确认 → 恢复」交互是工作量最大的单项，对标 ToolApproval 模式另立工作项；mid-turn 分类涉及 harness 上下文切换，复杂度高。
- **后果（已声明的风险）**：Agent 中途经工具获取的敏感数据可能进入通用模型上下文。缓解：scope 白名单把高敏感项目/频道的所有 turn 强制钉在本地模型。后续版本可复用 screener 的 `tool_response` hook 在 tool_result 注入模型前做二次分类。

# Architecture Decision Record（架构决策记录）

> 版本：v0.1.2
> 需求依据：[需求描述.md](./需求描述.md)
> 每条 ADR 记录一个关键取舍：背景 → 决策 → 被否决方案及原因 → 后果。

---

## ADR-001：配置 git 代理后 skill pack 抓取跳过本地 DNS 公网校验——fake-ip 模式下由代理远端解析

- **状态**：已接受（issue #7-B，commit `4742007`）
- **背景**：v0.1 ADR-008 引入了 `SKILL_PACK_GIT_PROXY` 管理员显式代理开关，但 `validateRepoUrl`（`src/skills/pack-fetcher.ts`）的 SSRF 防护仍在本机解析目标主机并拒绝解析到私网地址的仓库。Clash 等代理的 fake-ip 模式下，本机 DNS 对所有域名返回 `198.18.0.0/15` 段的假 IP（属私网段），导致「配了代理反而必报 must resolve to a public network address」，代理配置形同虚设。
- **决策**：`validateRepoUrl` 在收到 `gitProxy` 时提前返回代理 git 配置（`followRedirects:false` + `http.proxy`），**跳过本地 DNS 解析与公网地址校验**——配了代理后 DNS 由代理软件在远端解析，本地解析结果根本不会被使用。无代理路径行为逐字节不变：本地解析 → 私网拒绝 → `curloptResolve` 钉住已验证地址 → 显式禁用环境代理。
- **理由**：本地 DNS 校验的防护前提是「流量按本地解析结果直连」；代理路径下该前提不成立，检查既不防护任何东西又误杀合法场景。威胁模型不变：代理本身是管理员显式配置的受信出口（v0.1 ADR-008 的既有前提），URL 仍强制 https、禁内嵌凭据。
- **被否决**：
  - 保留本地校验、仅放行 fake-ip 段（`198.18.0.0/15`）—— 把特定代理软件的实现细节写进内核安全校验，且不同代理的 fake-ip 段并不统一；
  - 仅对「解析失败」放行重试 —— fake-ip 不是解析失败，是解析出私网地址，连标都治不了。
- **后果**：内核缝改动（`src/skills/pack-fetcher.ts`，净 +5/-10 行，尾部三元分支随提前返回消除）；配置代理的管理员需自行保证代理出口可信（与 v0.1 ADR-008 前提一致）；跨平台回归测试把守（`test/pack-fetcher.test.ts`：代理配置下本地 lookup 不被调用、无代理时私网拒绝不变）。

## ADR-002：SQLite 会话存储打开时清空死租约——单实例语义下，落盘租约不能跨进程生死存活

- **状态**：已接受（issue #5，commit `97826a8`）
- **背景**：`sqlite-session-store` 把 turn 租约持久化到 `session_leases` 表，租约 TTL 5 分钟。桌面 core 是单实例：进程在 turn 中途死亡（设置保存重启、看门狗拉起、崩溃、强杀）时，内存里的 turn 没了，盘上的租约却要活到 TTL 期满——期间该会话所有新 turn 被拒为 "session busy"，**重启应用也一样**，用户视角是聊天无故卡死 5 分钟。
- **决策**：存储打开（构造）时执行一次 `DELETE FROM session_leases`（`src/sessions/sqlite-session-store.ts:225`）。依据是不变量：「刚打开数据库的进程不可能持有任何合法租约」——租约是进程内 turn 的附属物，进程死了租约必死。Postgres 存储（多实例、蓝绿部署）不动，因为那里「另一个实例可能合法持有租约」，不变量不成立。
- **理由**：修复落在所有路径流经的共享层（存储构造），而不是某个调用点重试；改动 3 行、纯新增，对上游语义是启动期一次性清理，merge 冲突概率低。安全性由不变量本身保证，不需要识别「哪些租约是死的」这种不可能做对的事。
- **被否决**：
  - 前端/路由层对 "session busy" 做等待重试 —— 把内核语义错误推给每个调用方各自兜底，且用户仍要等满 TTL；
  - 缩短 TTL 或用心跳续租 —— 治标，崩溃与 TTL 的竞态窗口仍在；
  - 租约表加进程指纹列、启动时按指纹清 —— 等价于全清（单实例下旧指纹必死），多一个字段多一份复杂度。
- **后果**：桌面版进程重启后会话立即可用，不再有人工感知的卡死窗；回归测试把守（`test/sqlite-session-store.test.ts`：模拟 kill-during-turn 后重开），另有桌面活体验证脚本 `deploy/layers/meerkat/desktop/scripts/verify-issue5.ts`（双进程 plant/retry，修复前复现 403 session busy、修复后 PASS）。多实例部署若将来改用 SQLite 后端，须重新评估本决策（不变量依赖单实例前提）。

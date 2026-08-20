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

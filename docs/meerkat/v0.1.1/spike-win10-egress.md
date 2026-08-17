# Spike：Win10 WSL2 出网围栏可行性

> 日期：2026-08-17。环境：Windows 10 22H2（build 19045）+ WSL2（Ubuntu-22.04）。
> 门控：设计文档第五节 / 执行计划 Task 0。结论决定 Task 10-11 的形状。

## 结论（先说答案）

**宿主机防火墙这条路不需要了。** spike 发现一个更优形状：**围栏全部做在 guest 内部**（iptables + 权限分离 + guest 内代理），内核级强制、Win10/Win11 行为完全一致、零宿主机配置、零额外 UAC。

原计划的"宿主机 WFP/防火墙拦死 WSL2 直连"不仅未经验证，而且**已被取代**——不是"拦不死所以降级"，而是"不需要拦，有更干净的位置"。

## 实测记录

### 基线

guest 直连公网：`curl https://example.com` → 200（NAT 直连通畅）。

### 实验一：guest iptables 基础围栏

规则：`OUTPUT 默认 DROP` + 放行 lo + ESTABLISHED,RELATED + 指定 IP:port。

| 用例 | 结果 |
|---|---|
| root 直连未放行地址 | ✅ 超时（DROP 生效） |
| root 访问放行的 IP:443 | ✅ 200（选择性放行生效） |
| DNS 解析（UDP/53） | ✅ 被拦（域名解析收归代理层，符合设计） |
| 非 root 直连 | ✅ 同样被拦（内核强制，与用户无关） |
| 非 root `iptables -F` | ✅ Permission denied（规则不可被非 root 清除） |

### 实验二：完整链路（代理在 guest 内 + 权限分离）

形状：CONNECT 代理以 root 跑在 guest 的 127.0.0.1:18080（白名单只含 example.com）；iptables 放行 lo + ESTABLISHED + **`-m owner --uid-owner 0`（root 全权出网）**；用户脚本以 nobody（uid 65534）执行。

| 用例 | 结果 |
|---|---|
| nobody 经代理访问白名单域名 | ✅ **200** |
| nobody 经代理访问白名单外域名 | ✅ 403（代理拦截） |
| nobody 绕过代理直连 | ✅ 超时（iptables DROP） |
| nobody 清 iptables | ✅ Permission denied |
| nobody 杀代理进程 | ✅ Operation not permitted |

注：实验二第一轮失败过一次——代理（root）自己的出网也被 DROP 拦了，补 `-m owner --uid-owner 0 -j ACCEPT` 后通过。这条规则的安全性成立：root 进程只有 agent 与代理两个**我们发布的可信代码**，模型生成的脚本永远以非 root 运行。

## 对设计与计划的修订建议

1. **代理位置**：core 宿主机 → **guest 内**（backend 拉起 agent 时以 root 同机拉起，监听 127.0.0.1）。白名单由 backend 在拉起时注入。消灭三个原计划问题：guest→宿主机的网关可达性、Windows 防火墙入站弹窗、代理 bind 0.0.0.0 的暴露面
2. **权限分离成为围栏的一部分**：agent.mjs 新增 env 可选开关（如 `AGENT_RUN_USER=sandbox`），exec 的用户脚本经 `setpriv` 降权为非 root。rootfs 内置 `sandbox` 用户。纪律与 AGENT_AUTH_TOKEN 一致：env 可选、默认关闭、其他后端行为不变。**没有这个，iptables 可被 root 脚本 flush，围栏不成立**
3. **Task 11（宿主机围栏分层）取消**：Win10/Win11 差异不复存在；宿主机防火墙留作可选纵深（二期再评估，非必需）
4. **无网络档 fallback 保留**：若 guest 内核缺 iptables 模块（极老 WSL 内核），降级无网络档——实测本机 WSL2 内核（Ubuntu-22.04 默认）iptables/nft 正常
5. 估算变化：Task 10-11 原估 3-5 人日（含宿主机围栏不确定性）→ 约 2-3 人日（代理已有现成实现骨架，围栏是两条 iptables 规则 + agent 一个 env 开关）

## 未覆盖项（明确记录）

- Win11 的 Hyper-V 防火墙集成路径未实测（本机是 Win10）——**已无需实测**，guest 内层方案与宿主机 OS 无关
- 宿主纵深防御（Win11 firewall=true + Hyper-V 规则）作为可选二期项记录，不进 v0.1.1

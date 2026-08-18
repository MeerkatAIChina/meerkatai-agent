# Architecture Decision Record（架构决策记录）

> 版本：v0.1.1（桌面沙箱——WSL2 后端 + guest 内出网围栏）
> 设计依据：[设计文档.md](./设计文档.md)；调研依据：[需求调研.md](./需求调研.md)；spike 实测：[spike-win10-egress.md](./spike-win10-egress.md)
> 每条 ADR 记录一个关键取舍：背景 → 决策 → 被否决方案及原因 → 后果。

---

## ADR-001：沙箱出网否决「默认放行公网」——domain 白名单，且围栏全部落在 guest 内

- **状态**：已接受
- **背景**：qm 的 `egressEnforcement` 有 none / ip_port / domain 三档。桌面沙箱首版选哪档是产品决策：放行公网体验最好（模型现场 pip/npm install、拉资料都能用），但 Meerkat 是隐私产品，「模型生成的代码在沙箱里能随意外发」与隐私承诺链直接冲突。
- **决策**：出网走 domain 白名单档。白名单内置常用源（pypi.org、files.pythonhosted.org、registry.npmjs.org、registry.npmmirror.com、github.com、objects.githubusercontent.com、mirrors.aliyun.com），种子文件 `seeds/sandbox-egress.json` 随包，core 经 `SANDBOX_EGRESS_PATH` 注入。围栏实现全部在 guest 内：guest 内跑一个 root 持有的 CONNECT 代理（只监听 loopback），agent 以普通用户执行命令时注入 `HTTP_PROXY` 指向它；iptables 用 `-m owner --uid-owner 0` 只放行 root（代理本身），普通用户直连出网 DROP。
- **理由**（spike 实测，五项全绿）：白名单内 200、白名单外代理 403、`unset HTTP_PROXY` 绕过被 DROP、清规则后拒、杀代理后拒。围栏在 guest 内意味着宿主 Windows 防火墙零改动、零额外提权。
- **被否决**：
  - 默认放行公网 —— 与隐私承诺链冲突，此 ADR 用于防回退；
  - 首版无网络 —— 「现场装依赖」这类典型 agent 行为直接失败，实用性打折；
  - 宿主侧防火墙围栏 —— spike 阶段的原案，实测证明 guest 内方案足够且更简单，取消。
- **后果**：沙箱内访问白名单外域名会得到代理 403，报错信息可读；白名单调整 = 改种子文件重打包，或运行时改配置。代理是单点——杀代理 = 全断网（fail-closed，符合隐私语义）。

## ADR-002：guest agent 增加 bearer token 与权限分离——内核缝改动，env 可选、默认关闭

- **状态**：已接受
- **背景**：WSL2 后端复用 qm 的 microvm agent 协议（`agent.mjs` HTTP），但桌面场景下 agent 监听在 WSL localhost 转发口上，同机其他进程理论上可直达；且 guest 内执行需要「root 管家通道 + 普通用户业务通道」的权限分离（出网围栏依赖 iptables owner-match，业务进程必须是普通用户）。
- **决策**：给 `agent.mjs` 加两个 env 可选开关，默认全部关闭、行为与上游逐字节一致：
  - `AGENT_AUTH_TOKEN`：设置后每个请求校验 bearer token；core 侧每次启动生成一次性随机 token，经 WSLENV 传入 guest，不落盘；
  - `AGENT_RUN_USER`：设置后 `/exec` 默认以该用户执行，`root: true` 显式请求才走 root 管家通道（`/write` 落盘后 chown 给业务用户，`run` 内 export HOME）。
- **理由**：对齐 v0.1 三处内核缝先例（ADR-007/008/009 同款纪律）——改动是纯新增、env 可选、默认关闭，上游 merge 冲突概率低，且具备回馈上游的通用性。
- **被否决**：桌面私有 fork 一份 agent.mjs —— 双胞胎漂移；现状是孪生副本 `cli/templates/aws/microvm-agent/agent.mjs` 必须同步修改，有逐字节一致性测试（`cli/test/microvm-dockerfile.test.ts`）把守。
- **后果**：非桌面部署（aws/local 后端）零行为变化；token 每启动轮换，重启即失效。

## ADR-003：沙箱底座选 WSL2 + guest agent 传输层，否决 wsl.exe 薄传输与 Firecracker 自研

- **状态**：已接受
- **背景**：技术组长提出的方向是 Kata Containers + Firecracker 自研沙箱后端。桌面 Windows 交付场景需要一个「用户机器上大概率已有或可一键启用」的虚拟化底座。
- **决策**：
  - 底座 = WSL2（Windows 10 build 19044+/21H2 起支持，设置页一键 UAC 启用）；macOS 本期落 `none` 后端降级（设计双平台、实现只做 Windows）；
  - 传输层 = guest agent（复用 `agent.mjs` HTTP 协议，与 aws/local 后端同构，辅助层全套复用）；agent 生命周期为 **core 持有的常驻 wsl.exe 子进程**（detached 的 setsid/nohup 进程会被 WSL 会话杀掉，实测踩过）；
  - rootfs = 定制精简 Debian + Node + agent.mjs（约 148MB tar.gz）随包内置，指纹变更时重导，**重导前必须备份 /home**（失败即中止更新，不丢用户 workspace）。
- **理由**（POSIX 契约证据链）：qm 沙箱的 exec/fs 契约整体假设 POSIX 语义（shell、信号、文件权限）；WSL2 提供真 Linux 内核，契约成立有实测支撑（E2E 11/11：`scripts/test-wsl2-e2e.ts`）。
- **被否决**：
  - wsl.exe 薄传输（`wsl.exe` 直接当 exec 原语 + `\\wsl$\` 文件 IO）—— 无 guest 进程最省，但杀进程、二进制边界、冷启动延迟等边缘问题要自扛；
  - 混合通道（exec 走 agent、大文件走 `\\wsl$\`）—— 双通道一致性复杂，理论最优但首版不值；
  - Kata + Firecracker 自研 —— 要求用户机器装特定虚拟化栈，交付摩擦与自研维护成本都远超首版收益；其「薄适配层对接 qm 沙箱接口」的思路被保留——WSL2 后端本身就是按这个思路做的。
- **后果**：沙箱可用性依赖客户机器的 WSL2 可达性（虚拟化开启、build ≥ 19044）；不支持时降级为 `none`，对话/路由完整、execute 工具报清晰错误。macOS 沙箱留待后续版本。

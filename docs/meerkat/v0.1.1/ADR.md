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

## ADR-004：锁重指仅限本地隐私模型——服务端强制，web-ui 桌面层收口

- **状态**：已接受（验收期修复，提交 `bcb833a`）
- **背景**：锁管理页（`/admin/locks`）的「重指」首版把 `/api/runtime-config` 的全量模型（含 tensoris 通用模型）列入下拉，还提供自由文本输入。用户验收时发现可把 L1 锁定会话重指到通用云模型——锁的语义是「该会话永不回通用模型」，这等于提供了一个绕过隐私防线的正式入口，是安全漏洞而非体验问题。
- **决策**：重指目标的合法性在 **web-ui 服务端强制校验**（`PUT /api/locks/:sessionId`）：目标必须命中 `local-secure` provider 种子配置的模型列表（`localRetargetModels()`），否则 400 `retarget_not_local`。`GET /api/locks` 响应附带 `retargetModels` 字段，管理页下拉只渲染该列表，删除自由文本输入；列表为空时下拉与重指按钮禁用。
- **理由**：校验放服务端是因为 UI 过滤可被绕过（直接调 API）；放 web-ui 桌面层而非 core，是因为「哪个 provider 是本地隐私模型」是桌面交付的部署知识（seeds/`providers.local-secure.json`），core 内核不感知隐私分级，改动保持 DESKTOP 门控、不触内核。
- **被否决**：
  - 仅前端收敛下拉 —— 直接调 API 即可绕过，不构成防线；
  - core 侧加模型隐私分级 —— 内核需新增概念，桌面单机场景收益不抵复杂度。
- **后果**：「解除锁定」成为唯一让锁定会话离开本地模型的途径，且有确认警告；本地模型升级/更名后的标准操作是更新 seeds 里的 `providers.local-secure.json` 再重指。同城双本地模型（如将来 TRIZ 与隐私模型分开部署）时，把两个 provider 的模型都加入 `localRetargetModels()` 即可，语义不变。

## ADR-005：skills 目录的 read 结果豁免注入筛查——可信签名内容不进检测器

- **状态**：已接受（验收期修复，issue #3）
- **背景**：auto 安全姿态下所有工具结果过注入筛查（`screenToolResult`）。skill 的本质是「通过文件读取消递给 agent 的指令」，与注入攻击「外部文本嵌着指挥 agent 的指令」结构同构，检测器无法区分——用户验收时 hello skill 被隔离（`[tool output quarantined by Auto security posture]`），skill 机制实质性失效。而 qm 的 skill 创建链路本就有签名 + 审批（skills 表 `signature`/`approvals`），可信内容被当不可信输入再查一遍，是信任边界错位。
- **决策**：`pi-tools.ts` 的 `recordResult` 既有 `screenExempt` 通道上新增 `isSkillRead(summary)` 豁免：`tool === "read"` 且归一化路径以 `skills/` 开头即跳过注入筛查。路径前缀对齐 skill materialize 的落盘约定（`SKILLS_DIR = "skills"`，`src/skills/materialization-paths.ts`）。
- **理由**：注入防线的目标是**外部**不可信内容（网页、附件、工具返回的第三方数据）；skill 是用户/部署方签名审批的一等可信内容，豁免不削弱防线。路径判据足够：`skills/` 目录由 materializer 管理，agent 自己写入该目录再读回的内容派生自已筛查的模型输出，不构成新注入面。
- **被否决**：
  - 调宽筛查提示词让检测器「认出 skill」—— 小模型判定不稳定，且每次读取都花一次筛查调用；
  - skill 内容直接进系统提示词不落地文件 —— 改动面大，上游 materialize 机制就是按文件读取设计的。
- **后果**：内核缝改动（`src/harness/pi-tools.ts`，+7 行），对上游语义是纯新增豁免分支；有测试把守（`test/pi-tools.test.ts`：skill 读取零筛查调用、不隔离、内容完整到达模型）。

## ADR-006：桌面版辅助调用整体走本地模型——复用上游 PI_*_MODEL 环境缝，零内核改动

- **状态**：已接受（验收期修复，issue #2 + #4）
- **背景**：会话锁只覆写主对话模型，辅助调用（标题生成、安全筛查、detect、judge）走 `auxiliaryModelFor(orgBaseModelId())`，桌面版即云端 gpt-5.4-nano。两处实证：标题生成携带 L1 原文出网（#2）；锁定会话的工具结果送云端做注入筛查（#4，session_llm_requests 表 step=-1 记录实证）。且泄露不限于锁定会话——任何会话的工具结果都会出网过筛查。
- **决策**：桌面壳 `proc.rs` 启动 core 时，当本地模型已配置（`read_local_model` 命中），注入 `PI_DETECT_MODEL` / `PI_TITLE_MODEL` / `PI_JUDGE_MODEL` = 本地模型 ID。这是上游原生配置缝（`config.ts:787-789` → `piHarnessConfigOptions` → harness 的 `detectModelId/titleModelId/judgeModelId` 覆盖），**零内核改动**。本地模型未配置时维持原行为（fallback 到 org 基础模型）。
- **理由**：隐私产品的桌面交付里，所有幕后模型调用都应留在本地——辅助调用处理的内容（会话原文、工具结果）与主对话同等敏感。上游已留好缝，不值得为此发明新机制。
- **被否决**：
  - 逐调用点改造（orchestrator 查锁再决定辅助模型）—— 锁感知逻辑侵入多条路径，而桌面版「全部辅助调用本地化」语义更简单更强；
  - 筛查改走分类器 sidecar —— 分类器是隐私分级/路由语义，不是注入检测语义，硬接会混淆两条防线；筛查本地化由 `PI_DETECT_MODEL` 已达同等效果。
- **后果**：桌面版标题、筛查、detect、judge 全部留在本地；上游与非桌面部署零行为变化。未来新增辅助调用类型时须走同一 env 缝，否则会在桌面版重新开出网口。

# Architecture Decision Record（架构决策记录）

> 版本：v0.1（桌面化交付物）
> 设计依据：[设计文档.md](./设计文档.md)；调研依据：[需求调研.md](./需求调研.md)
> 每条 ADR 记录一个关键取舍：背景 → 决策 → 被否决方案及原因 → 后果。

---

## ADR-001：会话与锁同后端——SQLite 双后端，不做"会话持久化 + 锁内存"的半套

- **状态**：已接受
- **背景**：桌面版无 Postgres，需引入 SQLite 持久化。会话锁（v0.0 的 `sessionLockStore`）与会话历史是隐私同源的两半。
- **决策**：`SessionStore` 和 `sessionLockStore`（`artifactMap("session_locks")`）必须同生同死——要么都内存、要么都 SQLite。桌面版 `SESSION_STORE=sqlite` 时两者走同一个 SQLite 文件。SQLite 用 Node 原生 `node:sqlite`（`DatabaseSync`），不引入第三方驱动。
- **理由**：若会话进了 SQLite 但锁留在内存，重启后 L1 会话的敏感历史还在磁盘上、锁却丢了。下一轮重新分类只看"新输入 + 最近 3 条历史"（16k 截断），窗口之外的旧敏感内容看不见 → 该轮路由云端 → 完整历史重放 → 泄漏。
- **被否决**：会话 SQLite + 锁内存（"先做一半"）——隐私漏洞；两者都用内存（接受重启丢会话）——违背"桌面交付物不丢数据"的产品目标。
- **后果**：SQLite 双后端（DurableMap + SessionStore）是 core 的 additive 新增；`config.ts` 需放开曾被移除的 `SESSION_STORE=sqlite` 值；Postgres 版 SessionStore 的 PG 特有 SQL 无法照搬，SQLite 版改用"对齐表结构 + 查询逻辑 JS 层过滤"。

---

## ADR-002：模型密钥走"厂商种子 + 首启令牌页 + tensoris 客户专属令牌"，真实 key 永不进包

- **状态**：已接受
- **背景**：桌面版没有 `.env` 文件编辑这一说。模型 API key 均由厂商提供（第三方中转站 tensoris），客户不自备 key。
- **决策**：安装包内置**无秘密的供应商种子**（`seeds/*.json`，只读）；首次启动用一个极简设置页（web-ui 内 `/setup` 路由）收服务令牌 + 本地模型 endpoint，先验证后入库；真实云端 key 全留在 tensoris 账号后面，桌面只持有按客户签发的令牌。
- **理由**：令牌 = 授权码，控制台直发即可计量、吊销、轮换，零新增服务端；"先验证后入库"杜绝存错令牌后对话报错；种子无秘密，安装包可一个包发所有客户（令牌装后录入，无客户差异）。
- **被否决**：用户可编辑的 providers 配置文件——对桌面用户不友好；BYOK 完整管理页——首版过度工程，留作高级折叠项。
- **后果**：需配套稳定 `CONNECTOR_SECRET_KEY`（首启生成、文件 ACL 0600，否则加密令牌重启即报废）和本机访问控制（core 只绑 127.0.0.1 + `CORE_SIGNING_SECRET` 全链签名）。

---

## ADR-003：清单式启动页 + 动态端口 + 失败分级，不做通用错误页或独立仪表盘

- **状态**：已接受
- **背景**：桌面版启动三进程是"黑盒"，失败按组件分布（端口占用、杀软拦 node、skill pack 超时、令牌失效、endpoint 不通），每种处理方式不同。
- **决策**：启动页本身即状态清单（分类器/核心服务/知识包/界面逐项点亮）；三个端口由 Rust 启动时 `TcpListener::bind("127.0.0.1:0")` 动态分配注入；失败分级——core/web-ui 致命红阻断 + 重试，classifier/skill packs/本地 endpoint 降级黄放行（classifier 宕机的黄灯语义遵循 ADR-006 fail-closed）。
- **理由**：Rust 壳本来就必须健康轮询（Tauri sidecar 标准流程），"知道每个组件起没起来"的能力天然存在；动态端口把"端口被占用"从故障清单抹掉；失败分级让降级项不堵启动（它们只在使用对应能力时阻断单条消息）。
- **被否决**：通用错误页（"启动失败请联系支持"）——把诊断成本转嫁给售后；托盘常驻——Meerkat 是窗口应用用完即关，托盘解决的是后台驻留需求，不解决启动期可诊断性；独立状态面板窗口——信息量对了但形态重，splash 本身就是清单。
- **后果**：运行期崩溃恢复（core/web-ui 死亡 → 切"服务中断"页 + 自动拉起一次）与启动清单共用同一套状态机。

---

## ADR-004：Skill packs 在线拉取为主 + 交付分发兜底，不内置

- **状态**：已接受
- **背景**：skill packs 当前从 GitHub URL 拉取导入。桌面版要兼容离线客户。
- **决策**：主通道在线拉取（首启拉取导入 SQLite 持久化，后台 `updateAvailable` 静默升级）；兜底通道知识包文件走交付渠道（交付函/U盘/实施人员），设置页提供"导入知识包"入口；企业变体内网镜像（可选，不做承诺）。
- **理由**：内置会增大安装包且更新要发新版；在线拉取 + 交付分发两通道覆盖在线/离线两类客户；知识包未导入不阻断启动（黄灯降级，TRIZ 能力退化但对话正常）。
- **被否决**：随包内置核心 skill pack——安装包膨胀 + 更新耦合发版；仅在线——离线客户能力严重受限。
- **后果**：需 core 放开受控的本地导入入口（`allowLocalRepos` 当前仅非 production 生效，桌面是 production，只放行用户显式选择的文件路径）。

---

## ADR-005：载荷裁剪"A 打底 + B 当手术刀"，第一步先实测

- **状态**：已接受
- **背景**：全量依赖 1.9GB（root 1.5GB + web-ui 366MB + classifier 47MB），需裁到 <400MB。
- **决策**：Stage 0 先实测（`npm ci --omit=dev` 看真实数字）；Stage 1 用 A（`--omit=dev --omit=optional` + 排除 pi-tui 原生预编译、emoji-datasource 原始数据等运行时不可达资源）；仅当 Stage 1 仍超标才启用 Stage 2 的 B（esbuild 对 core 单入口打 bundle，协议 md 外挂 assets）。脚本放 `deploy/layers/meerkat/desktop/scripts/`，不进 `build.rs`。
- **理由**：纯 B 的 import 图分析咽不下三个东西——`loadProtocolFile()` 运行时读盘、`pi-coding-agent` tarball 黑盒、fastify/pg 的 CJS 动态加载，漏一个就是客户机器运行时崩溃；A 保守可控，先实测数字再定策略可当场压缩工作量估算。Slack/AWS connector 不能 `rm -rf`（orchestrator 顶层静态 import，文件缺失启动崩溃）。
- **被否决**：纯 B（esbuild 全量 import 图分析）——未知未爆弹清单；`build.rs` 里跑 staging——每次 cargo build 都跑分钟级重活，拖死迭代。
- **后果**：staging 是显式执行、可缓存的独立步骤，CI per-OS matrix 各跑各的；体积是最大的工作变数，需实测迭代。

---

## ADR-006：全量更新（tauri-plugin-updater），不做壳/载荷分离更新

- **状态**：已接受
- **背景**：桌面版需要更新机制。分离更新（壳和载荷分开发版）在首版不成立。
- **决策**：v0.1 做全量更新——Tauri 壳 + Node 载荷整体发版，`tauri-plugin-updater` 检测 → 下载完整安装包 → 用户重启升级。更新源用 HTTPS 静态托管（私有 GitHub Releases 客户拿不到）。
- **理由**：分离更新的收益前提是"壳稳定、载荷周更"，首版壳和载荷都在快速修 bug、更新频率耦合，省不了几次"只更载荷"却背上两套更新逻辑 + 兼容矩阵；知识包已有自己的更新通道（在线静默 + 交付分发），载荷里值得增量的只剩 qm JS 代码，为单对象建第二通道不划算；全量更新签名/校验/重启安装全套现成，成本 1-3 人日。
- **被否决**：分离更新（B）——过度工程；纯手动下载重装——首版 bug 修复频率高，售后工单发生器。
- **后果**：更新不丢数据（SQLite、令牌、secret 全在 DATA_DIR 用户目录，覆盖安装零迁移）；离线客户手动覆盖通道必须保留，A 是给在线客户的增量便利而非替代。分离更新启动条件（壳连续 2-3 版本零变更 + 载荷周更 + 客户抱怨体积，三信号齐现）写进设计文档防拍脑袋。

---

## ADR-007：自定义供应商显式注册优先于内置同名模型（内核缝改动）

- **状态**：已接受
- **背景**：tensoris 中转站以本名代理主流模型（gpt-5.4-nano、gemini-3.1-flash-lite），而这些型号 id 在 pi-ai 的内置注册表中已存在（provider 分别为 openai / google）。上游 qm 的 `resolveModel()` 规定"内置遮蔽自定义注册"（防止自定义注册劫持内置型号的既定语义），导致注册了 tensoris 的型号仍被解析到 openai 官方 provider——无 key → 报错回退 → 对话崩溃。非内置型号（Meerkat-TRIZ-v1）不受影响，因此本地模型链路一直正常。
- **决策**：`src/model/pi-models.ts` 的 `resolveModel()` 改为**先查自定义注册表，再查内置**；`test/custom-providers.test.ts` 的碰撞断言随之反转（自定义注册在碰撞时胜出）。
- **理由**：中转站/代理网关是自定义供应商功能的主要使用场景，"显式注册却不生效"自相矛盾；能注册自定义供应商的只有 org 管理员，其本就握有重定向流量的全部权力（改 base model、设 endpoint override），碰撞胜出不构成新增安全面。
- **被否决**：① 沿用内置遮蔽 + 给型号改名（如 `tensoris/gpt-5.4-nano`）——选型 id 即上游请求里的模型名，改名会导致中转站无法识别，除非再引入"上游名映射"字段，复杂度更高；② 用 env 覆盖内置 provider 的 baseUrl（`OPENAI_BASE_URL` 指向中转站）——key 需进程启动前注入，与首启设置页热注册的流程冲突，且两个供应商（openai/google）共用一个中转站地址时 env 无法区分 key。
- **后果**：这是对上游内核不变量的有意偏离（上游测试 `built-ins shadow custom ids` 被反转），随主仓升级时若上游改动 `resolveModel()` 或该测试会产生冲突，需人工合并；此改动具备通用价值，适合通过 upstream-pr 回馈主仓以消除长期差异点。


---

## ADR-008：Skill pack 拉取的代理支持——管理员显式开关 `SKILL_PACK_GIT_PROXY`，默认直连

- **状态**：已接受
- **背景**：core 的 pack-fetcher 出于 SSRF 防护，git 克隆时清空一切代理配置并钉死 DNS（`GIT_CONFIG_GLOBAL=/dev/null` + `http.proxy=""` + `http.curloptResolve` 固定解析结果）。但国内网络环境下 GitHub 直连间歇性被干扰（实测同一 IP curl 秒通、git 超时），桌面版首启导入 skill pack 因此看运气。
- **决策**：新增环境变量 `SKILL_PACK_GIT_PROXY`（`src/config.ts` 严格解析，仅接受 http/https/socks5/socks5h URL，非法值拒绝启动）。设置后 `pack-fetcher` 的 gitConfig 改为 `http.proxy=<值>` 且**不再钉 IP**；不设置则完全维持上游行为。桌面端注入来源按优先级：OS 环境变量 > 数据目录 `network.json`（启动页可选填写，web-ui 写入，Tauri 壳重启 core 生效）。skill pack 注册 API 不接受代理参数——代理只能由本机管理员通过 env/配置文件设置，不能由 API 调用方指定。
- **理由**：代理网络在国内客户环境不可避免；默认关闭保持上游 SSRF 防护语义不变，显式开启把信任边界有意识地转移给代理本身；启动页配置让终端用户无需触碰环境变量。
- **被否决**：① seed 换国内镜像 URL（gitclone.com 等）——引入第三方镜像的供应链信任风险，且镜像站稳定性无承诺；② pack-fetcher 自动沿用系统/git 全局代理——上游刻意清空这些配置就是为了防止环境里的隐式代理绕过 DNS 钉防，静默继承等于拆防；③ 安装包内置 skill pack——违背 ADR-004 的分离原则。
- **后果**：这是对上游 core 安全边界的有意扩展（opt-in），随主仓升级时若上游改动 `validateRepoUrl`/`gitEnv` 需人工合并；此改动对任何代理网络下的部署都有通用价值，适合通过 upstream-pr 回馈主仓。开启代理后 SSRF 的 DNS 钉防失效这一点必须在客户交付文档中注明。


---

## ADR-009：会话锁增加管理员逃生门——list / retarget / release，而非"永不解锁"

- **状态**：已接受
- **背景**：v0.0 的隐私设计是会话锁单向、永不解锁。真机测试发现该设计有一个硬伤：若被锁定的模型（本地 meerkat-triz-v1）从未部署、被下线或从可选清单移除，被锁会话将**永久拒答且无任何恢复手段**——用户数据实际上被锁死。
- **决策**：core 新增一组 admin 门禁 + 审计的管理接口——`GET /v1/admin/session-locks`（列表）、`PUT /v1/admin/sessions/:id/lock`（把锁重定向到另一个已批准的可用模型，针对模型注册表校验）、`DELETE /v1/admin/sessions/:id/lock`（完全释放）。桌面版提供 `/admin/locks` 管理页（portal 鉴权、仅桌面模式），重定向有下拉选择，释放有警告确认。
- **理由**：隐私边界由"锁的存在"保障，而不是由"锁不可管理"保障——能把锁放开的人只有 org 管理员（桌面版即本机用户本人），其本就拥有全部数据；"永不解锁"在运维上等于"永不恢复"，把一次模型可用性问题放大成永久数据不可用。
- **被否决**：维持永不解锁——上述硬伤无解；自动解锁（锁模型缺失时自动回落）——静默把隐私流量改道，违背锁的初衷。
- **后果**：锁的"单向"语义从"系统强制永不解锁"修正为"用户操作不解锁、管理员显式操作可解锁"；释放动作全部落审计日志。聊天页内的 🔒 锁标识仍未做（遗留项）。

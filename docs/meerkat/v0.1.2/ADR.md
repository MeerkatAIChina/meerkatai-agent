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

## ADR-003：本地 skill 快照直读通道——以 `.skillpack-meta.json` 为标记跳过 git

- **状态**：已接受（issue #6，设计评审 2026-08-20 拍板选项 1-A）
- **背景**：issue #6 方案 A 的隐含假设「种子指向本地路径 + `local:true` 即可零新增内核缝」不成立——core fetcher（`src/skills/pack-fetcher.ts:279`）即使对本地路径也是 `git clone` 本地目录，无 git 客户机器上本地导入同样失败（客户日志的 `spawn git ENOENT` 即源于此）。快照随包内置后若首启仍依赖 git，「首启零依赖」就是空话。
- **决策**：`fetch` 与 `resolveRef` 中，当 `permitsLocal(pack)` 且路径为本地路径且存在 `.skillpack-meta.json` 时跳过 git：`fetch` 直接 `readTree` 读目录（maxFiles/maxTotalBytes 护栏不变），commit 取元数据；`resolveRef` 直接返回元数据 commit。无元数据的本地路径保持 legacy `git clone` 行为逐字节不变（meta 文件是显式 opt-in 标记，dev 流与 bare repo 场景不回归）。元数据损坏或缺 commit 字段 → 显式报错，不静默兜底。
- **理由**：直读只是把 `git clone` 换成等价的读目录，本地包的授权前提（`local:true` + `ALLOW_LOCAL_SKILL_PACKS` 受控通道）一层不少；构建期快照是纯目录，本来就不需要 git 语义。
- **信任边界**：meta 文件随包签名交付，直读仅认 meta 标记的快照目录。
- **被否决**：
  - 随包内置 portable git —— 安装包增重几十 MB，多一个要维护的组件，且只为模拟一次读目录；
  - 所有本地路径一律直读（不设 meta 标记）—— dev 流依赖本地 bare repo / 分支检出语义，一律直读会造成回归，meta 标记把新行为限定为显式 opt-in。
- **后果**：内核缝改动（`pack-fetcher.ts` 的 `fetch`/`resolveRef` 各加一个提前分支）；无 git 机器全链路不 spawn git；回归测试把守（注入必炸 `gitBin` 证明零 git 调用；meta 缺失走 legacy；meta 损坏显式报错）。

## ADR-004：`SkillPack.upstreamUrl` 双地址身份——本地快照为身份与首启源，GitHub 为更新通道

- **状态**：已接受（issue #6，设计评审 2026-08-20 拍板选项 2-A）
- **背景**：`SkillPack.url` 同时承担「身份（web-ui 按 url 匹配判重）」与「抓取源（sync 按 url 拉取）」两个职责。快照内置后 pack 以本地路径注册，`POST /sync` 对本地路径永远拉不到 GitHub 新内容，更新通道无从谈起。
- **决策**：
  1. `SkillPack` 增加 `upstreamUrl?: string` 软字段（store 基于 `DurableMap` 整条 JSON 存取，无 SQLite 迁移）：`url` 恒为本地快照路径（身份稳定），`upstreamUrl` 存 GitHub 地址；
  2. import 恒走 `url`（本地）；sync/`resolveRef` 有 `upstreamUrl` 时走 upstream，原有 https/无凭据/SSRF/代理校验逐字节不变，只是源地址字段换了；
  3. register/patch 接受 `upstreamUrl`（https、无内嵌凭据，否则 400）；patch 放开 `local` 字段并加守卫（仅 `ALLOW_LOCAL_SKILL_PACKS=1` 环境且最终 url 为本地路径才允许置 `local:true`），支撑 v0.1.1 老客户已注册 GitHub url 的 pack 原地迁移（pack id 与已导入技能保留）；
  4. sync 抓取失败时 `recordImport` 保留上一个成功 commit（现失败路径写 `commit: pack.ref` 即 `"main"`，会毁掉 `updateAvailable` 比对基准）；
  5. 桌面更新时机 = 启动单次 `POST /sync {onlyIfUpdate:true}` + 手动重同步——桌面本就没有周期 tick（`SKILL_SYNC_POLL_MS` 默认 0，`wiring.ts:1495` 仅 `>0` 时启动），不新增轮询、不新增 env。
- **理由**：一个技能包、两个来源地址是方案 A 的内在结构，把第二个地址建模为字段是最小且诚实的表达；身份与抓取源解耦后，首启与更新各自独立演化。
- **被否决**：
  - web-ui 编排「PATCH 换成 GitHub url → sync → PATCH 换回」—— 零内核改动但有真实竞态：sync 中途进程死亡，pack 停在 GitHub url 上，下次启动本地匹配直接失效，且丑陋；
  - v0.1.2 砍掉在线更新通道（技能更新 = 下一个安装包）—— 违背 issue「GitHub 降级为更新通道」的既定语义。
- **后果**：`skill-pack-store.ts` / `skill-packs.ts`（routes）/ `app-skills.ts` / `skill-sync-engine.ts` 四处小改；upstream 抓取安全语义不变；测试把守（`onlyIfUpdate` 两分支、迁移 patch 守卫、失败保留 commit、upstream 源解析）。

## ADR-005：自定义供应商模型声明输入模态——`modalities` 字段全程透传，图片不再被静默降级

- **状态**：已接受（issue #11）
- **背景**：meerkat-triz 是多模态模型（支持视觉），但用户上传图片后平台提示 `[image omitted: model does not support images]`，模型实际未收到图片。根因：上游 pi-ai 的 `downgradeUnsupportedImages` 在发送前检查 `model.input.includes("image")`，不含则把 image block 替换为占位符；而自定义供应商通道只考虑文本场景——`CustomModelSpec` 没有声明模态的字段（`input` 字段名已被价格语义占用），`toRuntimeModel` 对所有 custom 模型硬编码 `input: ["text"]`，`customModelsJson()` 物化给 pi-coding-agent 运行时的 models.json 同样不带模态。内置模型不受影响（pi-ai 自带注册表视觉模型有 `input: ["text","image"]`）。
- **决策**：在已有链路上加模态字段并全程透传，不新增配置文件：
  1. `CustomModelSpec` 增加 `modalities?: ("text"|"image")[]` 软字段（store 基于 DurableMap 整条 JSON 存取，无迁移；缺省 = 仅文本，存量注册行为不变）；
  2. `validateCustomProviderSpec` 校验 modalities：非空数组、取值限于 `text|image`、不允许重复项；
  3. `toRuntimeModel` 用 `modalities` 填运行时 `input`，不再写死；
  4. `customModelsJson()` 物化每个模型的 `input`（pi-coding-agent 的 ModelDefinitionSchema 原生支持可选 `input: ("text"|"image")[]`）；
  5. `meerkat-triz.conf` 的 `MODELS_JSON` 为 triz 模型声明 `"modalities":["text","image"]`（conf → `meerkat-local-up.sh` → `PUT /v1/admin/custom-providers` 链路对 models 数组原样透传，无需改脚本与路由）。
- **理由**：这是通道能力缺失而非拦截逻辑错误——pi-ai 的降级行为本身是对的（把图发给纯文本模型只会报错），缺的是自建模型声明多模态的途径。复用现有注册链路加字段是最小改动；字段取名 `modalities` 而非 `input`，因为 `input` 在 `CustomModelSpec` 里已是价格语义（USD/Mtok），同名会造成「同一字段两种含义」的混乱。
- **被否决**：
  - 给所有 custom 模型一律声明 `["text","image"]` —— 纯文本模型会因此绕过降级保护，图片直发上游报错，体验更差；
  - 走 upstream-pr 等上游 qm 修 —— 已拍板本仓改 core（issue #11 修复方向），上游通道周期不可控；
  - 在 opencode harness 同步透传模态 —— 桌面版走 pi harness，opencode 通道的模态声明机制不同，超出本 issue 范围，留待实际需要时再评估。
- **后果**：内核缝改动集中在 `src/model/custom-providers.ts`（字段 + 校验 + 两处物化，净约 +35 行）；存量未声明 modalities 的注册行为逐字节不变（默认 `["text"]`）；回归测试把守（`test/custom-providers.test.ts`：声明 image 的模型经 `resolveCustomModel`/`customModelsJson` 透出 `["text","image"]`、未声明默认 `["text"]`、非法 modalities 被校验拒绝）。**已注册 triz 的存量环境需重跑 `meerkat-local-up.sh`（或重新 PUT）刷新注册后修复才生效**——运行时注册表由注册时的 spec 物化，不会自动感知 conf 变化。

## ADR-006：UI i18n 中文化与品牌替换直改 core——不可插拔的文案改动面，以字典单文件与 merge 惯例收敛维护成本

- **状态**：已接受（需求 2.1 / 2.2，非 issue 驱动；commits `60b33b5` `4389eec` `d72e1cf` `ef50d25` 及本批 portal/auth 提交）
- **背景**：需求 2.1 要求 web-ui / admin / portal/auth 全部用户可见文案中文化，需求 2.2 要求品牌串 QM → MeerkatAI、Meerkat → MAPID。i18n 本质上不可插拔：文案嵌在各插件的组件模板与服务端渲染页里，收不进 `deploy/layers/meerkat/`，唯一诚实的做法是直改 core（`plugins/web-ui`、`plugins/admin`、`plugins/portal`、`plugins/auth`）。
- **决策**：
  1. web-ui 走 mini-lit 同源 i18n 机制——唯一字典 `plugins/web-ui/src/locale/zh-cn.ts`（英文原文即 key，约 950 key），boot 时 `localStorage` 无条件写 `"zh"` 并展开合并 `setTranslations({ ...getTranslations(), zh: ZH_CN })`；组件一律使用 locale 模块的安全包装 `i18n`（try/catch 回退 key 本身）与动态串防崩 helper `tr()`，禁止直接 import mini-lit 的 i18n；
  2. admin 为无构建静态单文件，文件头部内联 `T` 字典 + `t(key)` 函数（同一「英文原文即 key」约定），约 1071 条；
  3. portal/auth 量小（约 50-80 条），不建机制，登录/错误页/登录邮件直接替换为中文字符串，品牌位同步换 MeerkatAI；
  4. 品牌替换全量口径：web-ui 三注入中枢（index.html meta、`ui.ts` fallback、服务端 shell 模板）+ admin + portal/auth，代码标识符/包名/路径/注释不动；
  5. 语言策略硬默认中文、不做切换入口（机制天然支持，以后要加只是补 UI）。
- **理由**：机制与 pi-web-ui（mini-lit）同源，零新增依赖；「英文原文即 key」使漏翻天然回退英文而非崩溃，配合扫描脚本可把「翻译完成」定义为机器判据。
- **被否决**：
  - 把文案抽到 `deploy/layers/meerkat/` 做插拔式覆盖 —— 文案分散在 27+ 个组件模板里，覆盖层需要改每个组件的取值点，等于照样改 core 且多一层间接；
  - 等上游 qm 引入 i18n 再跟随 —— 上游无此计划，周期不可控；长期可反向把机制贡献回上游（upstream-pr）以彻底消除冲突面，本期不做；
  - admin 与 web-ui 共享字典/抽公共模块 —— 跨无构建静态文件与 Vite 工程，过度设计。
- **后果**：core 改动面大（web-ui 27 文件 + admin 单文件 + portal/auth 六文件（portal/index.ts、portal/oidc.ts + auth/config.ts、email.ts、pages.ts、server.ts）），随主仓升级会产生冲突。量化评估（2026-08-23 实证）：近 90 天 origin/main 对 web-ui/src 共 43 个提交、触及 27 个目标文件 89 次、admin/index.html 12 次；抽样 diff 显示上游改动绝大多数是逻辑/结构行而非文案行，冲突只在「上游改的行 ∩ 我们包过的文案行」时发生，预估每次升级几处到几十处小冲突，叠加新增英文串补翻，**常态维护成本约 0.5~1 人日/次**。三层缓冲：① 字典集中单文件，永远零冲突；② 包裹改动机械同构，冲突有固定解法（保留 i18n() 包裹 + 吸收上游语义改动）；③ **merge 惯例：每次 update-qm 后跑一次 `plugins/web-ui/scripts/check-untranslated.mjs` 扫描脚本，裸露英文清单即补翻 todo**（脚本兼作 merge 检查门）。存量环境注意：web-ui 文案为构建期产物、portal/auth 为运行期渲染，升级后需重建并重启进程才生效。
- **补记（issue #14）**：pi-web-ui 的 `dist/utils/i18n.js` 顶层执行 `setTranslations({en,de})`（整体替换语义），其 chunk 在 boot 后动态加载时会把 `setupLocale` 注册的 zh 字典抹掉，表现为中文闪现后恒回英文。对策：入口 `main.ts` 静态 import 该模块（经 vite 别名 `pi-web-ui-i18n`，受 exports 限制无法深路径直引），利用求值顺序让其覆盖先跑完、`setupLocale` 的合并最终生效；模块单例只求值一次，后续动态加载不再二次覆盖。回归把守：`plugins/web-ui/test/locale.test.ts`（wipe 后重注册 + 入口顺序源码断言）。

## ADR-007：New skill 表单 name 严格校验前置到 UI——直改 core，服务端宽松规则不动

- **状态**：已接受（优化 1「Skill name 中文校验」）
- **背景**：web-ui 的 New skill 表单对 name 只查非空，中文等非法字符直送服务端后以 500（internal server error）收场。core 服务端实际校验规则（1-128 位、允许大写/点/下划线）比 Claude Skill 规范宽松，收紧服务端会影响既有合法存量 skill，且 500→400 的修复已归 issue #7，不在本需求范围。
- **决策**：UI 层前置严格校验（对齐 Claude Skill 规范：1-64 位、仅小写字母/数字/连字符、不以连字符开头结尾、不连续连字符），规则收敛为新模块 `plugins/web-ui/src/skill-name.ts` 的 `isValidSkillName()`；`creatorPane` 输入非法时内联提示并禁用提交按钮，`saveCreate` 同规则二次把守；提示文案走 ADR-006 的 i18n 字典。改动面：`plugins/web-ui/src/{skill-name.ts,skills.ts,locale/zh-cn.ts}` + `plugins/web-ui/test/skill-name.test.ts`。
- **理由**：校验逻辑与表单组件同仓同语言，插拔层无法在不改组件模板的前提下注入；抽独立模块是为单测可断言规则本身（沿用 skills-refresh/skills-mutation 的抽取惯例）。服务端规则保持宽松，UI 严格子集提前拦截，两层规则不冲突。
- **被否决**：
  - 同步收紧服务端规则 —— 会拒绝按宽松规则已存在的合法 name，且与 issue #7 的范围重叠；
  - 复用服务端同款宽松规则做 UI 校验 —— 放过大写/点/下划线，不满足需求给定的 Claude Skill 规范口径。
- **后果**：随主仓升级若上游改动 `skills.ts` 的 create 表单会产生小冲突，解法同 ADR-006 的 merge 惯例；回归把守 `plugins/web-ui/test/skill-name.test.ts`（规则单测 + 表单接线源码断言）。
- **补记（issue #7 Bug A 服务端侧）**：UI 前置拦截之外，服务端三层失守一并修复——`assertSafeSkillName` 改抛带类型的 `SkillNameError`（`src/skills/skill-name.ts`），`src/api/server.ts` 的 `respondError` 与 fastify `setErrorHandler` 两处 500 兜底统一映射为 400 + 规则文案（沿用 `PayloadTooLargeError`→413 的既有 typed-error 模式）。修在所有路径的汇聚层，create/edit/publish/import 等全部经过 `assertSafeSkillName` 的入口一次覆盖，路由层零改动；存量合法 name 行为不变（错误类型是 `Error` 子类，既有 catch 语义不受影响）。回归把守 `test/skills-http.test.ts`（中文名 POST 断言 400 + 规则文案）。

## ADR-008：无沙箱基质的 turn 失败走 NonRetryableTurnError + UI 人话映射——core 只改错误类型，文案归属 UI 层

- **状态**：已接受（issue #8）
- **背景**：无 WSL2 的 Windows 裸机上 `SANDBOX_BACKEND=none`，`none-sandbox` 以裸 `Error` reject，turn 崩溃被 worker 重试数次后兜底为 "That turn failed..."，用户完全无法得知原因是沙箱基质缺失，也无法自救。桌面壳侧 `enable_wsl2`（提权 `wsl --install`）+ `pending_reboot` + rootfs 自动导入链路早已存在但未在任何界面接线（仅首启 setup.html 有一键启用按钮，设置页不可回访属优化 2 范围）。
- **决策**：
  1. core：`none-sandbox.ts` 改抛 `NonRetryableTurnError`——无基质的重试必然失败，立即以原文 surfaced 且零重试；错误消息保持英文技术签名（`SANDBOX_BACKEND=none`），core 不携带任何桌面/语言特定文案；
  2. web-ui：新增 `turn-failure.ts` 的 `humanizeTurnFailure()`，按技术签名映射为 i18n 中文可操作文案（指引「重启应用 → 启动页启用沙箱 → 重启电脑」），其余 turn 失败消息原样透传；中文文案归属 UI 层沿用 ADR-006 的口径；
  3. 桌面启动清单页（`deploy/layers/meerkat/desktop/ui/index.html`，org 层零内核触碰）：沙箱 `supported && !wsl_enabled` 与 `!supported` 从黄灯降级改为红灯 failed + 说明后果（所有对话将无法执行），并内嵌「启用沙箱」按钮直调既有 `enable_wsl2` 命令，成功后转入 pending_reboot 黄灯「重启电脑后生效」；
  4. 不硬阻断自动进入主界面：红色提示 + 人话报错已构成完整自救回路，硬阻断会把暂不想处理的用户困在启动页，且对 `!supported` 机器等于死锁。
- **理由**：`NonRetryableTurnError` 是 core 既有的「原因直达用户」通道（orchestrator 3140 行），语义精确匹配；技术签名→人话文案的映射放 UI 层，core 对上游保持干净。
- **被否决**：
  - core 直接抛中文/桌面指引文案 —— 语言和恢复路径是桌面产品决策，不属于内核；
  - 启动页硬阻断进入主界面 —— 见决策 4；
  - worker 层识别沙箱错误再翻译 —— 错误类型本身即信号，无需在 worker 加模式匹配。
- **后果**：无沙箱机器上的 turn 失败从「重试数次 + 兜底文案」变为「首次失败即告知原因与恢复路径」；任何依赖 none backend 重试语义的行为（不存在合理场景——无基质重试必然失败）消失。回归把守 `test/none-sandbox.test.ts`（NonRetryableTurnError 类型断言）、`plugins/web-ui/test/turn-failure.test.ts`（映射 + 透传 + 接线源码断言）。随主仓升级若上游改动 none-sandbox 或 core-bridge 的 turn_failure 回放段会产生小冲突，解法同 ADR-006 惯例。

## ADR-009：MCP server 认证支持自定义单头模式——YAGNI 否决任意字典，secret 语义对齐既有凭据

- **状态**：已接受（需求 3，Brainstorming 2026-08-24 拍板）
- **背景**：桌面版需接入 lawaken memory MCP 服务，其鉴权方式为非标准自定义头（`X-Lawaken-MCP-Key`）；core 的 MCP client 只支持 `none / bearer / client-credentials`，`authHeaders()` 只会产出 `Authorization` 头，无法发出自定义头。
- **决策**：`McpServerAuthMode` 新增 `"header"` 单头模式：`McpServer` 增加 `headerName?` / `headerValue?` 两个字段，`authHeaders()` 产出 `{ [name.toLowerCase()]: value }`；路由校验 headerName 为合法 HTTP header token 且大小写不敏感地不在保留名单（authorization/host/content-type/accept/content-length/connection/transfer-encoding）内；`headerValue` 与 `bearerToken`/`clientSecret` 同等待遇（新建必填、更新留空=保留、GET redact 不回明文、不进沙箱）；`redact()` 同步扩展 `hasHeaderValue`。实现保持上游可贡献形态：代码与测试零 meerkat/lawaken 字样，测试用中性头名 `X-Custom-Key`，保留 upstream-pr 送回主仓的选项。
- **被否决**：
  - 任意字典 `Record<string,string>` —— lawaken 只需一个头，X-API-Key 类服务也几乎都是单头；Record 是为「一个调用方都没有的模式」造的抽象（AGENTS.md 明确反对），且每个 key 都要重复保留名单校验、鼓励塞非鉴权头，语义变浑；
  - lawaken 侧兼容 `Authorization: Bearer` —— 依赖外部团队排期，且需求给定的鉴权方式就是自定义头；
  - 本地 sidecar 代理改写头 —— 零内核改动但多一个常驻组件，key 的管理面反而变大。
- **后果**：内核缝改动四处——`mcp-server-store.ts`（类型）、`mcp-client.ts`（`McpAuth` + `authHeaders()`）、`mcp-servers.ts`（`AUTH_MODES` + 校验 + `redact()` 签名扩展）、`mcp-tool-service.ts`（`authOf()` 映射）；存量 none/bearer/client-credentials 注册行为逐字节不变；回归测试把守（`test/mcp-connectors.test.ts` 传输层、`test/mcp-servers-route.test.ts` 路由校验/redact/留空=保留/切换清 secret/probe fail-closed）。

## ADR-010：分类器路由与锁回放的模型可用性校验前置——L3 跳过降级、L1 fail-closed 阻断

- **状态**：已接受（issue #12）
- **背景**：桌面版 `seeds/routes.json` 把 L1（PII）/L3（TRIZ）都路由到 `Meerkat-TRIZ-v1`，但 `local-secure` provider 只在设置页填了本地模型 endpoint 时才注册（`plugins/web-ui/server/index.ts` 的 `registerProviders`）——未填则 core 的 custom registry 里不存在该模型 id。而分类器的 PII/TRIZ 命中是纯本地规则层（`deploy/layers/meerkat/classifier/src/pipeline.ts`），不依赖任何用户配置。`orchestrator.ts` 应用分类器路由（含 `sessionPin` 写锁）与回放会话锁时**全程无 `modelSupportedByHarness` 校验**，直接把 `input.model` 覆盖为未注册 id，下游 `harness-router.ts` 对 requested 不合法即抛 `runtime pi/Meerkat-TRIZ-v1 is not approved`——L3 单轮炸，L1 锁会话后每轮必炸，且错误文案对用户无任何可行动指引（issue #12 截图即此）。
- **决策**：在两处覆盖点（全仓仅有的两处无校验 `input.model` 写入）前置 `isHarnessId + modelSupportedByHarness` 校验，按路由的安全语义分流：
  1. **L3 域路由（非 pin）不可用 → 跳过**：不覆盖 `input.harness/input.model`，turn 用用户/默认 runtime 继续，审计 `classifier.route` status=`skipped`（detail 带 `reason:"model not available"`）——TRIZ 路由是回答质量优化项而非安全项，对齐 v0.1 设计文档「知识包未导入不阻断、TRIZ 回答退化」的既有哲学；
  2. **L1 隐私路由（pin）不可用 → fail-closed 阻断**：抛 `NonRetryableTurnError`（文案明确「敏感内容必须走该模型、其 provider 未配置、拒绝回退其他模型」），审计 status=`blocked`，且**不写会话锁**——锁一个不可用模型等于把会话永久锁死在必炸状态。依据 v0.0 ADR「分类不可用即假定最坏情况，不 fail-open」：敏感内容绝不能静默改道云端模型；
  3. **锁回放不可用 → 同样 fail-closed**：锁写入时模型合法、回放时可能已不合法（provider 被移除），校验失败抛 `NonRetryableTurnError`（指明会话被隐私锁定到不可用模型），审计新增 `session_lock.blocked`。隐私锁与普通路由同一标准，不留后门。
- **被否决**：
  - 在 `harness-router`/`resolveRuntimeChoice` 层把「requested 不合法」从抛错改为静默回退 —— 改变上游公共语义，所有 surface 的显式模型请求都会被静默换模型，误导面比修复面更大；
  - L3 路由不可用也阻断 —— 优化项缺失不应打断正常聊天，与决策 1 的既有哲学冲突；
  - 源头永远注册 `local-secure`（空 baseUrl 占位）—— 空 baseUrl 过不了 `validateCustomProviderSpec`，填假地址只会把错误挪到更难懂的「连接失败」，且没解决 routes.json 写错 id 这类通用缺口；
  - 修在 web-ui/桌面层 —— 覆盖发生在 orchestrator 执行期，UI 层拦不住；修在汇聚层两处即覆盖全部 surface。
- **后果**：core 改动限 `orchestrator.ts` 两处 + import 行；错误呈现走 ADR-008 的既有 `NonRetryableTurnError → turn_failure` 通道，用户看到的是可行动文案而非 "not approved"；`desktop/seeds/routes.json` 与 `providers.local-secure.json` 的模型 id 保持一致（注册了即合法），本 ADR 兜的是「未注册/锁后失效」窗口；随主仓升级若上游改动 orchestrator 分类器段会产生小冲突，解法同 ADR-006 惯例。回归把守 `test/sensitivity-classifier-integration.test.ts` 三个新用例（L3 跳过不写锁 / L1 阻断不写锁 / 锁回放失效阻断）。

## ADR-011：custom provider 的 models.json 缓存路径按「存在性」失效重建——缓存键从版本号到版本号+文件存活

- **状态**：已接受（issue #21）
- **背景**：`customModelsPath()`（`src/harness/pi-harness.ts`）把 custom provider 的 models.json 物化到 `os.tmpdir()` 下的 `pi-custom-models-*` 目录，并按 registry version 在内存缓存路径、从不校验文件是否还在。Windows 存储感知（及任何第三方清理工具）扫 %TEMP% 删掉该文件后，pi 的 `ModelConfig.load` 对缺失路径**静默返回空配置**——provider 未注册 → `checkAuth` 返回 undefined → 模型切换抛错被吞 → session 回落内置默认模型（anthropic）→ 无 key 崩溃，且每轮必现，直到进程重启或 admin 再写一次 provider（issue #21 有完整定位链与复现验证）。桌面端实机 2026-08-26 09:57:41 存储感知一次性清空 15 个 `pi-custom-models-*` 目录后全量复现。
- **决策**：缓存命中条件从「version 相同」收紧为「version 相同**且缓存路径文件仍存在**」（`existsSync` 每轮一次，成本可忽略）；文件（或整个目录）消失即按同 version 重新物化到新目录并更新缓存。物化位置仍在 %TEMP% 不动。
- **理由**：失效模式的本质是「缓存假设了身外之物的存活」，存在性校验兜住一切删除原因（清理工具、手动删除、整目录被端），而不只对存储感知这一个来源；改在 `customModelsPath` 这个唯一汇聚点，`buildModelRuntime` 及所有调用方零改动。
- **被否决**：
  - 物化到 DATA_DIR 而非 %TEMP% —— 缩小了暴露面但不解决本质（DATA_DIR 同样可被外部删除），且 DATA_DIR 需要把配置参数穿进 harness 层，改动面大于收益；存在性校验达成同等恢复力；
  - 缓存内容内存化、每次重写同一路径 —— 目录整体被删时 writeFileSync 仍失败，还要额外 mkdir，与重新 mkdtemp 等价比没有优势；
  - 文件 watcher 监听删除事件主动重建 —— 跨平台 watcher 语义复杂（chokidar 级依赖），为每轮一次 existsSync 就能解决的问题引入持续监听不值得。
- **后果**：core 改动限 `pi-harness.ts` 的 `customModelsPath` 一处 + fs import；version bump 行为逐字节不变；`customModelsPath` 导出供测试直驱。被清理后下一轮 turn 自动恢复，无需重启、无需 admin 重写。回归把守 `test/pi-harness-custom-models.test.ts`（缓存命中 / 文件消失重建 / 目录消失重建 / 空 registry 返回 null）。该模式同样适用于上游 qm（%TEMP% 清理在 Windows 桌面是常态），保留 upstream-pr 送回主仓的选项。

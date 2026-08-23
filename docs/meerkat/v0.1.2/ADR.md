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

# CHANGELOG v0.1.2-alpha

## 主要变更

### Features
- enable ARTIFACT_STORE=sqlite for desktop (#34)
- add sqlite file artifact store (#34)
- preinstall weasyprint and CJK fonts in the sandbox rootfs (#31)
- enable workspace output delivery via env (#24)
- note background-job delivery boundary in file-send guidance (#24)
- sweep undelivered DM turn outputs into delivery at turn close (#24)
- deliverWorkspaceOutputs config flag wired into orchestrator deps (#24)
- workspace sweep collector with path+hash dedup for undelivered turn outputs (#24)
- MCP server management section on the desktop setup page (需求 3)
- revisit-safe setup page with SPA settings entry (优化 2 / 需求 3)
- forward /api/setup/mcp-servers routes to core admin API (需求 3)
- validate and redact header auth on MCP server admin routes (需求 3)
- add single-header auth mode to MCP client transport (需求 3)
- gate skill creation on strict ASCII name rule (优化 3)
- default model to Meerkat-TRIZ-v1
- replace app icon with meerkat logo (需求 2.3)
- zh-CN sign-in and error pages, terminology consistency pass
- localize admin console to zh-CN
- complete zh-CN localization, brand swap to MeerkatAI/MAPID, attachment error mapping
- localize top-10 copy-heavy surfaces to zh-CN
- locale infrastructure — zh-CN dictionary, tr() helper, boot injection, untranslated-string scanner
- show skill pack status on the boot checklist via a tauri command
- bundle skill pack snapshots into the payload, generate the seed at build time
- import desktop skill packs from bundled snapshots, single-shot upstream sync, status endpoint
- resolve skill sync refs against upstreamUrl when present
- sync skill packs from upstreamUrl with onlyIfUpdate; preserve last good commit on failure
- accept upstreamUrl on skill pack register/patch; guarded local:true patch for migration
- add SkillPack.upstreamUrl with upstreamSource helper (ADR-004)
- read bundled skill pack snapshots directly, skipping git (ADR-003)

### Fixes
- include viewer query param when fetching file content from core (#25)
- correct sqlite store open() stream type to Readable (#34)
- intercept bare /api/files/<id> links from model markdown (#25)
- request file contents from core with source auth (#33)
- keep optional deps when staging the classifier (#32)
- drop the name-ordered kill batches in the install hook (#30)
- stop install-kill hook from terminating the uninstaller itself (#30)
- kill child processes with the app via Job Object, pre-kill on install (#30)
- address review findings on crash logging and verify cleanup (#29)
- stage wasm runtime assets in payload and log child exit status (#29)
- strip CR before hashing rootfs fingerprint inputs (#28)
- LF-normalize rootfs scripts and cover them in the sandbox fingerprint (#28)
- drop commit-equality readiness fallback in pack status (#26)
- unconditional idempotent import for seeded skill packs (#26)
- reuse identical exports instead of writing numbered copies (#25)
- quote only the path in explorer /select, not the switch (#25)
- intercept new-window requests — export file artifacts and reveal in Explorer (#25)
- isolate scratch-box sweep artifact ids with a :sweep:scratch seed (#24)
- preload doc toolchain in rootfs and point pip/npm at China mirrors (#23)
- humanize missing-API-key turn failures instead of leaking pi runtime text (#22)
- re-materialize custom provider models.json when the cached temp file disappears (#21)
- validate classifier-routed and session-locked runtimes before applying them (#12)
- clear two pre-existing eslint errors blocking lint gate (#18)
- render MCP server rows with textContent instead of innerHTML (需求 3)
- red-flag missing WSL2 on the boot checklist with one-click enable (#8)
- surface none-sandbox turn failures with the cause and a recovery path (#8)
- map invalid skill names to 400 instead of 500 (#7)
- locate Visual Studio via vswhere instead of a hardcoded path (#16)
- self-heal broken sandbox distro and unregister dangling WSL distro on uninstall (#15)
- evaluate pi-web-ui i18n before setupLocale so zh survives its setTranslations wipe (#14)
- declare image modality for local-secure triz model so uploads reach the model (#11)
- localize oidc error detail strings rendered on sign-in error page
- wrap missed resend error string in zh-CN dict
- repair i18n review findings — view-id routing, missed strings, scanner interpolation coverage
- let custom providers declare input modalities so images reach multimodal models (#11)
- store CLAUDE.md as a regular file instead of a broken symlink
- grant the splash window permission to invoke skillpacks_status (#6)
- refresh stale snapshot paths and derive boot status without latching offline sync failures (#6)
- clear the skill pack row syncing label once it leaves pending
- skip local DNS validation for skill pack fetches behind a configured git proxy (#7)
- clear sqlite session leases at open so a dead process cannot lock a session

### Docs
- merge v0.1.5 file artifact persistence docs into v0.1.2 (#34)
- add requirement, research, design, plan and ADR for sqlite file artifact persistence (#34)
- v0.1.2 需求 5（会话产出文件兜底可见）设计/ADR-012/执行计划定稿 (#24)
- v0.1.2 需求 5（会话产出文件兜底可见）需求描述与调研
- ADR-010 分类器路由与锁回放的模型可用性校验前置 (#12)
- ADR-009 custom single-header auth for MCP servers (需求 3)
- v0.1.2 需求 4（技能页本地上传入口）需求/调研/设计定稿
- v0.1 发布文档补齐 rootfs 构建步骤与踩坑记录
- v0.1.2 需求 3（接入 MCP Server）调研/设计/执行计划定稿
- restructure requirement 2 categories and trim issue 1 archive note
- ADR-006 i18n core-change record
- fold i18n plan review — safeI18n wrapper for storage-less environments, portal brand scope
- v0.1.2 i18n execution plan (slim, 5 tasks)
- v0.1.2 i18n research and design (two review rounds folded in)
- v0.1.2 issue #6 research, ADR-003/004 and execution plan (#6)
- align status derivation with the error matrix — offline sync failure stays green (#6)
- CLAUDE.md — Meerkat layer conventions on top of AGENTS.md
- ADR v0.1.2 — clear sqlite session leases at open, single-instance invariant (#5)
- ADR v0.1.2 — skip local DNS validation behind configured git proxy (#7)
- v0.1.2 requirements — sub-agent, i18n, skill-name validation, settings entry, issue plan

### Chores
- update Cargo.lock for 0.1.2-alpha
- sync tauri.conf.json version to 0.1.2-alpha
- bump installer version to 0.1.2-alpha
- bump installer version to 0.1.3-alpha (#29)
- skillpacks 切换为 activity/common/lawaken 三个 pack
- bump installer version to 0.1.2-alpha (#6)

### Tests
- add sqlite file artifact store tests (#34)
- live verification script for bundled skill pack snapshots (#6)
- close route-test server in finally so failures don't hang the runner
- live repro/verify script for the stale session lease fix (#5)

### Refactors
- share skill pack seed matching helpers; de-flake sync count assertions


## 统计

- 提交数：101
- 对比范围：v0.1.1-alpha..v0.1.2-alpha

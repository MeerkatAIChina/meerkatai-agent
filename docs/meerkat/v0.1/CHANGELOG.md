# CHANGELOG

> Meerkat（基于 qm 私有 fork 二次开发）的版本变更记录。基准版本：v0.0（tag `meerkat-v0.0.0`）。

## [v0.1.0] — 2026-08-14（tag `desktop-v0.1.0`）

主题：**桌面化交付物**——Tauri v2 壳 + 随包 Node 运行时，用户无需安装 Node/Docker，双击即用。

### Added

- **Tauri 桌面壳**（`deploy/layers/meerkat/desktop/`）：动态端口分配（`TcpListener::bind` 选空闲端口注入，"端口被占用"从故障清单抹除）、三进程生命周期管理、健康轮询、运行期崩溃自动拉起一次、关窗回收全部子进程
- **清单式启动页**：分类器 / 核心服务 / 知识包 / 界面逐项点亮；失败分级（core/web-ui 红灯阻断 + 重试 + 一键复制诊断信息，classifier/知识包黄灯降级放行）
- **SQLite 持久化**：`node:sqlite` 原生驱动的 `DurableMap` 第三后端与 `SQLiteSessionStore`（对齐 Postgres 版 31 方法，共享契约测试），会话/锁/配置/skills 全部落盘，重启不丢
- **首启设置页**（`/setup`）：服务令牌（必填，先验证后入库）、本地模型地址+密钥（选填，带连通测试）、网络代理（选填，保存后自动重启核心服务生效）
- **桌面登录链路**：`portal_token` command 签发 24h TTL 身份令牌，query 参数传递 + localStorage 续命，免登录进主界面
- **Skill packs 自动导入**：种子 `skillpacks.json` + web-ui 启动任务（等待登录 token → 注册/导入 → 4 次退避重试），每次启动自动同步最新版；支持 `local: true` 本地仓库路径（`ALLOW_LOCAL_SKILL_PACKS` 受控通道）
- **会话锁管理面**：`GET/PUT/DELETE /v1/admin/session-locks(s)` 管理接口（admin 门禁 + 审计）+ 桌面 `/admin/locks` 管理页（列表/重定向/释放）——ADR-009
- **自动更新**：tauri-plugin-updater 全量更新管线（更新源 endpoints 尚为占位符，见 Known Issues）
- **CI 发布矩阵**：`desktop-v*` 标签触发 windows-x64 / macOS-arm64 / macOS-x64 三平台构建、签名、上传 Release
- **发布/用户文档**：`发布文档.md`（构建链路）、`用户文档.md`（使用说明）

### Changed（core 内核缝改动，均有 ADR）

- **`resolveModel()` 自定义供应商注册优先于内置同名型号**（ADR-007）：tensoris 以本名代理 gpt-5.4-nano 等型号，原"内置遮蔽自定义"语义导致注册了也 403；反转后显式注册胜出
- **新增 `SKILL_PACK_GIT_PROXY` 显式代理开关**（ADR-008）：pack-fetcher 默认仍禁用一切代理（SSRF 防护不变），显式设置后 git 克隆走指定代理；config 严格校验 URL，非法值拒绝启动
- **`CLASSIFIER_TIMEOUT_MS` 可配置**，默认 15s；分类器语义配置支持 `local-model.json` 热加载
- wiring.ts 两处 `createGitFetcher` 重复分支合并

### Fixed（真机测试反馈）

- **普通对话被误判敏感锁死**：分类器语义层对推理模型加 `max_tokens` 8192 + 关闭思考链，超时从硬编码调优，正常聊天不再 fail-closed 误钉（`4b84396`）
- **空文本唤醒 turn 误分类**：orchestrator 对空分类输入跳过分类（`8b11b42`）
- **设置页按钮禁用/保存失败/点击无反应**：令牌验证改为点击时校验（`0e10152`）；provider protocol 值修正为 `openai`（`1943d12`）
- **CSP 拦截内联脚本**：setup/locks 页放行内联脚本，portal-token 引导脚本外置（`021006c`/`b94fd0e`）
- **skill pack 启动任务 401 空转**：core 生产模式要求 `/v1/admin/*` 携带已验证 portal 身份，任务改为捕获 token 后执行（`fe5f94c`）
- **Tauri ACL 拦截 `restart_core`**：build.rs 声明命令清单自动生成 `allow-*` 权限；capabilities 收口——web-ui 远程来源只放行 `restart_core`，`portal_token` 保持本地专属（`0b32c33`）
- **载荷缺失运行时文件**：tiktoken wasm 随包（`754bb0e`）、pg 打进 core bundle、classifier 保留 esbuild optional deps（`039562d`）
- **Windows 黑窗**：GUI 子系统 + 子进程隐藏 console（`82894e7`）

### Known Issues（遗留，转下一版本）

- 自动更新 endpoints 为占位符（`updates.example.com`），接真实托管后才生效
- macOS 真机未验证（CI matrix 已建未实跑）
- 设置页"导入知识包"入口未做；聊天页内 🔒 锁标识未做
- 已保存令牌的更换无 UI 入口（只能删数据目录重走首启）
- 无沙箱：代码执行/文件读写类工具不可用（等自研沙箱需求落地）
- 测试套件 3 个 Windows 平台预存失败（git 伪造二进制 spawn、RUN_STORE 旧用例），基线对照确认与 v0.1 改动无关

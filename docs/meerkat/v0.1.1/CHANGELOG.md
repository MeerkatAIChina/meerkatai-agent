# CHANGELOG

> Meerkat（基于 qm 私有 fork 二次开发）的版本变更记录。前一版本：[v0.1.0](../v0.1/CHANGELOG.md)（tag `v0.1.0-alpha`）。

## [v0.1.1-alpha] — 2026-08-18

主题：**桌面沙箱**——Windows 上基于 WSL2 的代码执行沙箱，guest 内出网白名单围栏；另含锁管理 UI 入口、锁标识、TRIZ 模型进选择器三项体验补齐。

### Added

- **WSL2 沙箱后端**（`src/sandbox/wsl2-sandbox.ts`）：复用 microvm agent 协议（与 aws/local 后端同构），core 持有常驻 wsl.exe 子进程管理 guest agent 生命周期（ADR-003）；`SANDBOX_BACKEND` 新增 `none` 显式降级桩与 `wsl2` 实现，Tauri 壳按平台映射（Windows → wsl2，macOS → none）
- **定制 rootfs 随包内置**：精简 Debian + Node + agent.mjs（约 148MB，`rootfs/Dockerfile` + `scripts/build-rootfs.sh` 构建）；指纹变更自动重导，**重导前强制备份 /home**，备份失败即中止不丢 workspace
- **guest 内出网围栏**（ADR-001）：guest 内 CONNECT 代理（root、loopback）+ iptables `-m owner --uid-owner` 权限分离，domain 白名单种子 `sandbox-egress.json`（pypi/npm/github/常用镜像）；白名单外 403、绕过直连 DROP、杀代理 fail-closed
- **沙箱设置入口**：首启/设置页新增「沙箱」区块——状态显示（未启用/初始化中/就绪/不支持）、一键启用 WSL2（UAC 提权 + 重启引导）；启动清单页新增沙箱状态行（黄灯不阻断）
- **agent 安全内核缝**（ADR-002）：`AGENT_AUTH_TOKEN`（core 每次启动生成一次性 token，WSLENV 传入）+ `AGENT_RUN_USER` 权限分离（exec 默认普通用户，`root:true` 管家通道）——均 env 可选、默认关闭
- **聊天页 🔒 锁标识**：会话被锁后模型/Harness 选择器替换为禁用态 `🔒 <modelId>` 按钮，提示可去锁管理页解除；锁状态随会话切换与发消息自动刷新
- **锁管理页入口**：桌面模式聊天页顶栏出现锁管理入口（runtime-config 注入 `desktop` 标志控制），直达 `/admin/locks`
- **TRIZ 模型进选择器**：种子 `webuiModels` 加 `Meerkat-TRIZ-v1`，用户可主动把会话切到本地模型（与会话锁的 L1 强制路由互不冲突）
- **验证脚本**：`scripts/test-wsl2-e2e.ts`（真实 distro 全链路 11/11）、`verify-task14.ts`（选择器两道关卡）、`repro-issue1.ts`（Issue 1 复现）

### Changed

- 打包版本号升为 `0.1.1-alpha`；payload 含 sandbox rootfs 后安装包约 192MB（仍低于 400MB 目标）

### Fixed

- **Issue 1（Create skill 500）**：当前构建无法复现——四种分支（无 scopeId / personal / org / 同名冲突）均返回正确状态码（201/201/403/409），真机数据目录下同样通过。定位报告见 `issue-1-定位报告.md`，待真机回归后关闭

### Known Issues（遗留，转下一版本）

- 真机三路径验收中「全新机未启用 WSL2」与「无虚拟化降级」两条路径本机无法模拟，需真机/虚拟机补测
- macOS 沙箱降级为 `none`（无沙箱），macOS 沙箱实现留待后续版本
- 沙箱出网白名单调整需改种子重打包，暂无运行时 UI
- 自动更新 endpoints 仍为占位符（沿自 v0.1.0）
- macOS 真机未验证（沿自 v0.1.0）
- 已保存令牌的更换无 UI 入口（沿自 v0.1.0）

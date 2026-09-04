# 项目长期记忆

## 仓库身份
- 本仓库是 **private fork**：`origin = MeerkatAIChina/meerkatai-agent`，`upstream = yc-software/qm`（原版 qm）。
- 主要分支：`main`、`feature/meerkat`、`feature/local-dev`（本地开发用）。
- AGENTS.md 规定 private fork 的 core 必须与上游一致，但实际已偏离（i18n + 品牌替换直改 core，`git diff --stat upstream/main -- plugins src` 约 116 文件）。
- **代码零注释**硬性要求：无解释性注释/docblock/TODO/lint 抑制，意图靠命名/结构/测试，理由写 commit message。

## 上游 qm 的真实分层（不是"用户侧/管理侧/服务侧"三模块）
- **Headless core**（`src/`）：API · identity · policy · scheduler · agent loop（Pi/OpenCode/Codex/Claude Code 可换），Node + Fastify。
- **Postgres**：sessions · memory · queue。
- **Per-scope sandbox**（durable computer）：每人/房间一台，rw 层 + ro 层 + 进程会话；后端按 scopeId 路由（sprites/aws microVM/wsl2/docker/smolmachines/local/none）。
- 表面都是可选插件：`plugins/web-ui`(SPA+BFF)、`admin`(服务端渲染治理台)、`portal`(IAP 网关)、`auth`(sign-in broker)、`chassis`(共用底座)、`onboarding`。
- **Slack 是进程内插件**（`src/slack/`，Socket Mode，Bolt），跑在 core 内，非独立进程。

## 部署形态（实证）
- 默认 6 service = `core/slack/web-ui/admin/portal/auth`，但 slack 在 core 内，故 **5 个独立进程**（`cli/templates/fly/` 下 5 个 app，内部端口统一 8080）。
- portal 可选（不装时 core 直接对公网）；auth 依赖 portal。
- 四个私有服务都经 `CORE_API_URL` 调 `qm-core.internal:8080`。

## 端口拓扑与登录链路
- 默认端口：portal 8097（唯一公网入口）、web-ui 8096、admin 8090、auth broker 8099（portal `/idp` 反代）。
- **portal = IAP（身份感知代理）**：路径前缀路由、持有会话 cookie、注入 `PORTAL_IDENTITY_HEADER`（TTL 60s）签名身份，上游只认此头。
- **portal 的 IdP 默认是 Slack**（`plugins/portal/src/index.ts:132-140`），非内置 auth。三种来源：Slack(默认)/内置 broker(需 `AUTH_BROKER_UPSTREAM`)/任意外部 IdP(需 `OIDC_JWKS_URI`)。
- **auth 只做认证不做授权**：`AccessClaims` 仅 `{sub, email}`，sub=sha256(issuer+email)。授权在 portal 的 adminProbe/PRINCIPAL_RULE + core 的 scope permission/command policy/egress policy。
- OIDC = OAuth2 + ID token 身份层；三角：RP(portal)/IdP/用户。

## 联网能力（2026-09 调研）
- **无内置 web search 工具**。`pi-tools.ts` 工具集：execute/read/write/publish/memory/history/background/cron/webhook/guidance/share/stay_silent/finish_silently/credential_exec/create_goal/get_goal/update_goal。
- opencode/codex/claude harness 都显式关 websearch。
- 联网三旁路（受 egress 白名单约束）：沙箱 curl / browse 技能(远程 stealth 浏览器) / MCP 连接器。
- `credential_exec` + `use-shared-credential` 是凭据代理通道，最接近搜索能力。
- 免费搜索 API：Tavily 1000/月免绑卡、Exa $20+$10/月、Serper 2500 一次性、Brave 免费层 2026-02 已取消。

## 本地跑起来的实测结论（Windows，重要）
- **上游 dev-instance 工具链不适配 Windows 原生**：supervisor 用 Unix domain socket（`scripts/dev/supervisor/main.ts:656` 监听 `supervisor.sock`），Windows 原生 Node 报 `EACCES`。全仓库无 Windows 支持，只有 `linux` 特判。
- 坑 ①：`dev-instance.sh` 的 `pwd` 输出 `/e/...` 传给 Windows node 解析成 `E:\e\...`（绕法：直接 `node scripts/dev/cli.ts up` 用相对路径）。
- 坑 ②：dev 实例默认强制 `ANTHROPIC_API_KEY`，除非 `DEV_INSTANCE_ALLOW_MOCK=1`。
- **本机 WSL2 可用**：发行版 `docker-desktop`、`meerkat-sandbox`、`Ubuntu-24.04`。但 `wsl.exe`/`reg.exe` 被 WorkBuddy 沙箱 Program Blacklist 拦，无法代操作 WSL。
- **正确跑法 = 进 WSL（已成功跑通）**：代码放 `~/`（不能 `/mnt/e/...`）、WSL 内 node 已备好（nvm 默认 v24.15.0）。关键坑：
  - WSL PATH 被 Windows `/mnt/c/...` 污染，需 `export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"`；
  - `bash -lc` 里 source nvm 会失效，用绝对路径 node 最稳；
  - **`DEV_INSTANCE_ALLOW_MOCK=1` 必须作为环境变量传给启动命令**（`... ALLOW_MOCK=1 node scripts/dev/cli.ts up --no-slack`），写 dev.env 或 repo .env 都不生效（因为 `allowMock` 读 `spec.callerEnv`）。
- 启动成功后：portal `http://localhost:8129`（`/` 助手 + `/admin` 治理台）、core 8081、web 8097、admin 8113；core 直连返回 401（签名身份 IAP 生效）。
- sandbox 镜像已构建完成（`qm-sandbox-base:dev` + `qm-sandbox-local:latest`），smoke 全 PASS，`execute` 工具已解锁。构建坑：`fly/Dockerfile` 带 digest 引用 + Docker Hub 间歇超时，解法是先手动 `docker pull node:24-slim@sha256:...`/`debian:12-slim@sha256:...` 命中缓存再 build。sandbox 镜像 provision 时才检查，构建后无需重启实例。

## dev 实例会自动回收（重要，避免误判为故障）
- `scripts/dev/supervisor/main.ts:33-39`：`DEV_INSTANCE_IDLE_HOURS` 默认 **8 小时**，超时无活动（Slack 事件或控制操作）即 `idle self-teardown` 并删除 lease 目录（`~/.config/qm/slack-pool/leases/poolN.lock`）。
- 表现：`dev status` 显示 `0 taken / 0 free / 0 slots`，端口返回 **502**（WSL localhost 转发还在但上游已死），而 Postgres 容器可能仍存活。**这是设计行为不是故障。**
- 禁用：启动时加 `DEV_INSTANCE_IDLE_HOURS=0`（源码 `n < 0` 才报错，0 合法；只有 `> 0` 才启用检查）。
- 数据不丢：provider（含加密 key）、admin grants、runtime 配置都存在 Postgres，重启后自动恢复。

## 最终启动命令
```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/qm
DEV_INSTANCE_IDLE_HOURS=0 ANTHROPIC_API_KEY=sk-ant-dummy-for-pi-harness \
  node scripts/dev/cli.ts up --no-slack
```

## DeepSeek 自定义模型接入（已跑通）
- 上游 qm 原生支持自定义 provider（openai/anthropic 协议），key 加密存 Postgres，管理走 admin API `PUT /v1/admin/custom-providers/:id`。
- DeepSeek 当前模型 ID（2026-07 后）：`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`；旧 `deepseek-chat`/`deepseek-reasoner` 已停用。baseUrl `https://api.deepseek.com`。
- 已注册 provider `deepseek`（两个模型都挂上），org runtime 切到 `pi + deepseek-v4-flash`。
- 关键可复用知识：
  - dev 实例 signing secret 确定性生成：`sha256Hex("qm-dev\0"+databaseUrl+"\0"+KEY)`，可 import `completeDevSecuritySecrets` 复现签名。
  - 管理员 principal 是 WSL 的 `$USER`（`zamir`），不是 dev-admin。
  - 切真实模型需假 `ANTHROPIC_API_KEY` 绕过 `assembleEnv` 的硬编码检查，再 `PUT /v1/admin/scopes/org:<org>/runtime` 设 modelId。
- 本地 Postgres 由 supervisor 自动用 Docker 拉（镜像 `postgres:16-alpine`、端口 55432、容器 `qm-dev-postgres`、卷 `qm-dev-postgres-data`、密码 `qm-dev`）。
- 已生成 `.env`（`HARNESS=pi`/`ORG_ID=acme` 生效）。

## 用户偏好
- 学习阶段，关注架构/概念讲解，会追问"是什么/为什么"；喜欢对照代码讲清边界（认证 vs 授权、第三方服务 vs 依赖）。
- 目标：把 qm 在本地跑起来（暂不起 Slack、mock 模式、本地 Postgres）。

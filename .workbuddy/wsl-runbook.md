# 在 WSL2 (Ubuntu-24.04) 里本地跑通 qm 的操作手册

> 适用场景：上游 qm 的 dev-instance 工具链用 Unix socket，Windows 原生跑不了，需进 WSL。
> 目标：不起 Slack、mock 模式（不调真实 LLM）、本地 Postgres（Docker）。

## 前置说明

- 代码必须放在 WSL 的文件系统里（`~/` 下），**不要**放在 `/mnt/e/...`（Windows 盘），否则权限和性能都会出问题。
- 以下命令全部在 WSL 的 Ubuntu 终端里执行。

---

## 第 1 步：确认 WSL 里 Docker 可用

Docker Desktop 已配 WSL2 后端，WSL 内应能直接用 docker 命令。先验证：

```bash
docker info --format '{{.ServerVersion}}'
```

- 能返回版本号 → 继续。
- 报 `Cannot connect to the Docker daemon` → 先在 Windows 侧打开 Docker Desktop，再到 Settings → Resources → WSL Integration，勾选 `Ubuntu-24.04`，点 Apply & Restart，然后重试。

---

## 第 2 步：装 Node（24.x，对齐 .node-version）

```bash
# 用 nvm 装（推荐，可切版本）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# 重开终端或 source
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
# 装并启用 24
nvm install 24
nvm use 24
node --version   # 应输出 v24.x
```

> 没有 curl 就先 `sudo apt update && sudo apt install -y curl git`。

---

## 第 3 步：把代码放进 WSL 文件系统

```bash
cd ~
# 若本机已有仓库，直接 clone（走 GitHub，会拿到 main + 全部分支）
git clone https://github.com/yc-software/qm.git qm
cd qm
# 切到你基于 main 的本地分支（如果 fork 改了东西，这里改用你的 fork 地址）
git checkout main
```

> 注意：上面 clone 的是**上游** `yc-software/qm`。如果你要的是自己 fork 的那个分支
> （`feature/local-dev`），把 clone 地址换成你的 fork 地址，并 `git checkout feature/local-dev`。

---

## 第 4 步：装依赖

```bash
cd ~/qm
npm install
```

---

## 第 5 步：建 .env（mock 模式，不起 Slack）

```bash
cp .env.example .env
# 追加 mock 开关（dev 实例默认强制要真实 key，mock 可跳过）
echo 'DEV_INSTANCE_ALLOW_MOCK=1' >> .env
```

> 其余保持默认即可：`HARNESS=pi`、`ORG_ID=acme` 已生效，`SLACK_*` 保持注释（不起 Slack）。

---

## 第 6 步：跑 doctor 验证环境

```bash
npm run dev-instance:doctor -- --no-slack
# 期望看到 verdict: healthy（或 degraded，只有 sandbox 镜像未建时是 degraded）
```

---

## 第 7 步：启动

```bash
npm run dev-instance:no-slack
```

首次启动会自动：
- 用 Docker 拉 `postgres:16-alpine`（端口 55432，容器 `qm-dev-postgres`），自动 seed 管理员；
- 构建 web-ui（`vite build`）；
- 拉起 core / web / admin / portal 四个子进程。

启动日志里找 `portal auth: localhost bypass signs in as <principal>` —— 那行里的 principal 就是你登录用的身份（默认 `dev-admin`）。

---

## 第 8 步：验证与访问

另开一个 WSL 终端：

```bash
cd ~/qm
npm run dev-instance:status
# 期望四个子进程 state 都是 healthy
```

浏览器打开 portal 本地地址（默认端口见 status 输出的 PORT 列，portal 通常是 8097 附近）：

```
http://localhost:<portal端口>/
```

`PORTAL_LOCAL_AUTH_BYPASS=1` 已生效，会以 dev-admin 身份自动放行，无需真实登录。

---

## 第 9 步：关停

```bash
npm run dev-instance:down
```

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `docker info` 连不上 | Docker Desktop 没开，或 WSL Integration 没勾 Ubuntu-24.04 |
| `npm install` 很慢/超时 | 换 npm 镜像：`npm config set registry https://registry.npmmirror.com` |
| 启动报 `ANTHROPIC_API_KEY is required` | 确认第 5 步的 `DEV_INSTANCE_ALLOW_MOCK=1` 已写入 `.env` |
| 想跑 agent 的 execute 工具 | 需先 `npm run sandbox:local:build` 构建本地 sandbox 镜像（依赖 Docker） |
| 要起 Slack | 去 api.slack.com 建 App 拿 `xoxb-`/`xapp-` 两个 token，填入 `.env` 的 `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`，启动去掉 `--no-slack` |

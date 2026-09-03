# QM 本地开发部署文档

> 目标读者：需要在本地（Windows + WSL2）把 QM（上游 `yc-software/qm`）完整跑起来、并接入自定义模型（如 DeepSeek）的开发者。
>
> 本文档基于 **Windows 11 + WSL2 (Ubuntu 24.04)** 实测验证。核心结论：**QM 的 dev-instance 工具链不是为 Windows 原生设计的（依赖 Unix domain socket），必须在 WSL 的 Linux 环境里跑。**

---

## 目录

1. [架构速览](#1-架构速览)
2. [为什么要在 WSL 里跑](#2-为什么要在-wsl-里跑)
3. [前置环境检查](#3-前置环境检查)
4. [WSL 环境准备](#4-wsl-环境准备)
5. [获取代码](#5-获取代码)
6. [安装依赖](#6-安装依赖)
7. [配置 `.env`](#7-配置-env)
8. [启动实例](#8-启动实例)
9. [验证与访问](#9-验证与访问)
10. [接入自定义模型（DeepSeek）](#10-接入自定义模型deepseek)
11. [数据持久化与自动回收](#11-数据持久化与自动回收)
12. [常见问题排查](#12-常见问题排查)
13. [常用命令速查](#13-常用命令速查)

---

## 1. 架构速览

QM 上游是**服务端渲染的多服务架构**，默认部署形态为 **5 个独立进程 + 1 个进程内插件**：

```
                 ┌─────────── portal : 8097（唯一公网入口 / IAP）
                 │              ├── web-ui : 8096（SPA + BFF，可直连）
                 │              ├── admin : 8090（服务端渲染治理台，可直连）
                 │              ├── auth : 8099（可选，邮件登录，走 /idp 反代）
                 │              └── core : 8081（headless agent core）
                 │                   └── Slack 插件（Socket Mode，跑在 core 进程内）
                 └── Postgres（Docker 容器，sessions/memory/queue）
```

- **core**：headless 核心，负责 API、身份、策略、调度、agent loop。Harness 可换（`pi`/`opencode`/`codex`/`claude`），默认 `pi`。
- **portal**：身份感知代理（IAP），上游服务只认它注入的签名身份头，**绕过 portal 直连 core 会返回 401**。
- **web-ui / admin**：两个不同形态的前端（web-ui 是真 SPA，admin 是服务端渲染小服务）。
- **sandbox**：per-scope 的"持久电脑"，agent 跑 `execute` 工具的底层。本地默认用 Docker 镜像 `qm-sandbox-local:latest`。
- **Postgres**：持久存储，dev-instance 会自动用 Docker 拉一个 `postgres:16-alpine` 容器。

> ⚠️ **5 个进程不是手动各自启动的**。dev-instance 有一个 **supervisor** 统一管理：自动装依赖、构建 web-ui、拉起 Postgres、启动 4 个子进程（core/web/admin/portal）、做健康检查。auth 在 dev 模式下不启动（登录走 `PORTAL_LOCAL_AUTH_BYPASS` 本地旁路）。

---

## 2. 为什么要在 WSL 里跑

QM 的 dev-instance supervisor 用 **Unix domain socket**（`.sock` 文件）做 supervisor↔cli 的进程间通信。在 **Windows 原生 Node 下会报 `EACCES: permission denied`**，全仓库没有任何 Windows 支持代码（只有 `process.platform === "linux"` 特判）。

**必须在 WSL（或任何 Linux/macOS）里跑。** 本文档以 WSL2 + Ubuntu 24.04 为例。

---

## 3. 前置环境检查

| 组件 | 要求 | 检查命令 |
|---|---|---|
| WSL2 | 有 Ubuntu 发行版 | `wsl -l -v` |
| Node.js | v24（对齐 `.node-version`） | `node --version` |
| Docker | daemon 可达 | `docker info` |
| git | 任意新版本 | `git --version` |

### 3.1 WSL 里的 PATH 污染问题（关键坑）

WSL 会把 Windows 的 PATH 追加进来（`/mnt/c/Users/admin/...`），导致 `node`/`npm` 解析到 Windows 侧、或残缺（只有 npm 没有 node）。

**解法**：每次操作前显式把 nvm 的 node bin 放最前：

```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
```

并且**避免用 `bash -lc` 里 source nvm**（常失效），用上面这种直接 export 绝对路径最稳。

---

## 4. WSL 环境准备

### 4.1 安装 nvm + Node 24

```bash
# 装 nvm（如果还没有）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# 装并启用 Node 24
nvm install 24
nvm use 24
node --version   # 应输出 v24.x
```

> ⚠️ **升级 Node 必须走 nvm，切勿 `sudo tar` 手动装到 `/usr/local`**——那会覆盖系统 node 且可能与 nvm 冲突（实测踩过：一个 sudo 安装卡死 3 小时，还差点污染环境）。

### 4.2 确认 Docker 可用

```bash
docker info --format '{{.ServerVersion}}'
```

如果报连不上 daemon：启动 Docker Desktop，然后在 **Settings → Resources → WSL Integration** 勾选你的 Ubuntu 发行版 → Apply & Restart。

---

## 5. 获取代码

```bash
cd ~
git clone https://github.com/yc-software/qm.git qm
cd qm
git checkout main        # 或你需要的分支
```

> ⚠️ **代码必须放在 WSL 文件系统**（`~/` 下），**不要**放 `/mnt/e/...`（Windows 盘挂载）——权限和性能都会出问题。

---

## 6. 安装依赖

```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/qm
npm install
```

实测：约 624 个包，几分钟。如果网络慢可换镜像：`npm config set registry https://registry.npmmirror.com`。

---

## 7. 配置 `.env`

```bash
cp .env.example .env
```

`.env` 里默认 `HARNESS=pi`、`ORG_ID=acme` 已生效。可按需填模型 key（见第 10 节接入自定义模型，或不填先跑 mock）。

---

## 8. 启动实例

### 8.1 三种启动场景

**场景 A：没有模型 key，先 mock 跑通工程链路**

```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/qm
DEV_INSTANCE_ALLOW_MOCK=1 node scripts/dev/cli.ts up --no-slack
```

> ⚠️ **`DEV_INSTANCE_ALLOW_MOCK=1` 必须作为环境变量传给启动命令**，写进 `.env` 或 `dev.env` 都不生效（源码读的是 `spec.callerEnv`）。加 `--no-slack` 表示不起 Slack。

**场景 B：有真实模型 key（含自定义 provider 如 DeepSeek）**

```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/qm
DEV_INSTANCE_IDLE_HOURS=0 ANTHROPIC_API_KEY=sk-ant-dummy-for-pi-harness \
  node scripts/dev/cli.ts up --no-slack
```

- `DEV_INSTANCE_IDLE_HOURS=0`：禁用 8 小时空闲自动回收（见第 11 节，防止闲置后实例自动消失）。
- `ANTHROPIC_API_KEY=sk-ant-...`：**假值即可**，只为让 `assembleEnv` 判定 harness=pi（源码硬编码看这个变量），真实模型走已注册的自定义 provider（见第 10 节）。

### 8.2 首次启动会自动完成的事

supervisor 会自动：
1. 装依赖、构建 web-ui（`vite build`）；
2. 用 Docker 拉 Postgres（`postgres:16-alpine`，端口 55432，容器 `qm-dev-postgres`），并自动 seed 管理员；
3. 启动 core / web / admin / portal 四个子进程并做健康检查。

### 8.3 启动成功的标志

看到类似输出即成功：

```
[ok] dev instance up -- slot pool1 (browser only -- Slack off)
   portal : http://localhost:8129  -> prod-style front door
   core   : http://localhost:8081
   web    : http://localhost:8129/
   admin  : http://localhost:8129/admin/
```

---

## 9. 验证与访问

```bash
# 查看实例状态
node scripts/dev/cli.ts status
# 期望：pool1 live

# 从 WSL 或 Windows 浏览器访问
# portal（助手界面）:  http://localhost:8129/
# 治理台:             http://localhost:8129/admin/
```

验证 HTTP 可达：

```bash
curl -s -o /dev/null -w "portal: %{http_code}\n" http://localhost:8129/
curl -s -o /dev/null -w "admin: %{http_code}\n" http://localhost:8129/admin/
curl -s -o /dev/null -w "core: %{http_code}\n" http://localhost:8081/   # 预期 401（需 portal 签名）
```

- **portal `/` → 200**、**admin `/admin/` → 200**、**core 直连 → 401**（正常，证明 IAP 生效）。
- dev 模式下 `PORTAL_LOCAL_AUTH_BYPASS` 会以 `$USER` 身份自动登录，无需真实认证。

---

## 10. 接入自定义模型（DeepSeek）

QM **原生支持自定义 provider**（协议 `openai` 或 `anthropic`），key 加密存 Postgres。DeepSeek 是 OpenAI 兼容协议。

### 10.1 DeepSeek 模型命名（2026-07 后）

> ⚠️ 旧别名 `deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 停用**。

| 模型 ID | 定位 | 说明 |
|---|---|---|
| `deepseek-v4-flash` | 快、便宜 | 1M 上下文，日常对话首选 |
| `deepseek-v4-pro` | 强推理 | 更贵（约 3x），硬任务用 |
| `deepseek-v4-flash-vision-exp` | 视觉实验 | — |

Base URL：`https://api.deepseek.com`。

### 10.2 注册 provider（admin API）

鉴权要点：**source-auth 签名 + `x-admin-actor` header**。签名用的 `CORE_SIGNING_SECRET` 是确定性生成的，可复现：

```text
secret = sha256Hex("qm-dev\0" + databaseUrl + "\0CORE_SIGNING_SECRET")
databaseUrl = postgres://postgres:qm-dev@127.0.0.1:55432/qm_dev_<sha1(worktree 路径)前12位>
```

> **管理员 principal 是 WSL 的 `$USER`**（如 `zamir`），不是 `dev-admin`。grant 存在 `admin_grants` 表。

最可靠的方式是写一个 Node 脚本，**import 项目自己的签名函数**（`signedRequestHeaders`、`completeDevSecuritySecrets`），避免手写签名出错。脚本放 `~/qm/scripts/` 下（要和源码同树才能 import）：

```js
// scripts/register-deepseek.mjs（用后删除，内含明文 key）
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { completeDevSecuritySecrets } from "../scripts/dev/lib/envctx.ts";

const databaseUrl = "postgres://postgres:qm-dev@127.0.0.1:55432/qm_dev_e19cfa4329dc"; // 见上方规则
const CORE = "http://127.0.0.1:8081";
const ORG = "acme";
const principal = "zamir"; // WSL $USER

const env = {};
completeDevSecuritySecrets(env, databaseUrl);
const secret = env.CORE_SIGNING_SECRET;

const spec = {
  id: "deepseek",
  name: "DeepSeek",
  protocol: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1000000, maxTokens: 16000 },
    { id: "deepseek-v4-pro",   name: "DeepSeek V4 Pro",   contextWindow: 1000000, maxTokens: 16000 },
  ],
  apiKey: "sk-你的key",
  validate: false,   // 跳过端点 /models 校验（若端点无该路由会失败）
};

const corePath = "/v1/admin/custom-providers/deepseek";
const body = JSON.stringify(spec);
const headers = {
  "content-type": "application/json",
  ...signedRequestHeaders(secret, "PUT", corePath, body),
  "x-admin-actor": principal + "@" + ORG,
};
const res = await fetch(CORE + corePath, { method: "PUT", headers, body });
console.log("status:", res.status);
console.log("body:", await res.text());
```

运行后 `status: 200` 即成功，key 加密存储（`hasKey: true`）。

### 10.3 设置 org 默认模型

注册后要把 org 的 runtime 指向 DeepSeek，否则默认仍是 Anthropic 系模型（baseModelDefault 是 `claude-opus-5`）。

```js
// 同上脚本方式，PUT /v1/admin/scopes/org:acme/runtime
const corePath = "/v1/admin/scopes/org%3Aacme/runtime";
const body = JSON.stringify({ harnessId: "pi", modelId: "deepseek-v4-flash" });
```

返回 `{"ok":true,"scopeId":"org:acme","resource":"runtime"}` 即成功。

### 10.4 验证 key 有效性（可选）

直接调 DeepSeek API 确认 key 和模型：

```bash
curl -s https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer sk-你的key" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

能返回 `choices` 即正常。

### 10.5 浏览器验证

打开 `http://localhost:8129/` 发一条消息，agent 会用 `deepseek-v4-flash` 回复。治理台（`/admin/`）里可切换 `flash`/`pro`。

---

## 11. 数据持久化与自动回收

### 11.1 数据存在哪

所有运行时数据（admin grants、DeepSeek provider 含加密 key、runtime 配置、sessions）都存 **Postgres**（Docker 容器 `qm-dev-postgres`，卷 `qm-dev-postgres-data`）。容器一直活着，进程重启/被回收后数据都在。

### 11.2 ⚠️ 8 小时空闲自动回收（默认开启）

dev-instance 的 supervisor 有一个 **`IDLE_HOURS`（默认 8 小时）自动回收**机制：若 8 小时内无活动，supervisor 会 `idle self-teardown` 自己关停并删除运行状态。

**这不是故障**——进程停了但数据没丢，重启即恢复。但闲置会导致实例"消失"（`status` 显示 0 slots、端口 502）。

**禁用方法**：启动时加环境变量 `DEV_INSTANCE_IDLE_HOURS=0`（0 合法，只有 `>0` 才启用回收检查）。见第 8.1 节场景 B 的命令。

---

## 12. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报 `ANTHROPIC_API_KEY is required` | `assembleEnv` 硬编码要求该变量 | 加 `ANTHROPIC_API_KEY=sk-ant-dummy`（假值即可）或 `DEV_INSTANCE_ALLOW_MOCK=1` |
| 加了 `DEV_INSTANCE_ALLOW_MOCK=1` 到 .env 仍报错 | mock 开关读的是启动进程 env，不是 .env | 必须 `DEV_INSTANCE_ALLOW_MOCK=1` 作为命令前缀 |
| 启动报 `EACCES ... supervisor.sock` | 在 Windows 原生跑（Unix socket 不支持） | 必须进 WSL |
| `dev-instance.sh` 报路径 `E:\e\...` | Git Bash 的 `pwd` 输出 MSYS 路径 | 用 `node scripts/dev/cli.ts up` 直调，不走 npm bash 包装 |
| `node` 找不到 / npm 残缺 | PATH 被 Windows `/mnt/c/...` 污染 | `export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"` |
| 端口 502 / status 显示 0 slots | 8 小时空闲自动回收 | 加 `DEV_INSTANCE_IDLE_HOURS=0` 重启 |
| Docker 拉镜像超时 | Docker Hub 间歇性不可达 | 手动先 `docker pull <镜像>:<tag>` 重试命中缓存再 build |
| `execute` 工具不可用 | sandbox 镜像未构建 | `npm run sandbox:local:build` |
| admin API 返回 403 | `x-admin-actor` principal 错误 | 用 WSL `$USER`（如 `zamir`），不是 `dev-admin` |
| core 直连 401 | IAP 要求 portal 签名身份 | 正常，经 portal 访问即可 |

---

## 13. 常用命令速查

```bash
export PATH="/home/zamir/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/qm

# 启动（推荐：禁回收 + 假 Anthropic key 切 pi，走 DeepSeek）
DEV_INSTANCE_IDLE_HOURS=0 ANTHROPIC_API_KEY=sk-ant-dummy-for-pi-harness \
  node scripts/dev/cli.ts up --no-slack

# mock 模式启动（无任何 key）
DEV_INSTANCE_ALLOW_MOCK=1 node scripts/dev/cli.ts up --no-slack

# 查看状态
node scripts/dev/cli.ts status

# 关停
node scripts/dev/cli.ts down

# 环境体检
node scripts/dev/cli.ts doctor --no-slack

# 构建本地 sandbox 镜像（解锁 execute 工具）
npm run sandbox:local:build

# 访问
# portal 助手:  http://localhost:8129/
# 治理台:       http://localhost:8129/admin/
```

---

*本文档基于 Windows 11 + WSL2 Ubuntu 24.04 实测，记录了全部关键坑的规避方法。如有出入，以实际运行环境为准。*

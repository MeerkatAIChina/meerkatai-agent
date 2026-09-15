# QM 单机（Linux arm64）部署文档

> 目标读者：需要在单台 Linux ARM64 服务器上部署 QM（上游 `yc-software/qm`）并接入本地模型的运维/开发者。
>
> 本文档基于 **NVIDIA DGX Spark（Grace CPU，aarch64）+ Ubuntu 24.04.3 LTS** 实测验证。核心结论：**QM 官方发布的镜像只有 amd64，在 arm64 上必须走 QEMU 用户态模拟；同时官方镜像托管在 ghcr.io，国内服务器需要透明代理才能拉取。**

---

## 目录

1. [架构速览](#1-架构速览)
2. [前置环境](#2-前置环境)
3. [部署步骤](#3-部署步骤)
4. [验证与访问](#4-验证与访问)
5. [配置本地模型](#5-配置本地模型)
6. [FAQ](#6-faq)

---

## 1. 架构速览

QM 的 docker target 是单机容器编排，`qm up` 一条命令拉起整套 stack：

```
                    ┌─────────── portal : 8081（登录前门 / IAP，代理 web-ui 和 admin）
                    │              ├── web-ui : 8082（聊天 SPA）
                    │              └── admin : 8083（服务端渲染治理台）
                    └── core : 8080（headless agent core，含 Slack 进程内插件）
                          └── Postgres（Docker 容器 qm-meerkat-pg，数据卷持久化）
                          └── sandbox：本地 Docker 容器（agent 的 execute 沙箱）
```

- **core**：核心，负责 API、身份、策略、调度、agent loop。Harness 用 `pi`。
- **portal**：身份感知代理（IAP），唯一登录入口，向上游服务注入签名身份头。**绕过 portal 直连 core 会 401**。
- **sandbox**：per-scope 的「持久电脑」，agent 跑 `execute` 工具的底层。本地 Docker 模式（`sandbox.backend: "local"`）。
- **Postgres**：持久存储，`qm up` 自动起 `postgres:16` 容器 + 命名卷 `qm-meerkat-pgdata`。

> ⚠️ 本部署跑在 **arm64** 服务器上，而官方镜像全是 **amd64**，所以 core/web-ui/admin/portal/sandbox 实际都在 **QEMU 模拟**下运行。模型推理在 GPU 上（本地 serve），不走 QEMU，不受影响。

---

## 2. 前置环境

| 组件 | 要求 | 检查命令 |
| --- | --- | --- |
| OS | Linux（本文实测 Ubuntu 24.04.3） | `uname -m`（应为 `aarch64`） |
| Node.js | ≥ 24 | `node --version` |
| npm | ≥ 11.10 | `npm --version` |
| Docker | daemon 可达，含 buildx | `docker version && docker buildx version` |
| git / openssl | 任意新版本 | `git --version && openssl version` |
| QEMU binfmt | 能模拟 amd64（见 3.2） | `ls /proc/sys/fs/binfmt_misc/` |
| 网络 | 能访问 ghcr.io 镜像层（见 3.1） | `docker pull ghcr.io/yc-software/qm/core` |

**用户权限**：部署用户需在 `docker` 组（免 sudo 使用 docker）。`qm up` 本身不需要 sudo，只有「给 Docker daemon 配代理」这种系统级操作才需要。

**资源提醒**：本文部署机 121Gi 内存、无 swap，本地模型占了大头后可用约 7Gi。QM 本身（core + web-ui + admin + portal + Postgres）约 1–2Gi，sandbox 按需起，够用但不算宽裕，正式使用前留意内存水位。

---

## 3. 部署步骤

### 3.1 网络准备：透明代理（关键，否则拉不下镜像）

QM 官方镜像在 `ghcr.io/yc-software/qm/*`，其镜像层实际托管在 `pkg-containers.githubusercontent.com`，国内直连会 TLS 超时。**仅给 shell 配 `http_proxy` 不够**——`docker pull` 是 Docker daemon 发起的，daemon 默认不读 shell 的代理环境变量。

实测最省事的方案：**给整机开透明代理（TUN 模式）**，让所有进程（含 Docker daemon）的流量都走代理：

- Clash Verge / Clash：开启 **TUN 模式（虚拟网卡）**。
- 确认 `pkg-containers.githubusercontent.com` 可达（TUN 生效后不再 TLS 超时）：

```bash
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' https://pkg-containers.githubusercontent.com
# 返回 400（连上了）即正常；TLS 超时则说明 TUN 没生效
```

> 备选：给 Docker daemon 单独配代理（写 `/etc/docker/daemon.json` 的 `proxies` 字段，或 systemd drop-in），需要 sudo + 重启 docker。TUN 方案不需要改任何 daemon 配置，推荐。

### 3.2 QEMU / binfmt 准备：arm64 跑 amd64 镜像（关键）

官方镜像只有 amd64，arm64 上靠 QEMU 用户态模拟运行。但 **Ubuntu 24.04 自带的 QEMU 8.2.2 跑 Node 24 会段错误**（见 FAQ-Q4），必须用新版 QEMU 重新注册 binfmt：

```bash
docker run --rm --privileged --platform linux/arm64 tonistiigi/binfmt:latest --install x86_64
```

验证 amd64 Node 能跑：

```bash
docker run --rm --platform linux/amd64 node:24-alpine node --version
# 输出 v24.x 即正常；若报 "QEMU internal SIGSEGV" 或 "exec format error" 则未就绪
```

### 3.3 初始化部署目录

用发布包初始化（源码树里的 manifest 是占位符，必须用发布包才有真实镜像 digest）：

```bash
mkdir -p ~/qm-deploy && cd ~/qm-deploy
npm exec --yes --package=@yc-software/qm@0.1.9 -- qm init . --org meerkat --target docker
npm install
```

### 3.4 修改 `qm.config.jsonc`

`qm init` 生成的默认配置（只含 core+web-ui、sandbox 指向 Fly）不满足内网自托管，需改成：

```jsonc
{
  "contract": 1,
  "orgId": "meerkat",
  "publicUrl": "http://192.168.60.102:8081",
  "target": "docker",
  "services": ["core", "web-ui", "admin", "portal"],
  "plugins": [],
  "skills": [],
  "env": {
    "core": { "HARNESS": "pi", "ADMIN_GRANTS": "meerkat@meerkatai.cn:org_admin" },
    "portal": {
      "OIDC_CLIENT_ID": "qm-internal",
      "OIDC_ALLOWED_EMAILS": "meerkat@meerkatai.cn",
      "NODE_ENV": "development"
    }
  },
  "sandbox": { "backend": "local" }
}
```

改动说明：

| 字段 | 默认值 | 改后 | 原因 |
| --- | --- | --- | --- |
| `publicUrl` | `http://localhost:8082` | `http://192.168.60.102:8081` | 内网地址，端口指 portal |
| `services` | `["core","web-ui"]` | + `admin`、`portal` | admin 配模型需要 portal 作身份入口 |
| `modelProvider` | `"anthropic"` | 删除 | 模型后配，不设 base model |
| `sandbox` | `{ "app": "meerkat-sandboxes" }`（Fly） | `{ "backend": "local" }` | 单机本地 Docker 沙箱，不依赖 Fly |
| `env.core.ADMIN_GRANTS` | 无 | `<邮箱>:org_admin` | 种子第一个管理员 |
| `env.portal.OIDC_CLIENT_ID` | 无 | 任意非占位字符串 | 无 auth 时 portal 的 OIDC 校验要求非空 |
| `env.portal.OIDC_ALLOWED_EMAILS` | 无 | 管理员邮箱 | 信任边界（无 auth 时 portal 强制要求） |
| `env.portal.NODE_ENV` | （镜像内 `production`） | `development` | **绕过 portal 强制 https**（见 FAQ-U1） |

### 3.5 补齐 `.env` 密钥

`qm init` 已自动生成 `CORE_SIGNING_SECRET`、`CAPABILITY_SECRET`、`PORTAL_IDENTITY_SECRET`、`CONNECTOR_SECRET_KEY`、`SKILL_SIGNING_SECRET`。还需手动补三个：

```bash
cd ~/qm-deploy
# PORTAL_SESSION_SECRET / OIDC_CLIENT_SECRET 用随机串
echo "PORTAL_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
echo "OIDC_CLIENT_SECRET=$(openssl rand -hex 32)" >> .env
# PUBLIC_API_URL：本地 sandbox 通过 host-gateway 访问 core 的 8080
echo "PUBLIC_API_URL=http://host.docker.internal:8080" >> .env
```

### 3.6 启动

```bash
cd ~/qm-deploy
npm exec qm -- check        # 校验 config + secret 是否齐全
npm exec qm -- up           # 拉镜像、起 Postgres、起 4 个服务容器
```

`up` 完成标志：

```
✓ core ready
✓ web-ui ready
✓ admin ready
✓ portal ready
✓ stack up — meerkat
   portal : http://localhost:8081
   web-ui : http://localhost:8082
   admin  : http://localhost:8083/admin
   core   : http://localhost:8080
```

---

## 4. 验证与访问

```bash
curl -s -o /dev/null -w 'webui:%{http_code}\n' http://localhost:8082/       # 200
curl -s -o /dev/null -w 'admin:%{http_code}\n'  http://localhost:8083/admin # 200
curl -s -o /dev/null -w 'portal:%{http_code}\n' http://localhost:8081/      # 401（未登录，正常）
```

对外访问地址（把 `localhost` 换成服务器内网 IP）：

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 登录前门 portal | `http://192.168.60.102:8081` | 登录后 `/` 是聊天、`/admin/` 是治理台 |
| web-ui（直连） | `http://192.168.60.102:8082` | 调试用，日常走 portal |
| admin（直连） | `http://192.168.60.102:8083/admin` | 调试用 |

常用运维命令（在 `~/qm-deploy` 下）：

```bash
npm exec qm -- status          # 看容器状态
npm exec qm -- logs core -f    # 看 core 日志
npm exec qm -- down            # 停止（数据卷保留）
npm exec qm -- down --purge    # 停止并删 Postgres 数据卷（⚠️ 删数据）
```

---

## 5. 配置本地模型

本地模型（vLLM 等 OpenAI 兼容服务）监听在宿主机 `0.0.0.0:8000`。进 admin → Model provider 配 custom provider：

- **baseUrl**：`http://192.168.60.102:8000/v1`
- **协议**：`openai`（DeepSeek 等是 OpenAI 兼容协议）
- **模型 ID**：用 vLLM 实际 serve 的（如 `deepseek-v4-flash` / `deepseek-v4-pro`）

> ⚠️ **baseUrl 不要填 `127.0.0.1`**——那会指向 QM 容器自己，而不是宿主机。要填宿主机内网 IP。

---

## 6. FAQ

### 6.1 部署

**Q1：`docker pull ghcr.io/yc-software/qm/core` 卡住 / TLS 握手超时**

镜像层托管在 `pkg-containers.githubusercontent.com`，国内直连被墙。症状：`docker pull` 卡在「Retrying」或报 `TLS handshake timeout`。解决：开整机透明代理（TUN 模式），或给 Docker daemon 配代理。详见 3.1。

**Q2：shell 里能访问外网，但 `docker pull` 就是不通**

Docker daemon 不读 shell 的 `http_proxy`/`https_proxy` 环境变量。开 TUN 透明代理（接管全系统流量）可一步解决；否则需改 `/etc/docker/daemon.json` 或 systemd drop-in 给 daemon 配代理并重启。

**Q3：arm64 服务器跑官方镜像报 `exec format error` / 找不到匹配的 manifest**

官方 `@yc-software/qm` 镜像只有 **amd64**，arm64 上需要 QEMU binfmt 模拟。先按 3.2 用 `tonistiigi/binfmt` 注册 `x86_64`。

**Q4：core 容器日志报 `x86_64-binfmt-P: QEMU internal SIGSEGV`**

Ubuntu 24.04 自带的 QEMU 8.2.2 默认模拟 `qemu64` CPU（特性最少的 x86_64），不支持 Node 24 的 x86-64-v2 指令集，跑复杂二进制会段错误。解决：用 `tonistiigi/binfmt`（自带支持 `linux/amd64/v2` 的新版 QEMU）重新注册 binfmt。验证方式见 3.2 末尾。

**Q5：portal 容器启动后立即退出，日志报 `PORTAL_PUBLIC_URL must be https in production`**

portal 在 `NODE_ENV=production` 下强制 https。内网 http 部署时，把 `env.portal.NODE_ENV` 设为 `development`（见 3.4），跳过这条生产检查。副作用：portal 的 session cookie 不再是 `Secure`（http 下本就该如此）。

**Q6：`qm check` 报一堆 required secret 为空（OIDC_*、PORTAL_SESSION_SECRET、PUBLIC_API_URL）**

加 `portal` 服务后新增了一批 required secret，`qm init` 不生成它们。按 3.5 手动补 `PORTAL_SESSION_SECRET`、`OIDC_CLIENT_SECRET`、`PUBLIC_API_URL`；`OIDC_CLIENT_ID` 和信任边界（`OIDC_ALLOWED_EMAILS`）配在 `env.portal` 里而不是 `.env`。

### 6.2 使用

**U1：管理员登录为什么是「一次性链接」而不是用户名密码？**

现阶段没有配置任何 IdP（邮件 broker / Slack / 外部 OIDC），唯一登录方式是 `qm admin-login` 生成的一次性链接（5 分钟有效、用一次失效），它用 `PORTAL_SESSION_SECRET` 直接签会话，绕过 OIDC。**且 `qm admin-login` 命令本身拒绝非 localhost 的 http 地址**（要求 https 或 localhost），内网 http 部署需要按下面的脚本手动生成链接：

```js
// 服务器上 node 脚本：手动生成 admin-login 链接（aud 指向内网 http 地址）
const { createHmac, randomBytes } = require("crypto");
const fs = require("fs");
const env = fs.readFileSync("/home/meerkat/qm-deploy/.env", "utf8");
const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
const secret = get("PORTAL_SESSION_SECRET");
const email = "meerkat@meerkatai.cn";
const origin = "http://192.168.60.102:8081";
const now = Math.floor(Date.now() / 1000);
const payload = { k: "admin-login", sub: email, aud: origin, iat: now, exp: now + 300, jti: randomBytes(18).toString("base64url") };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const key = createHmac("sha256", secret).update("portal.admin-login.v1").digest();
const sig = createHmac("sha256", key).update(body).digest("base64url");
console.log(origin + "/auth/admin-login#token=" + body + "." + sig);
```

**U2：点 Sign in 报 `{"error":"forbidden"}`，开发者工具里 `Origin: null`、没有 `Sec-Fetch-Site`**

这是 portal 的跨源检查（`sameOriginRequest`）拒绝了 POST。典型诱因是**访问内网 IP 时走了代理**（Clash/VPN），代理剥离/改写了请求头。先关代理或给代理加内网直连规则（`IP-CIDR,192.168.0.0/16,DIRECT`）。若仍 `Origin: null`，兜底做法是：**用 curl/Node 在服务器本地完成登录拿到 `portal_session` cookie，再手动注入浏览器**（开发者工具 → Application → Cookies 添加 `portal_session`），即可访问 `/admin/`。

**U3：普通用户（非管理员）登录不了**

原因：没有配置 IdP。portal 的 OIDC 是占位配置（`OIDC_CLIENT_ID=qm-internal`、issuer 默认指向 slack.com），没有任何真实身份提供商，所以只有 admin-login 能进管理员，普通成员无法自助登录。要支持成员登录，二选一：

1. 启用内置 **auth** 邮件 broker（services 加 `"auth"`，配 SMTP/Resend + `AUTH_ALLOWED_EMAILS`）；
2. 接外部 **OIDC**（Google Workspace / 企业 IdP，配 `env.portal` 的 OIDC endpoint + client id/secret）。

**U4：目前哪些功能没上？**

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 管理员登录 | ✅ 可用 | admin-login 一次性链接 |
| 普通成员登录 | ❌ 未配置 | 缺 IdP（见 U3） |
| 邮件登录（auth broker） | ❌ 未启用 | services 里没有 `auth` |
| Slack bot（agent 进 Slack 工作区） | ❌ 未启用 | 无 Slack token |
| Slack / 外部 OIDC 登录 | ❌ 未配置 | portal OIDC 是占位 |
| 成员邀请 / 自助注册 | ❌ 未配置 | 依赖邮件或 IdP |
| 自定义模型 | ✅ 可配 | admin → Model provider（见第 5 节） |
| agent 沙箱（execute） | ✅ 可用 | 本地 Docker，QEMU 模拟 amd64，较原生慢 |

---

*本文档基于 NVIDIA DGX Spark（aarch64）+ Ubuntu 24.04.3 实测，记录了 arm64 单机部署的关键坑与规避方法。如有出入，以实际运行环境为准。*

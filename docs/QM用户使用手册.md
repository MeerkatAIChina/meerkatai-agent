# QM 用户使用手册

> 面向本机部署的使用者（DeepSeek 模型、`zamir` 管理员、组织 `org:acme`）。
> 两个入口：
> - **web-ui**（和 agent 干活的地方）：`http://localhost:8129/`
> - **admin**（治理和管理的地方）：`http://localhost:8129/admin/`

---

## 核心概念：先分清两个入口

| | web-ui | admin |
|---|---|---|
| 给谁用 | **你和 agent 日常协作** | **管理员治理整个系统** |
| 能做什么 | 聊天、建任务、管文件、设自动化、看 agent 产出的应用 | 管用户/权限/模型/安全策略/审计，看全局运行状况 |
| 谁能进 | 组织内每个成员 | 只有管理员（本地就是 `zamir`） |

**贯穿两个入口的关键概念：scope（作用域）**
- `personal:zamir` —— 你的个人空间：你的对话、你的文件、你的自动化；
- `org:acme` —— 组织空间：全员共享的配置（默认模型、安全策略、技能库等）。
- web-ui 里你基本只在个人空间干活；admin 里很多页面要**切到 org scope** 才是全局配置（切换方法见 admin 章节）。

---

# 第一部分：web-ui（和 agent 协作）

界面结构：左侧是导航栏 + 会话列表，右侧是主工作区。

## 1. New chat / Chats（聊天）

- **New chat**：开一个新对话。每次对话是一个独立 session，agent 在里面有完整的上下文记忆。
- **Chats**：历史对话列表。左侧 SESSIONS 区按时间分组（TODAY 等），点击即回到该对话。
- 对话中可以直接用自然语言派活：写代码、查资料、跑数据分析、定时提醒、做小工具/网页、操作 GitHub 等。
- **"2 tool calls"** 这样的可展开项：agent 执行了工具（跑命令、读写文件、调 API 等），点开能看到它具体做了什么。这是理解 agent 行为最重要的入口。
- **WEB ONLY 开关**（SESSIONS 右上角）：打开后只显示从网页发起的会话，过滤掉来自 Slack 等其他渠道的会话（本地没开 Slack，基本无差别）。

## 2. Projects（项目）

多人协作的共享空间（目前单人本地用得少，但要知道它是什么）：

- 一个 Project = 一个共享的会话上下文，可以拉其他成员进来；
- Project 里的对话、文件、自动化对成员共享；
- 每个 Project 可以关联 Slack channel（生产环境用）。

**什么时候用**：想让多人 + agent 围绕同一件事协作（共享上下文和文件）时，建 Project；纯个人任务直接 Chats 就行。

## 3. Files（文件）

agent 的工作文件区（每个 scope 一份）：

- 你可以**上传**文件给 agent 用（对话里也能直接传附件）；
- agent 产生的文件（代码、生成的文档、导出结果）也在这里，可下载；
- agent 在对话里读写文件，操作的就是这个空间。

## 4. Crons（定时任务）

让 agent **定时自动干活**：

- 在对话里直接说"每天早上 9 点帮我汇总 xxx"，agent 会创建 cron；
- 这里能看到所有定时任务：计划、下次执行时间、最近结果；
- 可以在这里暂停/删除任务。

## 5. Webhooks（网络钩子）

让**外部事件触发 agent**：

- 创建一个 webhook 后会得到一个专属 URL；
- 外部系统往这个 URL POST 一条消息（如告警、表单提交、CI 事件），agent 就会被触发并处理；
- 典型用途：把第三方系统的通知接进来让 agent 处理。

## 6. Keychain（钥匙串）

**凭据保管箱**（每个 scope 一份）：

- 存放 agent 需要的敏感凭据（API key、账号密码、token）；
- 存入后 agent 可以"使用"这些凭据调外部服务，但**对话里看不到明文**（设计上凭据不进聊天记录）；
- 典型用法：对话里让 agent 接入某个需要登录的服务，它会引导你通过安全的表单填入凭据（进 Keychain），而不是直接把密码发在聊天里。

## 7. Apps（应用）

agent **发布出来的可运行应用**：

- 让 agent"做一个网页/小工具"，它写完后可以 `publish` 发布，产出一个可访问的应用；
- 这里列出所有发布的应用及其运行状态；
- 点击可打开应用或管理它的生命周期。

## 8. Memory（记忆）

**agent 的长期记忆**（每个 scope 一份）：

- agent 会把跨对话需要记住的东西写在这里（你的偏好、背景、约定）；
- 你可以**直接编辑**这段文本——想让 agent 永远记住某件事（称呼、习惯、规则），写进去 Save 即可；
- 个人 scope 的记忆只影响你自己的对话。

## 9. Skills（技能）

**agent 的能力扩展包**：

- 每个 skill 是一份说明书（SKILL.md），教 agent 某类任务的标准做法；
- 本地 org 里已预装 21 个技能（技能包注册在 admin 侧，见第二部分）；
- agent 执行任务时会自动匹配相关技能，你也可以在对话里让它"用 xx 技能做 xx"。

## 10. Admin（底部入口）

跳转到 admin 治理台（第二部分）。管理员才进得去。

---

# 第二部分：admin（治理台）

界面结构：左侧分区导航 + 右侧内容区。顶栏显示当前组织和身份。

> **最重要的操作习惯**：admin 里很多页面受 **scope** 影响。如果发现"配置项不全/只看到自己的东西"，多半是 scope 停在个人（如 `Zamir`）——切到 org 即可（方法见下）。

## 切换 scope（必须先掌握）

- **方法 1（最快）**：直接改地址栏，如
  `http://localhost:8129/admin/governance?scope=org%3Aacme`
- **方法 2**：左侧点 **Sessions**（会强制 scope 回到 org），再点 **Governance**；
- 判断当前 scope：看页面右上角的 `SCOPE xxx` 胶囊——显示 **All scopes** 就是 org，显示人名就是个人。
- 注意：SCOPE 胶囊本身只是标签，**不可点击**。

## 分区导航详解

### ADMIN 区

| 页面 | 用途 |
|---|---|
| **Sessions** | 全组织所有会话的总览。点进任意会话可看完整对话记录、agent 的每一步工具调用、LLM 请求细节（模型、耗时、token）。排查"agent 为什么这么回"就在这里。 |
| **Slack** | Slack 集成管理（安装、channel 映射）。本地没启用 Slack（`--no-slack` 启动），此页基本空置。 |
| **Judgments** | agent 的"自主判断"记录：它对环境/消息做出的自动化决策（如 ambient 触发判断）。用于审查 agent 自作主张的行为。 |

### ARTIFACTS 区（agent 产出的东西，全局视角）

| 页面 | 用途 |
|---|---|
| **Files** | 所有 scope 的文件区总览（对应 web-ui 的 Files，但可跨 scope 查看）。 |
| **Skills** | **技能包管理**。在顶部输入框粘贴一个 git 仓库 URL（内含 SKILL.md），点 **Register** 即可为一组技能注册进 org。org 下当前有 21 个技能。给 agent 加新能力就在这里。 |
| **Memory** | 跨 scope 编辑 agent 记忆（对应 web-ui 的 Memory，但可切 scope 编辑任意空间的记忆）。 |
| **Deployments** | 所有已发布应用（web-ui 的 Apps）的管理视图：状态、日志、启停。 |
| **Crons** | 全组织的定时任务总览（可跨 scope 看到所有人建的 cron）。 |

### SYSTEM 区

| 页面 | 用途 |
|---|---|
| **Metrics** | 运行仪表盘：模型调用量、延迟（TTFT/总时长）、token 用量、费用等。判断"模型用得贵不贵、慢不慢"看这里。 |

### ADMIN 区（治理核心）

| 页面 | 用途 |
|---|---|
| **Onboarding** | 用户引导状态管理（哪些成员还没完成上手）。 |
| **Governance** | **整个系统最核心的治理页**，详见下节。 |
| **Connectors** | 外部服务连接器（OAuth 授权类，如 Google）。给 agent 授权访问第三方服务。 |
| **Users** | 成员/身份目录管理。 |
| **Keychain** | 全组织凭据保管的总视图（web-ui 的 Keychain 是个人的，这里是管理员视角）。 |
| **Egress** | **出网白名单策略**：控制 agent（沙箱）能访问哪些外部域名。加白/禁域名在这里。 |
| **Audit** | 管理操作审计日志（谁在什么时候改了什么配置）。 |

### INSIGHTS 区

| 页面 | 用途 |
|---|---|
| **Retention** | 数据保留策略（org 级，当前版本置灰/受限）。 |

## Governance（治理页）重点展开

这是**模型、安全、自动化边界**的配置中心，也是你接入 DeepSeek 时打交道最多的页面。页面右上角显示当前 scope；**切到 `org:acme`** 后主要配置：

### Effective state（生效状态总览）
页面顶部一眼看到当前生效的关键治理状态（自主级别/安全姿态等）。

### Models & browsing（模型配置——本机已配好的都在这）
- **Runtime**：默认 harness + 默认模型。本机当前是 `pi + deepseek-v4-flash`；
- **Web UI model picker**：网页端可选择的模型白名单。本机已启用 `deepseek-v4-flash` 和 `deepseek-v4-pro`，改完记得点 **Save**；
- 修改模型白名单后，web-ui 聊天框的模型选择器即可选到对应模型。
- ⚠️ 这两项都是 **org 级**配置——个人 scope 下看不到 Web UI model picker 卡片。

### 其他治理项
- **Security posture / Autonomy**：agent 自主权限级别（哪些操作要审批、哪些直接执行）；
- **Command policy**：命令策略（允许/拦截特定命令）；
- **Egress**：出网域名白名单（同左侧 Egress 页）；
- **Approved harnesses**：允许使用的 harness 列表。

---

# 附录 A：常见任务怎么做

| 任务 | 操作路径 |
|---|---|
| 和 agent 聊天 | web-ui → New chat → 直接说 |
| 让 agent 记住一件事 | web-ui → Memory → 编辑 → Save（或直接在对话里说"记住…"） |
| 给 agent 新能力（技能） | admin → Skills → 粘贴 git 仓库 URL → Register |
| 定时任务 | web-ui → 对话里直接说"每天 xx 点做 xx" → Crons 里管理 |
| 换默认模型 | admin → Governance（org scope）→ Models & browsing → Runtime |
| 网页端可选哪些模型 | admin → Governance（org scope）→ Web UI model picker → 加/减模型 → Save |
| 看 agent 某次回复为什么是这样 | admin → Sessions → 找到会话 → 看对话记录 + tool calls + LLM 请求 |
| 控制 agent 能上哪些网 | admin → Egress → 加白/禁域名 |
| 查谁改过配置 | admin → Audit |
| 看模型用量/费用 | admin → Metrics |

# 附录 B：本机环境速查

| 项 | 值 |
|---|---|
| 组织 | `org:acme` |
| 管理员 | `zamir`（个人空间 `personal:zamir`） |
| harness / 默认模型 | `pi` / `deepseek-v4-flash` |
| web 可选模型 | `deepseek-v4-flash`、`deepseek-v4-pro` |
| 模型 provider 注册处 | Postgres `custom_model_providers` 表（key 加密存储，admin API 管理） |
| web-ui | `http://localhost:8129/` |
| admin | `http://localhost:8129/admin/` |
| 直连 core | `http://localhost:8081`（401 正常，必须经 portal） |
| 启动/停止 | 见《QM本地开发部署文档.md》第 13 节 |

# 附录 C：排错速记

| 现象 | 原因与处理 |
|---|---|
| 发消息报 403 "that model is not enabled for the web UI" | 所选模型不在 Web UI model picker 白名单 → Governance（org）→ Models & browsing 加进去 |
| Governance 里看不到模型配置卡片 | scope 停在个人 → 切到 org（见"切换 scope"） |
| 页面配置项比预期少 | 同上，多数页面 scope 决定内容 |
| agent 说没有某工具/能力 | 对应 skill 未注册或权限未开（Skills / Governance） |

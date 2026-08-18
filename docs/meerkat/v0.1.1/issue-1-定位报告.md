# Issue 1 定位报告：Create skill 报 Internal server error

> 状态：**当前构建无法复现**，建议真机回归后关闭。
> 日期：2026-08-18 · 分支：feature/meerkat · 执行：Task 15

## 原始现象

v0.1 桌面版真机测试期间，Skills 页「New skill」填表提交后报 Internal server error（500）。

## 复现环境与方法

复现脚本：`deploy/layers/meerkat/desktop/scripts/repro-issue1.ts`

- 从当前 payload 直接起 core（`HARNESS=pi`、`SESSION_STORE=sqlite`、`SANDBOX_BACKEND=none`），用 HMAC source-auth + 自签 portal identity（`meerkat-desktop`，org_admin）直调 core 的 `POST /v1/skills`——与 web-ui 代理路径（`plugins/web-ui/server/index.ts:1350-1369`）等价。
- 跑了两种数据目录：
  1. 全新空 DATA_DIR
  2. **真机桌面版实际数据目录**（`%APPDATA%/com.meerkat.desktop`，含已导入的 TRIZ skill pack 与真实会话状态）

## 结果

| 请求组合 | 结果 | 说明 |
|---|---|---|
| 无 scopeId | 201 | 创建成功，status=published |
| scopeId=personal:meerkat-desktop（桌面 UI 实际发送值） | 201 | 创建成功 |
| scopeId=org:meerkat | 403 | 「不能在 org/team 域创建」——正确的业务拒绝，非 500 |
| 同名重复创建 | 409 | 「已存在，请改为编辑」——正确的冲突响应，非 500 |

真机数据目录下的复现 skill 已通过 `DELETE /v1/skills/:id` 清理（均 200）。

## 结论

当前构建（含 v0.1.1 全部 core 改动）下，创建 skill 的四个分支全部返回正确状态码，**500 无法复现**。原 500 大概率来自旧构建（v0.1 时代 core），在 v0.1.1 的 core 合并 / sqlite 存储工作中已被覆盖修复。

## 后续

- Task 16 真机验收时在新安装包上回归一次「New skill」流程；通过则关闭 Issue 1。
- 若真机仍复现，第一时间抓 `%APPDATA%/com.meerkat.desktop/logs/core.log` 中 `[server] 500 POST /v1/skills:` 的堆栈（每次启动日志会重置，需当场抓取），再按执行计划 Task 15 Step 3 的可疑点排序排查。

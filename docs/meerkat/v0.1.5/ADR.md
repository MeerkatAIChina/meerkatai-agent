# ADR: 桌面版文件 Artifact 持久化采用 SQLite

## 背景

桌面版 Meerkat 启动 core 时使用 `SESSION_STORE=sqlite`，但 `fileArtifactStore` 在没有 `DATABASE_URL` 时回退到 `createMemoryFileArtifactStore`。结果文件元数据只存在于 core 进程内存中，应用重启后「文件」面板为空（issue #34）。

## 决策

新增 `src/files/sqlite-file-artifact-store.ts`，通过 `ARTIFACT_STORE=sqlite` 启用，元数据写入与 session store 同一个 SQLite 文件（`%APPDATA%\com.meerkat.desktop\meerkat.db`）。

## 理由

### 为何选 SQLite

- 桌面版是单用户、离线场景，不需要外部 Postgres。
- SQLite 零配置、单文件、易备份，与桌面版定位匹配。
- 文件字节已经通过 `createLocalDurableByteStore` 落在本地 `docstore/files/<sha256>`，只需要持久化元数据注册表。

### 为何与 Session Store 共用同一个 DB 文件

- 减少桌面版需要管理的文件数量。
- 备份/迁移时一个文件即可带走会话和文件元数据。
- session store 的 SQLite 路径解析逻辑已经存在，复用避免重复配置。

### 为何 SQLite Schema 与 Postgres 版对齐

- `src/files/postgres-file-artifact-store.ts` 已经定义了生产环境的 schema。
- 对齐后，未来从桌面版 SQLite 迁移到 Postgres 时字段一致。
- 保留 `kind` 等当前接口未使用的字段，避免未来扩展时需要迁移 SQLite 数据。

### 为何 `ARTIFACT_STORE=sqlite` 与 `DATABASE_URL` 互斥

- `SESSION_STORE=sqlite`  already 与 `DATABASE_URL` 互斥，因为 session 和 lock 必须共享后端。
- file artifact 元数据与会话/lock 一样，需要与同一进程内的其他持久化状态保持一致后端。
- 互斥规则简单，避免用户配置出 session 在 Postgres、artifact 在 SQLite 的混合状态。

## 取舍

- **不迁移已有内存数据**：首次升级后，历史生成的文件元数据会丢失。聊天消息里可能仍显示附件芯片，但点击下载会失败。这是可接受的，因为桌面版此前没有持久化，且迁移内存数据没有可靠来源。
- **不回退到 memory**：当 `ARTIFACT_STORE=sqlite` 但 `sqlitePath` 无法打开时，core 启动直接报错。快速失败避免用户误以为持久化已生效。

## 实现概要

1. `src/files/sqlite-file-artifact-store.ts`：基于 `node:sqlite` 实现 `FileArtifactStore`。
2. `src/config.ts`：新增 `artifactStore` 配置，放宽 `sqlitePath` 解析，移除 `ARTIFACT_STORE=sqlite` 的禁止。
3. `src/wiring.ts`：按 `databaseUrl → sqlite → memory` 路由 `fileArtifactStore`。
4. `deploy/layers/meerkat/desktop/src-tauri/src/proc.rs`：core 启动时设置 `ARTIFACT_STORE=sqlite`。

## 后果

- 桌面版生成的文件在重启后仍可在「文件」面板查看。
- 现有 Postgres SaaS 部署行为不变。
- 开发者本地未设置 `ARTIFACT_STORE` 时仍为 memory，行为不变。

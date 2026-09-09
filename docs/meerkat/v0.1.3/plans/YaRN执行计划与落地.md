# Meerkat-TRIZ-v1 YaRN 1M 上下文扩展落地实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将生产 vLLM 容器的上下文从 256K 扩展到 1M（YaRN），并验证启动成功、无 OOM。

**Architecture:** 原地改参数重启（方案 B）——停旧容器（**保留不删**）→ 起新容器（`-1m` 后缀）→ 验证；失败则 `docker start` 旧容器回滚。本机 121G 统一内存无法同时跑两个 vLLM 实例（第二份权重 27.71G + 第二份 KV 池 66G 放不下），故必须停旧起新。

**Tech Stack:** vLLM v0.25.0（Docker，镜像 `m.daocloud.io/docker.io/vllm/vllm-openai:v0.25.0`）、Qwen3.6-35B-A3B（NVFP4-Fast）+ LoRA `Meerkat-TRIZ-v1`

---

## 前置决策点（执行前需确认）

| # | 决策点 | 默认值 | 说明 |
|---|--------|--------|------|
| 1 | **停生产授权** | 待确认 | 中断窗口预计 10~30 分钟（模型加载 179s + CUDA graph 捕获 15s + 验证） |
| 2 | 验证深度 | 最小验证（起来 + 不 OOM） | 长文召回测试（needle-in-a-haystack）可后续单独做 |
| 3 | 并发/batch 参数 | `--max-num-seqs 16` + `--max-num-batched-tokens 32768` | 1M 场景 ~7 路并发够用；batch 调大加速长 prefill |

## 风险与回滚

- **风险**：改参数后启动失败或 OOM（理论不会——官方背书 + KV 池 66G 实测够 7 路 1M，但需一次实测坐实）。
- **回滚**：旧容器只 `stop` 不 `rm`，失败时 `docker start meerkat-triz-vllm-nvfp4-v2` 即可恢复 256K 服务（秒级）。
- **敏感信息**：`VLLM_API_KEY` 全程不回显明文，执行时从旧容器 `docker inspect` 读取后复用。

---

### Task 1: 备份旧容器启动配置

**目的**：留一份可回滚的完整启动命令。

**命令**：

```bash
docker inspect meerkat-triz-vllm-nvfp4-v2 --format '{{json .Args}}' > /home/meerkat/vllm-backup-256k.args
docker inspect meerkat-triz-vllm-nvfp4-v2 --format '{{json .HostConfig.Binds}}' > /home/meerkat/vllm-backup-256k.binds
```

**预期**：两个备份文件生成成功。

---

### Task 2: 停旧容器（保留不删）

**命令**：

```bash
docker stop meerkat-triz-vllm-nvfp4-v2
```

**预期**：容器停止，`docker ps -a` 中状态为 `Exited`（仍保留，可回滚）。释放 8000 端口 + ~100G 显存。

---

### Task 3: 起新容器（1M 参数）

**命令**（在旧容器参数基础上改 4 处，其余原样）：

```bash
docker run -d \
  --name meerkat-triz-vllm-nvfp4-v2-1m \
  --network host \
  --gpus all \
  --restart unless-stopped \
  -e VLLM_API_KEY=<复用旧容器同值> \
  -e VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 \
  -v /home/meerkat/.cache/modelscope/models/unsloth--Qwen3.6-35B-A3B-NVFP4-Fast/snapshots/master:/models/base:ro \
  -v /home/meerkat/.cache/modelscope/models/ujDesign--Meerkat-TRIZ-v1/snapshots/master:/models/adapter:ro \
  m.daocloud.io/docker.io/vllm/vllm-openai:v0.25.0 \
  /models/base \
  --served-model-name Qwen3.6-35B-A3B-NVFP4-Fast \
  --host 0.0.0.0 --port 8000 --trust-remote-code \
  --dtype float16 \
  --attention-backend TRITON_ATTN --moe-backend marlin --linear-backend cutlass \
  --generation-config auto \
  --override-generation-config '{"temperature": 0.6, "top_p": 0.95, "repetition_penalty": 1.05, "max_new_tokens": 81920}' \
  --max-model-len 1010000 \
  --gpu-memory-utilization 0.83 \
  --hf-overrides '{"text_config":{"rope_parameters":{"mrope_interleaved":true,"mrope_section":[11,11,10],"partial_rotary_factor":0.25,"rope_theta":10000000,"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":262144}}}' \
  --max-num-batched-tokens 32768 \
  --max-num-seqs 16 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --enable-lora --lora-modules Meerkat-TRIZ-v1=/models/adapter --max-lora-rank 64 \
  --limit-mm-per-prompt '{"image": {"count": 3, "width": 1280, "height": 1280}, "video": {"count": 1, "num_frames": 32, "width": 512, "height": 512}}' \
  --media-io-kwargs '{"video": {"video_backend": "opencv", "num_frames": 32, "fps": 2}}' \
  --mm-processor-kwargs '{"do_sample_frames": false}'
```

> ⚠️ **注意**：镜像 ENTRYPOINT 已是 `["vllm","serve"]`，docker run 参数里**不要**再写 `serve`，直接以 `/models/base` 开头（否则会变成 `vllm serve serve /models/base` 报错）。

**改动清单（相对旧容器）**：

| 参数 | 旧值 | 新值 | 原因 |
|------|------|------|------|
| `--max-model-len` | 262144 | **1010000** | 放开 1M 上下文 |
| `--hf-overrides` | 无 | 注入 `rope_type=yarn, factor=4.0` | 启用 YaRN（保留 mRoPE 分片） |
| `VLLM_ALLOW_LONG_MAX_MODEL_LEN` | 无 | `1` | 允许超过原生 max |
| `--max-num-seqs` | 64 | **16** | 1M 场景降并发，减 CUDA graph 开销 |
| `--max-num-batched-tokens` | 8192 | **32768** | 长 prefill 从 123 步降到 ~31 步 |

---

### Task 4: 验证启动成功

**命令**（等待模型加载完成后执行，约 3~4 分钟）：

```bash
docker logs meerkat-triz-vllm-nvfp4-v2-1m 2>&1 | grep -iE 'max_model_len|Available KV cache|KV cache size|Maximum concurrency|error|out of memory|OOM'
```

**预期（全部命中才算通过）**：

| 检查项 | 预期日志 |
|--------|----------|
| 上下文长度 | `max_seq_len=1010000` |
| KV 池不变 | `Available KV cache memory: ~66 GiB` |
| 1M 并发 | `Maximum concurrency for 1,010,000 tokens per request: ~6.x` |
| 无 OOM | 无 `out of memory` / `CUDA error` |

---

### Task 5: 长文冒烟测试（可选，决策点 2 选"完整"时执行）

**命令**：

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen3.6-35B-A3B-NVFP4-Fast","messages":[{"role":"user","content":"<300K+ token 文档，末尾夹一个问题>"}],"max_tokens":64}'
```

**预期**：能正确召回 >256K 距离的答案（证明 YaRN 长文生效）。

---

### Task 6: 回滚（仅当 Task 4/5 失败时执行）

**命令**：

```bash
docker rm -f meerkat-triz-vllm-nvfp4-v2-1m
docker start meerkat-triz-vllm-nvfp4-v2
```

**预期**：旧容器按原 256K 配置恢复服务（秒级）。

---

## 收尾（验证通过后）

1. 若 1M 稳定运行，可 `docker rm meerkat-triz-vllm-nvfp4-v2`（清理旧容器），并把新容器改名/作为新生产基线。
2. 同步 qm 侧 provider：`contextWindow` 262144 → 1010000（见调研文档第 4 章第 3 层），否则 output-budget guard 仍会钳制输出。

---

## 执行结果与配置变更台账

### 执行结果（最小验证通过）

| 检查项 | 实测值 | 结果 |
|--------|--------|------|
| 上下文长度 | `max_seq_len=1010000` | ✅ |
| YaRN 启用 | `rope_type=yarn, factor=4.0`（mRoPE `[11,11,10]` 保留） | ✅ |
| KV 池 | 62.59 GiB = 6,520,226 tokens | ✅ |
| 1M 并发 | 6.46x | ✅ |
| OOM/错误 | 无 | ✅ |

> KV 池实测 62.59 GiB 略小于计划的 ~66 GiB，因 `--max-num-seqs 64→16`、`--max-num-batched-tokens 8192→32768` 改变了 CUDA graph 捕获范围与 profile，不影响 1M 容量（仍够 6.5 个 1M）。

### 实际配置变更台账

**vLLM 推理侧（5 处）**：

| # | 配置项 | 作用 | 改前 | 改后 | 性质 |
|---|---|---|---|---|---|
| 1 | `--max-model-len` | 单请求最大 token 上限（prompt+输出），超了拒绝/截断 | 262144 | **1010000** | ✅ 必需 |
| 2 | `--hf-overrides` | 加载时覆盖 config，启用 YaRN 位置编码外推 | 无 | `rope_type=yarn, factor=4.0, original_max_position_embeddings=262144` | ✅ 必需 |
| 3 | `VLLM_ALLOW_LONG_MAX_MODEL_LEN`（env） | 放开「超过原生上下文」的限制 | 未设 | **=1** | ✅ 必需 |
| 4 | `--max-num-seqs` | 并发序列数上限 | 64 | **16** | 🔧 优化 |
| 5 | `--max-num-batched-tokens` | chunked prefill 分块大小 | 8192 | **32768** | 🔧 优化 |

**qm 侧 provider**：

| 配置项 | 改前 | 改后 |
|---|---|---|
| `contextWindow` | 262144（256K） | **1010000（1M）** |

**运维层面**：

| 项 | 改前 | 改后 |
|---|---|---|
| 容器名 | `meerkat-triz-vllm-nvfp4-v2` | `meerkat-triz-vllm-nvfp4-v2-1m`（旧容器保留 stopped，可回滚） |

**保持不动**：

| 配置项 | 值 | 原因 |
|---|---|---|
| `--gpu-memory-utilization` | 0.83 | KV 池够 6.5 个 1M，无需调 |
| `--max_new_tokens` | 81920 | 输出上限，与「1M 输入」无关 |

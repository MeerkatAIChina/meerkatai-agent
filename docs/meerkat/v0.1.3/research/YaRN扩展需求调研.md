# Meerkat-TRIZ-v1 上下文扩展至 1M 可行性调研（YaRN）

> 日期：2026-09-09
> 结论：**方向可行，官方明确支持**。基座 Qwen3.6-35B-A3B 原生 256K，官方声明可经 YaRN 扩展至 1,010,000 tokens。但本模型的 mRoPE（3D 位置编码）与混合注意力架构，决定了启用方式与内存账必须按"实测配置"重新核算，不能照搬 Qwen3-Next 的写法。

---

## 一、结论先行

| 维度 | 结论 | 依据 |
|------|------|------|
| 是否可行 | ✅ **可行，官方背书** | Qwen3.5/3.6 官方模型卡明写"extensible up to 1,010,000 tokens via YaRN" |
| 启用路径 | 必须走 `--hf-overrides` + `text_config.rope_parameters`（**不是** `--rope-scaling`） | 本模型 `model_type=qwen3_5_moe`，走 mRoPE 路径；`--rope-scaling` 是 Qwen3-Next（`qwen3_next`）的旧路径 |
| 最大难点 | ① mRoPE 分片要保留；② **内存紧**（可用仅 7GB）；③ 静态 YaRN 牺牲短文本 | 见下文实测 |
| 是否需要重训 LoRA | **不需要**。YaRN 是零样本推理侧扩展，与 LoRA（r=64 领域适配）正交 | LoRA 只改投影权重，不改 RoPE |
| qm 侧是否要改 | **必须改**：provider 的 `contextWindow` 与 `maxTokens` | 当前注册值 `contextWindow=262144 / maxTokens=8192` |

---

## 二、模型与部署现状（SSH 实测，2026-09-09）

### 2.1 基座模型 `Qwen3.6-35B-A3B`（NVFP4-Fast 量化版）

从 `/models/base/config.json` 实测提取（关键字段）：

| 字段 | 值 | 说明 |
|------|-----|------|
| `model_type` | `qwen3_5_moe` | Qwen3.5 MoE 架构（3.6 沿用） |
| `num_hidden_layers` | 40 | 10 全注意力 + 30 线性注意力 |
| `full_attention_interval` | 4 | 每第 4 层（索引 3,7,…,39）为全注意力 |
| `num_attention_heads` / `num_key_value_heads` | 16 / 2 | GQA 8:1 |
| `head_dim`（全注意力） | 256 | |
| 线性注意力 heads | QK=16 / V=32，head_dim=128 | Gated DeltaNet |
| `num_experts` / `num_experts_per_tok` | 256 / 8 | MoE，8 路由 + 1 共享 |
| `max_position_embeddings` | **262144** | 原生 256K |
| `mamba_ssm_dtype` | `float32` | DeltaNet 状态以 fp32 计算 |
| **`rope_parameters`** | 见下 | **mRoPE 3D 位置编码** |

```jsonc
// text_config.rope_parameters —— 当前实值
{
  "mrope_interleaved": true,
  "mrope_section": [11, 11, 10],   // 关键：3D 分片 T/H/W
  "partial_rotary_factor": 0.25,   // 只有 25% 维度（64/256）做旋转
  "rope_theta": 10000000,          // 1e7
  "rope_type": "default"           // 当前未启用 YaRN
}
```

> ⚠️ **本模型用的是 mRoPE（多分辨率 RoPE）**，把 64 维旋转维度切成 `[11,11,10]` 三段，分别编码 时间(T)/高(H)/宽(W)，是给多模态（图文视频）用的 3D 位置编码。这与标准 1D RoPE（YaRN 论文原始设定）不同，也是本调研最需要澄清的架构差异点。

### 2.2 量化方案（compressed-tensors，混合精度）

| 组 | 精度 | 作用域 |
|----|------|--------|
| group_0 | **FP8** | 全注意力 q/k/v/o_proj、线性注意力 in_proj_*、lm_head |
| group_1 | **NVFP4（4bit）** | MoE 专家 gate/up/down_proj + shared_expert |
| `kv_cache_scheme` | **FP8（num_bits=8）** | **KV cache 已是 fp8！** |

权重总大小：5 个 safetensors 分片 ≈ **23.65 GB**（35B 参数，约 0.67 byte/参数）。

### 2.3 LoRA 适配器 `Meerkat-TRIZ-v1`

| 字段 | 值 |
|------|-----|
| `r` / `lora_alpha` | 64 / 128 |
| `target_modules` | up/down/gate_proj、q/k/v/o_proj、in_proj_qkv/z/a/b、out_proj（**覆盖全注意力 + 线性注意力 + MoE 全部投影**） |
| `base_model_name_or_path` | `Qwen/Qwen3.6-35B-A3B` |
| 权重大小 | 169 MB |

> LoRA 只改动**投影权重**，不触碰 RoPE。因此 YaRN（改 RoPE）与 LoRA（改投影）在实现上**正交可叠加**，无需重训 LoRA。

### 2.4 服务器与当前 vLLM 运行参数（SSH 实测）

| 项 | 值 |
|----|-----|
| 硬件 | NVIDIA GB10（Grace Blackwell，统一内存） |
| 内存 | 总 121 GB / 已用 114 GB / **可用 7 GB**（free -g） |
| vLLM 版本 | v0.25.0 |
| 容器 | `meerkat-triz-vllm-nvfp4-v2` |
| `--max-model-len` | **262144**（当前 256K） |
| `--gpu-memory-utilization` | 0.83 |
| `--dtype` | float16（计算精度；权重按 compressed-tensors 自动加载 NVFP4/FP8） |
| `--max-num-batched-tokens` | 8192（prefill 分块大小） |
| `--max-num-seqs` | 64 |
| `--max_new_tokens`（override） | 81920 |
| `--enable-lora --lora-modules` | `Meerkat-TRIZ-v1=/models/adapter`，`--max-lora-rank 64` |

### 2.5 qm 侧 provider 注册值（Postgres `custom_model_providers` 实测）

```jsonc
{
  "id": "meerkat-vllm",
  "models": [
    {"id": "Qwen3.6-35B-A3B-NVFP4-Fast", "maxTokens": 8192, "contextWindow": 262144},
    {"id": "Meerkat-TRIZ-v1",              "maxTokens": 8192, "contextWindow": 262144}
  ],
  "protocol": "openai"
  // baseUrl 当前指向 seetacloud 隧道，与内网 192.168.60.102 的 vLLM 后端一致
}
```

> qm 侧 `pi-harness` 存在 **output-budget guard**：根据 `contextWindow - 估算prompt - 安全余量` 动态钳制 `max_tokens`。所以 **vLLM 扩到 1M 后，qm 侧 `contextWindow` 不跟着改，输出上限仍会被钳在 256K 窗口内**。这是最容易漏掉的一层。

---

## 三、YaRN 可行性分析

### 3.1 官方支持与正确启用方式

Qwen3.5 官方文档（Qwen3.5-122B-A10B / 397B-A17B 模型卡，架构与本模型 `qwen3_5_moe` 完全一致）给出的**唯一正确写法**：

```bash
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve /models/base \
  --hf-overrides '{"text_config": {"rope_parameters": {
      "mrope_interleaved": true,
      "mrope_section": [11, 11, 10],
      "rope_type": "yarn",
      "rope_theta": 10000000,
      "partial_rotary_factor": 0.25,
      "factor": 4.0,
      "original_max_position_embeddings": 262144
  }}}' \
  --max-model-len 1010000
```

要点：

| 参数 | 值 | 说明 |
|------|-----|------|
| `rope_type` | `"yarn"` | 从 `default` 改为 yarn |
| `factor` | `4.0` | 262144 × 4 ≈ 1.05M，官方封顶 1,010,000 |
| `original_max_position_embeddings` | 262144 | YaRN 校正基准 |
| `mrope_section` / `mrope_interleaved` | **必须保留 `[11,11,10]` / `true`** | 否则破坏 3D 位置编码 |
| `--max-model-len` | 1010000 | 1,010,000 |
| `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` | 环境变量 | 允许超过模型原生 max 的上下文 |

> ⚠️ **路径澄清（重要）**：vLLM 0.25 文档已废弃 `--rope-scaling`，官方 Qwen3-Next（`qwen3_next`）文档仍写 `--rope-scaling`；但**本模型是 `qwen3_5_moe`（Qwen3.5/3.6 系列），必须走 `--hf-overrides` + `text_config.rope_parameters`**，且要带上 mRoPE 的分片字段。二者不能混用。

### 3.2 静态 YaRN 的代价

官方明确警告：**所有主流框架实现的都是"静态 YaRN"**——缩放因子恒定，不随输入长度自适应。后果：

- 短文本（<256K）场景会**轻微掉点**；
- 建议**只在确实需要长上下文时启用**，或按需调 `factor`（例如典型 512K 场景用 `factor=2.0`）。

对 Meerkat 的实际含义：如果要"1M 输入上下文"，factor=4.0 是必须的；但如果核心诉求只是"10 万字输出"（≈150K tokens，仍在原生 256K 内），**其实不需要 YaRN**，只需放开 `maxTokens`/`max_new_tokens` 输出上限即可。二者要分清楚。

### 3.3 内存账（核心，纠正先前认知）

**关键结论：KV cache 已是 FP8，1M 上下文的 KV cache 只需约 10GB，不是 fp16 的 20GB。**

由于混合注意力架构，**只有 10/40 层是全注意力（吃 KV cache），30 层 Gated DeltaNet 是 O(1) 循环状态（不吃 KV cache）**：

| 项 | 计算 | 结果 |
|----|------|------|
| 全注意力层 KV 维度 | 2 KV heads × 256 head_dim × 2（K+V）= 1024 elem/token/层 | — |
| × 10 层 | 10240 elem/token | — |
| × FP8（1 byte） | 10 KB/token | — |
| **1M tokens KV cache** | 10 KB × 1,010,000 | **≈ 10.1 GB** |
| 当前 256K KV cache | 10 KB × 262,144 | ≈ 2.5 GB |
| **增量** | | **≈ +7.6 GB** |
| DeltaNet 30 层状态 | O(1)，每层 ≈2MB × 30（fp32） | < 100 MB，可忽略 |

对比内存现状：**可用仅 7GB，增量需约 7.6GB，刚好卡在临界线上。**

> ✅ **已由二次实测裁决（见第六章 6.2）**：落在「情况 1」——vLLM 已按 0.83 预分配 KV 池 **66.23GB**（=673 万 token），1M 序列（10GB）直接放入现有池，**无需额外内存**，仅并发从"多个 256K"降为"约 7 个 1M"。
>
> ⚠️ 「情况 2」的「降 `--gpu-memory-utilization`(0.83→0.7) 腾内存」**已证伪、作废**：降 utilization 只会缩小 KV 池、方向相反。扩 1M 应保持 0.83，靠「降并发」换上下文。

> 结论：内存是**紧约束但非硬阻断**。fp8 KV cache + 混合架构（只有 1/4 层吃 KV）是决定性利好，把 1M 的内存需求从"不可行"拉到"挤一挤可行"。**真正的约束是「并发 × 上下文」的乘积，不是显存本身。**

### 3.4 其他风险

| 风险 | 说明 | 应对 |
|------|------|------|
| **decode 速度** | 1M 上下文时，10 个全注意力层每步要对 1M KV 做注意力，GB10 单卡 decode 会明显变慢（可能 5~20 tok/s） | 接受低速 / 用 prefix caching / 分段 |
| **prefill 时间** | 1M 输入按 chunk=8192 分 122 块预填充，耗时以分钟计 | 可接受（一次性） |
| **LoRA 长文本未验证** | LoRA 在 `rope_type=default`（256K）下训练，>256K 效果无实测 | RULER 长文本基准验证退化 |
| **静态 YaRN 短文本掉点** | factor 恒定 | 按需启用 / 分档 factor |
| **视觉分支** | mRoPE 的 H/W 段给图文/视频用；纯文本长文只用 T 段，YaRN 对 T 段缩放即可，视觉短序列不受影响 | 无需额外处理 |

---

## 四、需要改的方面（分层清单）

### 第 1 层：vLLM 推理侧（核心）

1. 启动命令新增/修改：
   - `--hf-overrides` 注入 `text_config.rope_parameters`（`rope_type=yarn, factor=4.0, original_max_position_embeddings=262144`，**保留 mrope_section/mrope_interleaved**）
   - `--max-model-len` 262144 → **1010000**
   - 环境变量 `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`
2. （建议）显式加 `--kv-cache-dtype fp8` 确认 KV cache 走 fp8，并核对启动日志确认 fp8 KV cache 生效。

### 第 2 层：内存管理

3. 实测当前 vLLM 内存池占用；必要时：
   - `--gpu-memory-utilization` 0.83 → 0.70~0.75
   - 回收 buff/cache 或停非关键容器，腾出 ≥10GB 头寸。

### 第 3 层：qm 侧 provider（易漏）

4. `PUT /v1/admin/custom-providers/meerkat-vllm` 更新两个 model 的：
   - `contextWindow`: 262144 → **1010000**（否则 output-budget guard 仍按 256K 钳制）
   - `maxTokens`: 8192 → 视输出目标提升（如 131072 或更高；若只扩输入上下文不改输出，则保留）

### 第 4 层：输出上限（若含"10 万字输出"目标）

5. vLLM `--override-generation-config` 的 `max_new_tokens`: 81920 → 按需（10 万字 ≈ 150K tokens，建议 ≥163840）。
6. 注意：10 万字输出本身落在原生 256K 内，**不依赖 YaRN**；只有"1M 输入上下文"才需要 YaRN。

---

## 五、验证方案（改后必做）

1. **启动通过**：vLLM 能以 `--max-model-len 1010000` 起，日志无 OOM、确认 fp8 KV cache 生效。
2. **长上下文冒烟**：构造一个 >256K（如 300K、512K、1M）token 的文档做针-草堆（needle-in-a-haystack）测试，验证远距离召回。
3. **RULER 基准**（官方 Qwen3-Next 用其验证 1M）：抽样各长度档（64K/128K/256K/512K/1M）看平均准确率是否可接受。
4. **LoRA 退化评估**：同一长文任务分别在「base 无 LoRA」vs「base+LoRA」下跑，确认 LoRA 在 >256K 不引入明显退化。
5. **短文本回归**：确认启用 YaRN 后 <256K 常规任务无显著掉点（静态 YaRN 副作用）。

---

## 六、同事观点复核（2026-09-09 二次实测坐实）

> 同事针对 YaRN 方案提出三点看法，本文二次上机实测（`docker inspect` + `docker logs`）逐条复核，两个关键数字被推翻。
>
> 1. 降了 gpu-memory 和并发：256K 上下文的 kv-cache 巨大，128GB 统一内存无法同时支撑 0.85 利用率 + 16 并发。实际用了 0.6 + 8 并发。若生产需要更高并发，得进一步权衡。
> 2. YaRN 4 的实际语义：模型原生就是 256K，factor=4 使理论能力到 1M，但 max-model-len 256K 限制实际使用 256K。如果你要的是 1M 上下文，需要把 max-model-len 提到 ~1048576（但那会远超 128GB 显存，不可行）。
> 3. 混合架构风险：Qwen3.6 是 Mamba+Attention 混合，YaRN 只对 Attention 的 RoPE 生效，DeltaNet 层不受 YaRN 影响——这是 Qwen3 系列的已知限制，256K 内原生支持是安全的。

### 6.1 三点观点裁定

| # | 同事观点 | 复核结论 |
|---|---------|---------|
| 1 | 「已降为 0.6 利用率 + 8 并发」 | ❌ **与实测不符**：实际 `--gpu-memory-utilization 0.83`、`--max-num-seqs 64`，从未降低。真正在限流的是 `--max-num-batched-tokens 8192`（chunked prefill 阀），同事未提及 |
| 2 | 「1M 需 max-model-len 提到 ~1048576，远超 128GB 显存，不可行」 | ❌ **结论错误**：官方目标是 1,010,000（非 1048576）；且实测 KV 池 66GB 能装 673 万 token，1M 上下文可跑 ~7 路并发，**完全可行** |
| 3 | 「Mamba+Attention 混合，YaRN 只作用 RoPE，DeltaNet 不受影响」 | ⚠️ **方向对、术语错**：线性层是 **Gated DeltaNet**（非 Mamba）；DeltaNet 无 RoPE 不受 YaRN 影响是「架构事实（利好）」，真实风险是「DeltaNet 长文外推数值稳定性未验证」 |

### 6.2 二次实测：vLLM 内存分配精算（启动日志）

| 项 | 实测值 |
|----|--------|
| 模型权重加载 | **27.71 GiB**（checkpoint 22.02 GiB，NVFP4） |
| CUDA graph 池 | 0.78 GiB（实际）/ 1.16 GiB（估算） |
| **Available KV cache** | **66.23 GiB = 6,732,426 tokens** |
| 每 token KV 开销 | ≈ 10.3 KB/token（66.23 GiB ÷ 673 万） |
| 256K 上下文最大并发 | **25.68x**（vLLM 日志原话） |

> 与 3.3 节估算（10 KB/token）完全吻合。且 3.3 节「两种可能」**已裁决为情况 1**：vLLM 确实按 0.83 预分配了 ~66GB KV 池，1M 序列（10GB）直接放进现有池，**无需额外内存**。

> ⚠️ **勘误**：本文 3.3 节「情况 2」与第 4 章「第 2 层内存管理」中「降 `--gpu-memory-utilization`(0.83→0.7) 腾内存」的建议**作废**。实测确认落在「情况 1」，无需腾内存；且降 utilization 只会**缩小** KV 池（方向相反，会削弱 1M 容量）。扩 1M 应保持 0.83，靠「降并发」换上下文。

### 6.3 可行域：并发 × 上下文 = 673 万 token（常数）

| 单请求上下文 | 最大并发（0.83 实测） |
|-------------|---------------------|
| 64K | ~103 路 |
| 128K | ~51 路 |
| 256K（现状） | ~26 路 |
| 512K | ~13 路 |
| **1M（目标）** | **~7 路** |
| 1024K | ~6 路 |

> 关键洞察：**「并发 × 上下文」是常数（673 万 token 天花板）**。降并发即可换更长上下文——同事观点 1 的解法（降并发）恰好也是观点 2「不可行」的反例：1M 场景降到 1~7 路并发就完全装得下。

### 6.4 落地清单（最终版）

```bash
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve /models/base \
  --hf-overrides '{"text_config":{"rope_parameters":{...,"rope_type":"yarn","factor":4.0,"original_max_position_embeddings":262144}}}' \
  --max-model-len 1010000 \
  --max-num-seqs 16 \
  --max-num-batched-tokens 32768
```

- `--gpu-memory-utilization` 保持 0.83，**无需调**（KV 池已够 7 路 1M）。
- `--max-num-seqs` 64 → 16（1M 场景不需要 64 并发，同时降低 CUDA graph 捕获开销）。
- `--max-num-batched-tokens` 8192 → 32768（1M prompt 的 chunked prefill 从 ~123 步降到 ~31 步）。
- qm 侧 `contextWindow` 262144 → 1010000（见第 4 章第 3 层，不变）。

---

## 七、数据来源

- Qwen3.6-35B-A3B 官方说明与 HF 社区评测（原生 256K、YaRN 可扩至 1,010,000、Gated DeltaNet 混合架构）
- Qwen3.5-122B-A10B / 397B-A17B 官方模型卡（mRoPE 架构的 YaRN 启用写法，与本模型 `qwen3_5_moe` 一致）
- vLLM v0.25.0 Context Extension 文档
- **SSH 实测**：`/models/base/config.json`、`/models/adapter/adapter_config.json`、容器启动参数、`free -g`、Postgres `custom_model_providers` 表
- **二次实测（15:3x）**：`docker logs`（KV cache 66.23 GiB = 6,732,426 tokens、权重 27.71 GiB、256K 并发 25.68x）、`docker inspect`（完整启动参数 0.83 / 64 并发 / 8192 batch）

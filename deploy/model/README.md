# Meerkat-TRIZ-v1 vLLM 部署配置说明

> 抓取自服务器 `meerkat@192.168.60.102`（运行中容器 `meerkat-triz-vllm-nvfp4-v2`），抓取时间 2026-09-07。

## 文件清单

| 文件 | 作用 |
|---|---|
| `vllm.env` | 可调参数集中地（改这里） |
| `run-vllm.sh` | 启动脚本，读 env 翻译成 `docker run`（服务器上执行） |

## 部署结构

`Meerkat-TRIZ-v1` 不是独立模型，而是**挂在 Qwen3.6-35B-A3B 上的 LoRA 适配器**：

- base：`Qwen3.6-35B-A3B-NVFP4-Fast`（MoE，35B 参数 / 激活 3B，NVFP4 量化）
- LoRA：`Meerkat-TRIZ-v1`（r=64，169MB），叠加在 base 上

## 关键参数（长上下文调优重点）

| 参数 | 当前值 | 含义 |
|---|---|---|
| `MAX_MODEL_LEN` | 262144 | 最大上下文（input+output 总 token），已 256K |
| `MAX_NEW_TOKENS` | 16384 | ★ 单次输出上限（瓶颈，≈1.2 万字） |
| `GPU_MEMORY_UTILIZATION` | 0.83 | GPU 显存利用率 |
| `MAX_NUM_SEQS` | 64 | 最大并发序列数 |

## 长文输出的两个硬顶

1. `MAX_NEW_TOKENS` 当前 16384 → 只能输出 ~1.2 万字
2. 模型本身输出上限 81920 token ≈ 6 万字（官方 max output），改参数越不过去

## 服务器信息

- SSH：`meerkat@192.168.60.102`（密码 meerkat123）
- 模型 API：`http://192.168.60.102:8000/v1`
- API key：见 `vllm.env` 的 `VLLM_API_KEY`
- 硬件：NVIDIA GB10（DGX Spark），121G 统一内存

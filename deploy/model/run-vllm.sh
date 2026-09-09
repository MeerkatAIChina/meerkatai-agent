#!/usr/bin/env bash
# Meerkat-TRIZ-v1 vLLM 启动脚本（在服务器 meerkat@192.168.60.102 上执行）
# 从 deploy/model/vllm.env 读取配置，翻译成 docker run 命令
set -euo pipefail

source /home/meerkat/.config/meerkat-triz/vllm.env 2>/dev/null || true
source "$(dirname "$0")/vllm.env"

CONTAINER_NAME="${CONTAINER_NAME:-meerkat-triz-vllm-nvfp4-v2}"

# 停旧容器（如存在）
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --gpus all \
  --network host \
  --ipc host \
  --health-cmd="curl -fsS -H \"Authorization: Bearer \$VLLM_API_KEY\" http://127.0.0.1:8000/v1/models >/dev/null || exit 1" \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 10 \
  --health-start-period 10m \
  -e VLLM_API_KEY \
  -e CUTE_DSL_ARCH=sm_121a \
  -e VLLM_USE_FLASHINFER_SAMPLER=0 \
  -e CUDA_VISIBLE_DEVICES=0 \
  -e CUDA_DEVICE_ORDER=PCI_BUS_ID \
  -e VLLM_IMAGE_FETCH_TIMEOUT=60 \
  -e VLLM_VIDEO_FETCH_TIMEOUT=180 \
  -v "$BASE_DIR:/models/base:ro" \
  -v "$ADAPTER_DIR:/models/adapter:ro" \
  "$VLLM_IMAGE" \
  /models/base \
  --served-model-name "$SERVED_MODEL_NAME" \
  --host 0.0.0.0 \
  --port 8000 \
  --trust-remote-code \
  --dtype "$DTYPE" \
  --attention-backend "$ATTENTION_BACKEND" \
  --moe-backend "$MOE_BACKEND" \
  --linear-backend "$LINEAR_BACKEND" \
  --generation-config auto \
  --override-generation-config "{\"temperature\": $TEMPERATURE, \"top_p\": $TOP_P, \"repetition_penalty\": $REPETITION_PENALTY, \"max_new_tokens\": $MAX_NEW_TOKENS}" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --max-num-batched-tokens "$MAX_NUM_BATCHED_TOKENS" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --reasoning-parser "$REASONING_PARSER" \
  --enable-auto-tool-choice \
  --tool-call-parser "$TOOL_CALL_PARSER" \
  --enable-lora \
  --lora-modules "$LORA_MODULES" \
  --max-lora-rank "$MAX_LORA_RANK" \
  --limit-mm-per-prompt '{"image": {"count": 3, "width": 1280, "height": 1280}, "video": {"count": 1, "num_frames": 32, "width": 512, "height": 512}}' \
  --media-io-kwargs '{"video": {"video_backend": "opencv", "num_frames": 32, "fps": 2}}' \
  --mm-processor-kwargs '{"do_sample_frames": false}'

echo "容器已启动: $CONTAINER_NAME"
echo "等待健康检查（可 watch docker ps 观察 status 变 healthy）"

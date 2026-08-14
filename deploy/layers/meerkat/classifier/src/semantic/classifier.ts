interface SemanticConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

let config: SemanticConfig | undefined;

export function configureSemantic(cfg: SemanticConfig): void {
  config = cfg;
}

export interface SemanticResult {
  level: "L1" | "L2" | "L3";
  domain: "triz" | "general";
}

const CLASSIFY_PROMPT = [
  "你是一个数据敏感度和领域分类器。",
  "分析以下用户消息，返回纯 JSON：",
  '{"level":"L1"|"L2"|"L3","domain":"triz"|"general"}',
  "L1: 含PII、商业机密、未公开产品数据  L2: 中等敏感  L3: 无敏感信息",
  "triz: 涉及TRIZ创新方法论  general: 不涉及TRIZ",
].join("\n");

function extractContent(body: string): string {
  try {
    const envelope = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
  }
  return body;
}

export async function classifySemantic(text: string): Promise<SemanticResult> {
  if (!config) throw new Error("semantic classifier not configured");

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: `${CLASSIFY_PROMPT}\n\n用户消息: ${text}` }],
      temperature: 0,
      max_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) throw new Error(`semantic endpoint returned ${response.status}`);

  const body = await response.text();
  const jsonMatch = extractContent(body).match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("semantic response missing JSON");

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const level = parsed["level"];
  const domain = parsed["domain"];

  if (level !== "L1" && level !== "L2" && level !== "L3") throw new Error(`invalid level: ${level}`);
  if (domain !== "triz" && domain !== "general") throw new Error(`invalid domain: ${domain}`);

  return { level: level as SemanticResult["level"], domain: domain as SemanticResult["domain"] };
}

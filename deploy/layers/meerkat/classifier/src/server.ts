import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { runPipeline, loadRoutes } from "./pipeline.ts";
import { configureSemantic } from "./semantic/classifier.ts";
import type { ClassifyRequest } from "./types.ts";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const ROUTES_PATH = process.env["ROUTES_PATH"] ?? fileURLToPath(new URL("routes.jsonc", import.meta.url));
const SEMANTIC_ENDPOINT = process.env["SEMANTIC_ENDPOINT"];
const SEMANTIC_MODEL = process.env["SEMANTIC_MODEL"] ?? "Meerkat-TRIZ-v1";

loadRoutes(ROUTES_PATH);

if (SEMANTIC_ENDPOINT) {
  configureSemantic({
    endpoint: SEMANTIC_ENDPOINT,
    model: SEMANTIC_MODEL,
    apiKey: process.env["SEMANTIC_API_KEY"],
    timeoutMs: parseInt(process.env["SEMANTIC_TIMEOUT_MS"] ?? "1200", 10),
  });
}

const app = Fastify({ logger: true });
app.log.info(
  { semanticConfigured: Boolean(SEMANTIC_ENDPOINT), semanticModel: SEMANTIC_MODEL },
  "classifier startup config",
);

const MEERKAT_DATA_DIR = process.env["MEERKAT_DATA_DIR"];
if (MEERKAT_DATA_DIR) {
  const localModelPath = join(MEERKAT_DATA_DIR, "local-model.json");
  let reloadTimer: NodeJS.Timeout | undefined;
  const reloadLocalModel = () => {
    try {
      const raw = JSON.parse(readFileSync(localModelPath, "utf8")) as {
        baseUrl?: unknown;
        model?: unknown;
        apiKey?: unknown;
      };
      if (typeof raw.baseUrl !== "string" || typeof raw.model !== "string") return;
      configureSemantic({
        endpoint: `${raw.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        model: raw.model,
        ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
        timeoutMs: parseInt(process.env["SEMANTIC_TIMEOUT_MS"] ?? "1200", 10),
      });
      app.log.info({ semanticModel: raw.model }, "semantic config reloaded from local-model.json");
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "local-model.json reload skipped");
    }
  };
  watch(MEERKAT_DATA_DIR, (_event, filename) => {
    if (filename !== "local-model.json") return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadLocalModel, 200);
  });
}

app.post("/classify", async (req, reply) => {
  const body = req.body as ClassifyRequest;
  if (!body?.text || !body?.metadata?.scope_id) {
    req.log.warn(
      {
        bodyType: typeof body,
        hasText: Boolean(body?.text),
        hasScopeId: Boolean(body?.metadata?.scope_id),
        bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
        metadataKeys:
          body?.metadata && typeof body.metadata === "object" ? Object.keys(body.metadata) : [],
      },
      "classify rejected: missing text or metadata.scope_id",
    );
    return reply.status(400).send({ error: "text and metadata.scope_id are required" });
  }
  const result = await runPipeline({ text: body.text, scopeId: body.metadata.scope_id }, req.log);
  return reply.send(result);
});

app.get("/health", async (_req, reply) => reply.send({ status: "ok" }));

app.listen({ port: PORT, host: process.env["HOST"] ?? "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
});

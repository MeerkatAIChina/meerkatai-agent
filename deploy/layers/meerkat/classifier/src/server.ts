import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { runPipeline, loadRoutes } from "./pipeline.ts";
import { configureSemantic } from "./semantic/classifier.ts";
import type { ClassifyRequest } from "./types.ts";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const ROUTES_PATH = process.env["ROUTES_PATH"] ?? fileURLToPath(new URL("routes.jsonc", import.meta.url));
const SEMANTIC_ENDPOINT = process.env["SEMANTIC_ENDPOINT"];
const SEMANTIC_MODEL = process.env["SEMANTIC_MODEL"] ?? "meerkat-triz-v1";

loadRoutes(ROUTES_PATH);

if (SEMANTIC_ENDPOINT) {
  configureSemantic({
    endpoint: SEMANTIC_ENDPOINT,
    model: SEMANTIC_MODEL,
    timeoutMs: parseInt(process.env["SEMANTIC_TIMEOUT_MS"] ?? "1200", 10),
  });
}

const app = Fastify({ logger: true });

app.post("/classify", async (req, reply) => {
  const body = req.body as ClassifyRequest;
  if (!body?.text || !body?.metadata?.scope_id) {
    return reply.status(400).send({ error: "text and metadata.scope_id are required" });
  }
  const result = await runPipeline({ text: body.text, scopeId: body.metadata.scope_id });
  return reply.send(result);
});

app.get("/health", async (_req, reply) => reply.send({ status: "ok" }));

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
});

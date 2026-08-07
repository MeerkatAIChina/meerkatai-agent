import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runPipeline, loadRoutes } from "./pipeline.ts";
import { configureSemantic } from "./semantic/classifier.ts";

const ROUTES = {
  "local-secure": { harnessId: "pi", modelId: "test-local", providerId: "test" },
  "meerkat-triz-v1": { harnessId: "pi", modelId: "test-triz", providerId: "test" },
};

const routesPath = join(tmpdir(), "meerkat-test-routes.json");
writeFileSync(routesPath, JSON.stringify(ROUTES));
loadRoutes(routesPath);

async function fakeSemantic(content: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

test("runPipeline routes PII to local-secure with pin", async () => {
  const result = await runPipeline({ text: "卡号 6222021234567890123", scopeId: "s" });
  assert.strictEqual(result.level, "L1");
  assert.strictEqual(result.route?.policy, "local-secure");
  assert.strictEqual(result.route?.session_pin, true);
  assert.strictEqual(result.route?.harness_id, "pi");
});

test("runPipeline routes TRIZ to meerkat-triz-v1 without pin", async () => {
  const result = await runPipeline({ text: "用矛盾矩阵分析这个技术矛盾", scopeId: "s" });
  assert.strictEqual(result.level, "L3");
  assert.strictEqual(result.domain, "triz");
  assert.strictEqual(result.route?.session_pin, false);
});

test("runPipeline returns L3+general for clean text when semantic is unconfigured", async () => {
  const result = await runPipeline({ text: "今天天气很好", scopeId: "s" });
  assert.strictEqual(result.level, "L3");
  assert.strictEqual(result.domain, "general");
  assert.strictEqual(result.route, undefined);
});

test("semantic L2 verdict upgrades to local-secure with pin", async () => {
  const semantic = await fakeSemantic('{"level":"L2","domain":"general"}');
  configureSemantic({ endpoint: semantic.url, model: "test-model", timeoutMs: 2000 });
  try {
    const result = await runPipeline({ text: "这份未公开的成本明细帮我分析一下", scopeId: "s" });
    assert.strictEqual(result.level, "L1");
    assert.strictEqual(result.route?.policy, "local-secure");
    assert.strictEqual(result.route?.session_pin, true);
  } finally {
    await semantic.close();
  }
});

test("semantic triz domain routes to the triz model", async () => {
  const semantic = await fakeSemantic('{"level":"L3","domain":"triz"}');
  configureSemantic({ endpoint: semantic.url, model: "test-model", timeoutMs: 2000 });
  try {
    const result = await runPipeline({ text: "这个产品的散热方案怎么改进", scopeId: "s" });
    assert.strictEqual(result.level, "L3");
    assert.strictEqual(result.domain, "triz");
    assert.strictEqual(result.route?.policy, "meerkat-triz-v1");
  } finally {
    await semantic.close();
  }
});

test("semantic network failure fails to local with pin", async () => {
  configureSemantic({ endpoint: await refusedUrl(), model: "test-model", timeoutMs: 2000 });
  const result = await runPipeline({ text: "随便聊聊", scopeId: "s" });
  assert.strictEqual(result.level, "L1");
  assert.strictEqual(result.route?.policy, "local-secure");
  assert.strictEqual(result.route?.session_pin, true);
});

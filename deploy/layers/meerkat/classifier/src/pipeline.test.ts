import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, loadRoutes } from "./pipeline.ts";

const ROUTES = {
  "local-secure": { harnessId: "pi", modelId: "test-local", providerId: "test" },
  "meerkat-triz-v1": { harnessId: "pi", modelId: "test-triz", providerId: "test" },
};

const routesPath = join(tmpdir(), "meerkat-test-routes.json");
writeFileSync(routesPath, JSON.stringify(ROUTES));
loadRoutes(routesPath);

test("runPipeline routes PII to local-secure with pin", () => {
  const result = runPipeline({ text: "卡号 6222021234567890123", scopeId: "s" });
  assert.strictEqual(result.level, "L1");
  assert.strictEqual(result.route?.policy, "local-secure");
  assert.strictEqual(result.route?.session_pin, true);
  assert.strictEqual(result.route?.harness_id, "pi");
});

test("runPipeline routes TRIZ to meerkat-triz-v1 without pin", () => {
  const result = runPipeline({ text: "用矛盾矩阵分析这个技术矛盾", scopeId: "s" });
  assert.strictEqual(result.level, "L3");
  assert.strictEqual(result.domain, "triz");
  assert.strictEqual(result.route?.session_pin, false);
});

test("runPipeline returns L3+general for clean text", () => {
  const result = runPipeline({ text: "今天天气很好", scopeId: "s" });
  assert.strictEqual(result.level, "L3");
  assert.strictEqual(result.domain, "general");
  assert.strictEqual(result.route, undefined);
});

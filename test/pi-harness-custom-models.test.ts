import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { customModelsPath } from "../src/harness/pi-harness.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const SPEC = {
  id: "test-local",
  name: "Test Local",
  protocol: "openai" as const,
  baseUrl: "http://127.0.0.1:8000/v1",
  models: [{ id: "test-model-1", modalities: ["text" as const] }],
};

function cleanup(path: string | null): void {
  if (path) rmSync(dirname(path), { recursive: true, force: true });
}

test("customModelsPath caches per registry version", () => {
  setCustomProviders([SPEC]);
  const first = customModelsPath();
  assert.ok(first && existsSync(first));
  assert.equal(customModelsPath(), first);
  cleanup(first);
});

test("customModelsPath re-materializes when the cached file disappears", () => {
  setCustomProviders([SPEC]);
  const first = customModelsPath();
  assert.ok(first && existsSync(first));
  rmSync(first);
  const second = customModelsPath();
  assert.ok(second && second !== first && existsSync(second));
  const written = JSON.parse(readFileSync(second, "utf8")) as { providers: Record<string, unknown> };
  assert.ok(written.providers[SPEC.id]);
  cleanup(second);
});

test("customModelsPath re-materializes when the whole temp dir disappears", () => {
  setCustomProviders([SPEC]);
  const first = customModelsPath();
  assert.ok(first);
  rmSync(dirname(first), { recursive: true, force: true });
  const second = customModelsPath();
  assert.ok(second && existsSync(second));
  cleanup(second);
});

test("customModelsPath returns null with an empty registry", () => {
  setCustomProviders([]);
  assert.equal(customModelsPath(), null);
  setCustomProviders([SPEC]);
  const path = customModelsPath();
  cleanup(path);
  setCustomProviders([]);
});

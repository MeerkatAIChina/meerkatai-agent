import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activateZh } from "./zh-locale.ts";
import { humanizeTurnFailure } from "../src/turn-failure.ts";

const bridgeSource = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");

test("none-sandbox turn failures are rewritten to an actionable message", async () => {
  await activateZh();
  const raw = "sandbox unavailable: SANDBOX_BACKEND=none (no sandbox substrate on this machine)";
  const humanized = humanizeTurnFailure(raw);
  assert.notEqual(humanized, raw);
  assert.match(humanized, /沙箱/);
  assert.match(humanized, /重启/);
});

test("missing-API-key turn failures are rewritten without /login or local paths", async () => {
  await activateZh();
  const raw =
    "No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\nD:\\Meerkat\\payload\\core\\dist\\docs\\providers.md\nD:\\Meerkat\\payload\\core\\dist\\docs\\models.md";
  const humanized = humanizeTurnFailure(raw);
  assert.notEqual(humanized, raw);
  assert.match(humanized, /密钥/);
  assert.match(humanized, /设置页/);
  assert.doesNotMatch(humanized, /\/login/);
  assert.doesNotMatch(humanized, /D:\\/);
});

test("the whole missing-API-key family is covered", async () => {
  await activateZh();
  for (const raw of ["No API key for provider: openai", "No API key for local-secure/Meerkat-TRIZ-v1"]) {
    const humanized = humanizeTurnFailure(raw);
    assert.notEqual(humanized, raw);
    assert.match(humanized, /密钥/);
  }
});

test("other turn failure messages pass through untouched", () => {
  const generic = "That turn failed and couldn't be completed. The details are in the operator error log.";
  assert.equal(humanizeTurnFailure(generic), generic);
});

test("the session-tape replay humanizes turn_failure payloads", () => {
  assert.match(bridgeSource, /errorMessage: humanizeTurnFailure\(failure\.message\)/);
});

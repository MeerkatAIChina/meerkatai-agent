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

test("other turn failure messages pass through untouched", () => {
  const generic = "That turn failed and couldn't be completed. The details are in the operator error log.";
  assert.equal(humanizeTurnFailure(generic), generic);
});

test("the session-tape replay humanizes turn_failure payloads", () => {
  assert.match(bridgeSource, /errorMessage: humanizeTurnFailure\(failure\.message\)/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { cronIdOf, sessionOrigin } from "../src/sessions/session-store.ts";
import { runSessionStoreContract } from "./support/session-store-contract.ts";

test("sessionOrigin classifies trigger threads by prefix", () => {
  assert.equal(sessionOrigin("agent:main:cron:abc"), "cron");
  assert.equal(sessionOrigin("agent:main:webhook:abc"), "webhook");
  assert.equal(sessionOrigin("agent:main:monitor:abc"), "monitor");
  assert.equal(sessionOrigin("cron:c1:slot"), "cron");
  assert.equal(sessionOrigin("dm:D1"), "conversation");
  assert.equal(sessionOrigin("ch:C1:t1"), "conversation");
  assert.equal(sessionOrigin(null), "conversation");
  assert.equal(sessionOrigin(undefined), "conversation");
});

runSessionStoreContract("memory", (opts) => createMemorySessionStore(opts));

test("cronIdOf and sessionOrigin agree on which threadRefs are crons", () => {
  const refs = [
    "agent:main:cron:abc",
    "cron:abc",
    "cron:abc:slot",
    "cron:abc:slot:extra",
    "agent:main:webhook:x",
    "webhook:x:y",
    "dm:D1",
    "cron:",
    "agent:main:cron:abc:extra",
  ];
  for (const ref of refs) {
    assert.equal(cronIdOf(ref) !== null, sessionOrigin(ref) === "cron", `classifiers agree on ${ref}`);
  }
  assert.equal(cronIdOf("agent:main:cron:abc"), "abc");
  assert.equal(cronIdOf("cron:abc:slot"), "abc");
  assert.equal(cronIdOf("dm:D1"), null);
});

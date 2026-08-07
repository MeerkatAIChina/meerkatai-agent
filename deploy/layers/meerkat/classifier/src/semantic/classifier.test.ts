import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { classifySemantic, configureSemantic } from "./classifier.ts";

let responseBody = "";

async function fakeEndpoint(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(responseBody);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("throws when not configured", async () => {
  await assert.rejects(() => classifySemantic("hello"), /semantic classifier not configured/);
});

test("parses a chat completion envelope", async () => {
  const endpoint = await fakeEndpoint();
  responseBody = JSON.stringify({ choices: [{ message: { content: '{"level":"L2","domain":"general"}' } }] });
  configureSemantic({ endpoint: endpoint.url, model: "test-model", timeoutMs: 2000 });
  try {
    const result = await classifySemantic("hello");
    assert.deepStrictEqual(result, { level: "L2", domain: "general" });
  } finally {
    await endpoint.close();
  }
});

test("accepts a plain JSON body", async () => {
  const endpoint = await fakeEndpoint();
  responseBody = '{"level":"L1","domain":"triz"}';
  configureSemantic({ endpoint: endpoint.url, model: "test-model", timeoutMs: 2000 });
  try {
    const result = await classifySemantic("hello");
    assert.deepStrictEqual(result, { level: "L1", domain: "triz" });
  } finally {
    await endpoint.close();
  }
});

test("throws on an invalid level", async () => {
  const endpoint = await fakeEndpoint();
  responseBody = '{"level":"L9","domain":"general"}';
  configureSemantic({ endpoint: endpoint.url, model: "test-model", timeoutMs: 2000 });
  try {
    await assert.rejects(() => classifySemantic("hello"), /invalid level/);
  } finally {
    await endpoint.close();
  }
});

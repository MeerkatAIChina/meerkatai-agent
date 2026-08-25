import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "mcp-servers-route-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BODY = {
  name: "Memory",
  url: "https://mcp.example.com/api/memory/mcp",
  auth: "header",
  headerName: "X-Custom-Key",
  headerValue: "hdr-sekret",
  validate: false,
};

function put(base: string, id: string, body: unknown) {
  return fetch(`${base}/v1/admin/mcp-servers/${id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });
}

test("header auth registers, redacts the value, and keeps it on a blank update", async () => {
  const srv = start();
  try {
    const created = await put(srv.base, "memory", BODY);
    assert.equal(created.status, 200);
    const createdText = await created.text();
    assert.equal(createdText.includes("hdr-sekret"), false, "secret never echoed");
    assert.ok(createdText.includes("X-Custom-Key"), "headerName is not a secret and stays visible");

    const list = await fetch(`${srv.base}/v1/admin/mcp-servers`, { headers: ADMIN });
    const listed = (await list.json()) as { servers: Array<Record<string, unknown>> };
    const row = listed.servers.find((s) => s.id === "memory")!;
    assert.equal(row.hasHeaderValue, true);
    assert.equal(row.headerName, "X-Custom-Key");
    assert.equal("headerValue" in row, false);

    const update = await put(srv.base, "memory", { ...BODY, headerValue: "", name: "Memory Renamed" });
    assert.equal(update.status, 200);
    const stored = await srv.built.mcpServers.get("memory");
    assert.equal(stored?.headerValue, "hdr-sekret", "blank headerValue keeps the stored secret");
    assert.equal(stored?.name, "Memory Renamed");
  } finally {
    await srv.close();
  }
});

test("headerName is validated: token shape and reserved names, case-insensitive", async () => {
  const srv = start();
  try {
    for (const headerName of ["bad name", "", "Authorization", "CONTENT-TYPE", "Host"]) {
      const res = await put(srv.base, "memory", { ...BODY, headerName });
      assert.equal(res.status, 400, `headerName ${JSON.stringify(headerName)} must be rejected`);
    }
    const res = await put(srv.base, "memory", { ...BODY, headerName: undefined, headerValue: "x" });
    assert.equal(res.status, 400, "headerName is required on create and update");
  } finally {
    await srv.close();
  }
});

test("headerValue is required on create", async () => {
  const srv = start();
  try {
    const res = await put(srv.base, "memory", { ...BODY, headerValue: "" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /headerValue/);
  } finally {
    await srv.close();
  }
});

test("switching auth modes drops the previous mode's secrets", async () => {
  const srv = start();
  try {
    assert.equal((await put(srv.base, "memory", { ...BODY, auth: "bearer", bearerToken: "tok" })).status, 200);
    assert.equal((await put(srv.base, "memory", BODY)).status, 200);
    const stored = await srv.built.mcpServers.get("memory");
    assert.equal(stored?.bearerToken, undefined, "bearer secret dropped on switch to header");
    assert.equal(stored?.headerValue, "hdr-sekret");
  } finally {
    await srv.close();
  }
});

test("default validate probes tools/list and fails closed when unreachable", async () => {
  const srv = start();
  try {
    const down = await put(srv.base, "memory", { ...BODY, url: "http://127.0.0.1:1/mcp", validate: undefined });
    assert.equal(down.status, 400);
    assert.equal(((await down.json()) as { error: string }).error, "unreachable");
    assert.equal(await srv.built.mcpServers.get("memory"), null, "failed probe means nothing is stored");

    const stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const rpc = JSON.parse(raw) as { id: number };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "recall", description: "d", inputSchema: { type: "object" } }] } }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, r));
    const port = (stub.address() as AddressInfo).port;
    const ok = await put(srv.base, "memory", { ...BODY, url: `http://127.0.0.1:${port}/mcp`, validate: undefined });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { tools?: string[] };
    assert.deepEqual(okBody.tools, ["recall"]);
    stub.close();
  } finally {
    await srv.close();
  }
});

import { createWsl2Sandbox } from "./src/sandbox/wsl2-sandbox.ts";
import { createLocalWorkspaceStore } from "./src/workspace/workspace-store.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seed = JSON.parse(
  readFileSync("deploy/layers/meerkat/desktop/seeds/sandbox-egress.json", "utf8"),
);
const sb = createWsl2Sandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "wsl2-e2e-"))), {
  agentToken: "e2e-token-" + Date.now(),
  egress: { allowlist: seed.allow },
});

const results = [];
const check = (name, ok, detail) => results.push(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);

const h = await sb.provision([{ scopeId: "personal:e2e", mountPath: "", mode: "rw" }]);
check("provision", !!h.rootDir.endsWith("/workspace"), h.rootDir);
check("proxy env injected", /http:\/\/127\.0\.0\.1:\d+/.test(h.env?.HTTP_PROXY ?? ""), h.env?.HTTP_PROXY ?? "none");

const uname = await sb.run(h, "uname -sr");
check("run in guest", uname.code === 0 && /Linux/.test(uname.stdout), uname.stdout.trim());

const id = await sb.run(h, "id -u");
check("runs as non-root sandbox user", id.stdout.trim() === "999", `uid=${id.stdout.trim()}`);

await sb.writeFile(h, "hello.txt", "sandbox file content");
const read = await sb.readFile(h, "hello.txt");
check("write/read file", read === "sandbox file content", read);

const listed = await sb.listDir(h, ".");
check("listDir", listed.includes("hello.txt"), listed.join(","));

const pip = await sb.run(h, "curl -sS -m 15 https://pypi.org/simple/cowsay/ -o /dev/null -w '%{http_code}'", { timeoutMs: 30_000 });
check("allowlisted pypi via fence", pip.stdout.trim() === "200", `code=${pip.stdout.trim()} ${pip.stderr.trim().slice(0, 80)}`);

const denied = await sb.run(h, "curl -sS -m 8 https://evil.com -o /dev/null -w '%{http_code}'", { timeoutMs: 20_000 });
check("non-allowlisted blocked", denied.stdout.trim() !== "200", `code=${denied.stdout.trim()}`);

const direct = await sb.run(h, "unset HTTP_PROXY HTTPS_PROXY; curl -sS -m 5 https://1.1.1.1 -o /dev/null -w '%{http_code}' || echo BLOCKED", { timeoutMs: 20_000 });
check("direct bypass dropped", /BLOCKED/.test(direct.stdout) || direct.stdout.trim() === "000", direct.stdout.trim());

const flush = await sb.run(h, "iptables -F OUTPUT 2>&1 || echo DENIED");
check("cannot flush iptables", /DENIED|Permission denied/.test(flush.stdout + flush.stderr), (flush.stdout + flush.stderr).trim().slice(0, 60));

const proc = await sb.startProcess(h, "sleep 30");
const procs = await sb.listProcesses(h);
check("process sessions", procs.some((p) => p.processId === proc.processId), `${procs.length} procs`);
await sb.signalProcess(h, proc.processId, "KILL");

await sb.teardown(h);
console.log(results.join("\n"));

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { ephemeralCredLinkScript, ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { spawnWslExec, type WslExec } from "./wsl-exec.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const AGENT_PATH = "/opt/qm/agent.mjs";
const PROXY_PATH = "/opt/qm/egress-proxy.mjs";
const FENCE_PATH = "/opt/qm/egress-lock.sh";

export type WslSpawn = (args: string[], env: Record<string, string>) => ChildProcess;

export function spawnWslChild(
  args: string[],
  env: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
  return spawn("wsl.exe", args, {
    env: { ...hostEnv, ...env, WSLENV: Object.keys(env).join(":") },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

export interface Wsl2SandboxOptions {
  distro?: string;
  agentToken: string;
  wsl?: WslExec;
  spawnWsl?: WslSpawn;
  hostEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  defaultTimeoutSec?: number;
  agentPortForTest?: number;
  egress?: { allowlist: string[] };
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

function scopeSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export function createWsl2Sandbox(workspace: WorkspaceStore, opts: Wsl2SandboxOptions): Sandbox {
  const distro = opts.distro ?? "meerkat-sandbox";
  const wsl = opts.wsl ?? spawnWslExec();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.agentToken;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const queue = createKeyedQueue<string>();
  const defaultSpawnWsl: WslSpawn | undefined = opts.agentPortForTest
    ? undefined
    : (args, env) => spawnWslChild(args, env, opts.hostEnv);

  let agentPort: number | undefined;
  let agentChild: ChildProcess | undefined;
  let proxyChild: ChildProcess | undefined;
  let egressProxyPort: number | undefined;
  let fenceApplied = false;

  async function ensureEgressFence(): Promise<void> {
    if (!opts.egress || fenceApplied) return;
    const port = await freePort();
    const allow = opts.egress.allowlist.join(",");
    const spawner = opts.spawnWsl ?? defaultSpawnWsl;
    if (spawner) {
      proxyChild = spawner(["-d", distro, "-u", "root", "--exec", "node", PROXY_PATH], {
        EGRESS_PORT: String(port),
        EGRESS_ALLOW: allow,
      });
      proxyChild.on("exit", () => {
        proxyChild = undefined;
      });
    }
    const probeDeadline = Date.now() + 5_000;
    let up = false;
    while (Date.now() < probeDeadline) {
      const probe = await wsl(
        ["-d", distro, "-u", "root", "--", "sh", "-c", `curl -sm 2 -o /dev/null http://127.0.0.1:${port}/`],
        5_000,
      );
      if (probe.code === 0) {
        up = true;
        break;
      }
      await sleep(200);
    }
    if (!up && !opts.agentPortForTest)
      throw new Error("wsl2 sandbox: egress proxy never became reachable in the guest");
    egressProxyPort = port;
    const fence = await wsl(["-d", distro, "-u", "root", "--", "sh", FENCE_PATH], 15_000);
    if (fence.code !== 0) {
      opts.onError?.({
        category: "sandbox_egress",
        code: "fence_apply_failed",
        message: fence.stderr.trim(),
      });
      throw new Error(
        "wsl2 sandbox: egress fence could not be applied (iptables unavailable in this guest kernel?) - sandbox networking fails closed",
      );
    }
    fenceApplied = true;
  }

  async function ensureDistro(): Promise<void> {
    const list = await wsl(["-l", "-q"], 15_000);
    if (list.code !== 0)
      throw new Error("wsl2 sandbox: WSL2 is not enabled (enable it from Settings - Sandbox)");
    const names = list.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.includes(distro))
      throw new Error(
        `wsl2 sandbox: rootfs not imported (distro ${distro} missing) - it is imported at app startup; check the boot checklist`,
      );
    const wake = await wsl(["-d", distro, "-u", "root", "--exec", "/bin/true"], 30_000);
    if (wake.code !== 0)
      throw new Error(`wsl2 sandbox: distro ${distro} failed to start: ${wake.stderr.trim() || wake.stdout.trim()}`);
  }

  async function daemon(
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    if (!agentPort) throw new Error("wsl2 sandbox: agent port not assigned");
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`http://127.0.0.1:${agentPort}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-agent-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any(signals),
    });
    if (res.status === 401)
      throw new Error("wsl2 sandbox: agent rejected the per-boot token (stale agent? restart the app)");
    return { status: res.status, text: await res.text() };
  }

  async function waitAgent(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await daemon("/health", undefined, 3000);
        if (res.status === 200) return;
        lastErr = `http ${res.status}`;
      } catch (e) {
        lastErr = errMessage(e);
      }
      await sleep(300);
    }
    throw new Error(`wsl2 sandbox: agent never became reachable: ${lastErr}`);
  }

  async function ensureAgent(): Promise<void> {
    return queue("agent", async () => {
      await ensureDistro();
      if (agentPort) {
        try {
          if ((await daemon("/health", undefined, 3000)).status === 200) return;
        } catch {
          void 0;
        }
      }
      const port = opts.agentPortForTest ?? (await freePort());
      const spawner = opts.spawnWsl ?? defaultSpawnWsl;
      if (spawner) {
        agentChild = spawner(["-d", distro, "-u", "root", "--exec", "node", AGENT_PATH], {
          AGENT_PORT: String(port),
          AGENT_AUTH_TOKEN: token,
          AGENT_RUN_USER: "sandbox",
        });
        agentChild.on("exit", () => {
          agentPort = undefined;
          agentChild = undefined;
        });
      }
      agentPort = port;
      await waitAgent();
      await ensureEgressFence();
    });
  }

  async function execRaw(command: string, timeoutSec: number, signal?: AbortSignal, asRoot = false): Promise<ExecResult> {
    await ensureAgent();
    const res = await daemon(
      "/exec",
      { cmd: command, timeoutSec, ...(asRoot ? { root: true } : {}) },
      (timeoutSec + 15) * 1000,
      signal,
    );
    if (res.status !== 200) throw new Error(`wsl2 sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbsBytes(absPath: string, data: Uint8Array): Promise<void> {
    await ensureAgent();
    const res = await daemon("/write", { path: absPath, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (res.status !== 200)
      throw new Error(`wsl2 sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function readAbsBytes(absPath: string): Promise<Uint8Array | null> {
    await ensureAgent();
    const res = await daemon("/read", { path: absPath }, 120_000);
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`wsl2 sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  function homeFor(handle: { scopeId?: string; scratch?: boolean }): string {
    if (handle.scratch && handle.scopeId) return `/tmp/qm-scratch-${shortHash(handle.scopeId)}`;
    return `/home/qm-${scopeSlug(handle.scopeId ?? "default")}`;
  }

  const profile: AgentComputerProfile = {
    backend: "wsl2",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "domain",
    spec: {
      os: "Debian 12 (bookworm) — WSL2 guest",
      runtimes: ["Node 24", "Python 3"],
      tools: ["git", "curl", "wget", "jq", "unzip", "python3", "pip"],
      homeDir: "/home",
      workdir: "workspace",
    },
  };

  const procIo: ExecProcessIo = {
    run: (handle, command, execOpts) => sandbox.run(handle, command, execOpts),
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "wsl2",
    exec: (_id, script, t) => execRaw(script, t),
    writeInline: (_id, abs, data) => writeAbsBytes(abs, data),
  });

  const execBackup = createExecBackup({
    label: "wsl2",
    exec: (_id, script, t) => execRaw(script, t),
    readAbsBytes: (_id, abs) => readAbsBytes(abs),
    defaultHomeDir: "/home",
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = scratch ? `scratch:${scratch.key}` : (writable?.scopeId ?? "default");
      const home = homeFor({ scopeId: scope, scratch: !!scratch });
      const workspaceDir = posixJoin(home, "workspace");

      return queue(`scope:${scope}`, async () => {
        await ensureAgent();
        const existed = (await execRaw(`test -d ${shq(home)}`, 15)).code === 0;
        const egressEnv: Record<string, string> = egressProxyPort
          ? {
              HTTP_PROXY: `http://127.0.0.1:${egressProxyPort}`,
              HTTPS_PROXY: `http://127.0.0.1:${egressProxyPort}`,
            }
          : {};
        const env = { ...egressEnv, ...(provOpts?.env ?? {}) };
        const handle: SandboxHandle = {
          id: home,
          rootDir: workspaceDir,
          homeDir: home,
          coldStart: !existed,
          ...(scratch ? { scratch: true } : {}),
          backend: "wsl2",
          scopeId: scope,
          ...(Object.keys(env).length ? { env } : {}),
        };
        try {
          const prep = await execRaw(
            `mkdir -p ${shq(workspaceDir)} && chown -R sandbox:sandbox ${shq(home)} && ${ephemeralCredLinkScript(home)}`,
            30,
            undefined,
            true,
          );
          if (prep.code !== 0) throw new Error(`wsl2 sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);
          await materializeRoLayers(
            workspace,
            layers,
            handle,
            {
              readFile: (h, rel) => sandbox.readFile(h, rel),
              writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
              exec: (script, t) => execRaw(script, t, undefined, true),
            },
            { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "wsl2" },
          );
          return handle;
        } catch (err) {
          await sandbox.teardown(handle).catch(swallowAs("wsl2-sandbox: teardown after failed provision", undefined));
          throw err;
        }
      });
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const home = handle.homeDir ? `export HOME=${shq(handle.homeDir)}; ` : "";
      const script = `${nonInteractiveShellPrefix()}${home}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(killScript(killUid), 15, undefined, true).catch(swallowAs("wsl2-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (tdOpts?.destroy) {
        const home = handle.homeDir ?? handle.id;
        await queue(`scope:${handle.scopeId ?? handle.id}`, async () => {
          const r = await execRaw(`rm -rf ${shq(home)}`, 60, undefined, true);
          if (r.code !== 0)
            opts.onError?.({
              category: "sandbox_park",
              code: "wsl2_rm_home_failed",
              message: r.stderr.trim(),
              ...(handle.scopeId ? { scopeLabel: handle.scopeId } : {}),
            });
        });
      }
    },
  };

  return sandbox;
}

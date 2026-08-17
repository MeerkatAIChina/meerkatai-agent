import { execFile } from "node:child_process";

export type WslExec = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnWslExec(wslBin = "wsl.exe"): WslExec {
  return (args, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      execFile(
        wslBin,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
        (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(err);
          const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
          resolve({
            code,
            stdout: decodeWslOut(Buffer.from(stdout)),
            stderr: decodeWslOut(Buffer.from(stderr)),
          });
        },
      );
    });
}

export function decodeWslOut(buf: Buffer): string {
  if (!buf.includes(0)) return buf.toString("utf8");
  let out = "";
  for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16LE(i));
  return out;
}

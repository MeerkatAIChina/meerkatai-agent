import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.EGRESS_PORT || 0);
const ALLOW = (process.env.EGRESS_ALLOW || "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function egressAllowed(host, allowlist) {
  const h = String(host || "").toLowerCase();
  return allowlist.some((d) => h === d || h.endsWith(`.${d}`));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (!isMain) {
} else if (!PORT || ALLOW.length === 0) {
  console.error("[egress-proxy] EGRESS_PORT and EGRESS_ALLOW are required");
  process.exit(1);
} else {
  main();
}

function main() {

const server = http.createServer((req, res) => {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "proxy is CONNECT-only (https)" }));
});

server.on("connect", (req, client, head) => {
  const [host = "", portRaw = "443"] = (req.url || "").split(":");
  if (!egressAllowed(host, ALLOW)) {
    client.end(`HTTP/1.1 403 Forbidden\r\n\r\nhost not in sandbox egress allowlist: ${host}`);
    return;
  }
  const upstream = net.connect(Number(portRaw), host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  client.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`[egress-proxy] listening on 127.0.0.1:${PORT}`));
}

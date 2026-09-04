import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { completeDevSecuritySecrets } from "../scripts/dev/lib/envctx.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

const databaseUrl = "postgres://postgres:qm-dev@127.0.0.1:55432/qm_dev_e19cfa4329dc";
const CORE = "http://127.0.0.1:8081";
const ORG = "acme";
const user = "zamir";

const env = {};
completeDevSecuritySecrets(env, databaseUrl);
const coreSecret = env.CORE_SIGNING_SECRET;
const identitySecret = env.PORTAL_IDENTITY_SECRET;

const threadRef = "web:" + user + ":smoke-" + Date.now();
const turn = {
  surface: "web",
  actor: { externalId: user },
  conversation: { kind: "dm", threadRef },
  liveActor: true,
  deliveryTarget: threadRef,
  text: "Reply with exactly: DEEPSEEK_OK",
};

const path = "/v1/turns";
const body = JSON.stringify(turn);
const identity = mintPortalIdentity({ p: user, exp: Date.now() + 120_000 }, identitySecret);
const headers = {
  "content-type": "application/json",
  ...signedRequestHeaders(coreSecret, "POST", path, body),
  "x-as-principal": user,
  [PORTAL_IDENTITY_HEADER]: identity,
};

console.log("posting turn to", CORE + path);
const res = await fetch(CORE + path, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
const text = await res.text();
console.log("status:", res.status);
console.log("response:", text.slice(0, 3000));

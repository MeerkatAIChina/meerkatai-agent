import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

type FetchLike = typeof fetch;

export interface OidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  issuer: string;
  jwksUri: string;
  expectedTeamId?: string;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(cfg: OidcConfig, args: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(cfg.authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  idToken: string | null;
}

export async function exchangeCode(
  cfg: OidcConfig,
  args: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: args.codeVerifier,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetchImpl(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
      accept: "application/json",
    },
    body: body.toString(),
  });
  const json = await readJson(r, "令牌端点");
  if (!r.ok) throw new Error(`令牌交换失败：HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`令牌交换失败：${String(json.error ?? "ok:false")}`);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("令牌响应缺少 access_token");
  return { accessToken, idToken: typeof json.id_token === "string" ? json.id_token : null };
}

export async function fetchUserinfo(
  cfg: OidcConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const r = await fetchImpl(cfg.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = await readJson(r, "用户信息接口");
  if (!r.ok) throw new Error(`获取用户信息失败：HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`获取用户信息失败：${String(json.error ?? "ok:false")}`);
  return json;
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyIdToken(
  cfg: OidcConfig,
  idToken: string | null,
  nonce: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  if (!idToken) throw new Error("令牌响应缺少 id_token");
  const keySet =
    fetchImpl === fetch
      ? (remoteKeySets.get(cfg.jwksUri) ??
        (() => {
          const created = createRemoteJWKSet(new URL(cfg.jwksUri));
          remoteKeySets.set(cfg.jwksUri, created);
          return created;
        })())
      : createRemoteJWKSet(new URL(cfg.jwksUri), { [customFetch]: fetchImpl });
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error("nonce 校验不一致");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    (audiences.length > 1 && typeof payload.azp !== "string") ||
    (payload.azp !== undefined && payload.azp !== cfg.clientId)
  ) {
    throw new Error("令牌授权方校验不一致");
  }
  return payload as JWTPayload & Record<string, unknown>;
}

export interface PrincipalRule {
  claim: "sub" | "email";
  allowedEmailDomain?: string;
  allowedEmails?: readonly string[];
}

export function resolvePrincipal(
  rule: PrincipalRule,
  args: { sub: string; claims: Record<string, unknown>; userinfo: Record<string, unknown> },
): string {
  if (rule.claim === "sub") return args.sub;
  const rawEmail = args.userinfo.email;
  if (typeof rawEmail !== "string" || !rawEmail.includes("@")) throw new Error("身份供应商未返回邮箱");
  const verified = args.userinfo.email_verified;
  if (verified !== true && verified !== "true") throw new Error("邮箱未经身份供应商验证");
  const email = rawEmail.trim().toLowerCase();
  if (
    rule.allowedEmails?.length &&
    !rule.allowedEmails.map((allowed) => allowed.trim().toLowerCase()).includes(email)
  ) {
    throw new Error("账号不在允许的邮箱列表中");
  }
  if (rule.allowedEmailDomain) {
    const domain = rule.allowedEmailDomain.toLowerCase();
    if (!email.endsWith(`@${domain}`)) throw new Error("账号不在允许的域名范围内");
    const hd = args.userinfo.hd ?? args.claims.hd;
    if (typeof hd === "string" && hd.toLowerCase() !== domain)
      throw new Error("账号不在允许的域名范围内");
  }
  return email;
}

async function readJson(r: Response, what: string): Promise<Record<string, unknown>> {
  const text = await r.text();
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${what}返回非 JSON 响应（HTTP ${r.status}）`);
  }
}

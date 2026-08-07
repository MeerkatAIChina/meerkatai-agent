export interface SensitivityVerdict {
  level: "L1" | "L2" | "L3";
  domain: "triz" | "general";
  route?: {
    policy: string;
    model: string;
    harnessId: string;
    sessionPin: boolean;
  };
}

const VALID_LEVELS = new Set(["L1", "L2", "L3"]);
const VALID_DOMAINS = new Set(["triz", "general"]);
const ROUTE_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/;
const HARNESS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function parseSensitivityVerdict(body: string): SensitivityVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const level = obj["level"];
  if (typeof level !== "string" || !VALID_LEVELS.has(level)) return null;
  const domain = obj["domain"];
  if (typeof domain !== "string" || !VALID_DOMAINS.has(domain)) return null;

  const route = obj["route"];
  if (route === undefined || route === null) {
    return { level: level as SensitivityVerdict["level"], domain: domain as SensitivityVerdict["domain"] };
  }
  if (typeof route !== "object" || Array.isArray(route)) return null;
  const r = route as Record<string, unknown>;

  if (typeof r["policy"] !== "string" || !ROUTE_KEY_RE.test(r["policy"])) return null;
  if (typeof r["model"] !== "string" || !MODEL_ID_RE.test(r["model"])) return null;
  if (typeof r["harness_id"] !== "string" || !HARNESS_ID_RE.test(r["harness_id"])) return null;
  if (typeof r["session_pin"] !== "boolean") return null;

  return {
    level: level as SensitivityVerdict["level"],
    domain: domain as SensitivityVerdict["domain"],
    route: {
      policy: r["policy"],
      model: r["model"],
      harnessId: r["harness_id"],
      sessionPin: r["session_pin"],
    },
  };
}

export interface ClassifyRequest {
  text: string;
  hook: "user_input";
  metadata: { scope_id: string; org_scope_id: string; surface?: string };
}

export interface ClassifyResponse {
  level: "L1" | "L2" | "L3";
  domain: "triz" | "general";
  route?: { policy: string; model: string; harness_id: string; session_pin: boolean };
}

export interface RouteConfig {
  [policy: string]: { harnessId: string; modelId: string; providerId: string };
}

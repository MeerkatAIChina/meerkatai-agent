import { readFileSync } from "node:fs";
import { detectPii } from "./rules/pii.ts";
import { detectTrizKeywords } from "./rules/triz_keywords.ts";
import { checkScopeSensitivity } from "./context/scope_labels.ts";
import { classifySemantic } from "./semantic/classifier.ts";
import type { ClassifyResponse, RouteConfig } from "./types.ts";

let routes: RouteConfig = {};

export function loadRoutes(path: string): void {
  routes = JSON.parse(readFileSync(path, "utf8")) as RouteConfig;
}

function resolveRoute(policy: string): ClassifyResponse["route"] {
  const cfg = routes[policy];
  if (!cfg) return undefined;
  return { policy, model: cfg.modelId, harness_id: cfg.harnessId, session_pin: false };
}

export interface PipelineInput {
  text: string;
  scopeId: string;
}

export async function runPipeline(input: PipelineInput): Promise<ClassifyResponse> {
  const pii = detectPii(input.text);
  if (pii) {
    const route = resolveRoute("local-secure");
    if (route) route.session_pin = true;
    return { level: "L1", domain: "general", route };
  }

  const triz = detectTrizKeywords(input.text);
  if (triz) {
    const route = resolveRoute("meerkat-triz-v1");
    return { level: "L3", domain: "triz", route };
  }

  const scope = checkScopeSensitivity(input.scopeId);
  if (scope) {
    const route = resolveRoute("local-secure");
    if (route) route.session_pin = true;
    return { level: scope, domain: "general", route };
  }

  try {
    const semantic = await classifySemantic(input.text);
    if (semantic.level === "L1" || semantic.level === "L2") {
      const route = resolveRoute("local-secure");
      if (route) route.session_pin = true;
      return { level: "L1", domain: semantic.domain, route };
    }
    if (semantic.domain === "triz") {
      const route = resolveRoute("meerkat-triz-v1");
      return { level: "L3", domain: "triz", route };
    }
  } catch (err) {
    if (err instanceof Error && err.message === "semantic classifier not configured") {
      return { level: "L3", domain: "general" };
    }
    const route = resolveRoute("local-secure");
    if (route) route.session_pin = true;
    return { level: "L1", domain: "general", route };
  }

  return { level: "L3", domain: "general" };
}

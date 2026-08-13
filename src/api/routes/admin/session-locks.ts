import { isHarnessId, modelSupportedByHarness, resolveModel } from "../../../model/pi-models.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { requireScopedResource } from "./common.ts";

export async function listSessionLocks(ctx: ApiCtx): Promise<void> {
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  if (!ctx.deps.sessionLockStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const entries = await ctx.deps.sessionLockStore.entries();
  const locks = await Promise.all(
    entries.map(async ([sessionId, lock]) => {
      const session = await ctx.deps.sessions?.get(sessionId);
      return {
        sessionId,
        harnessId: lock.harnessId,
        modelId: lock.modelId,
        ...(session ? { title: session.title ?? null, scopeId: session.scopeId } : {}),
      };
    }),
  );
  audit(ctx.deps, {
    principalId: authz.actor.id,
    action: "session_lock.list",
    resource: "session-locks",
    scopeLabel: authz.scope,
  });
  return sendJson(ctx.res, 200, { locks });
}

export async function retargetSessionLock(ctx: ApiCtx): Promise<void> {
  const id = ctx.params.id;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const scoped = await requireScopedResource(ctx, () => ctx.deps.sessions?.get(id), (s) => s.scopeId, "session");
  if (!scoped) return;
  if (!ctx.deps.sessionLockStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const existing = await ctx.deps.sessionLockStore.get(id);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found", message: "session is not locked" });
  const body = ctx.body as { harnessId?: unknown; modelId?: unknown };
  const harnessId = typeof body.harnessId === "string" ? body.harnessId.trim() : "";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (!harnessId || !modelId) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "harnessId and modelId are required" });
  }
  if (!isHarnessId(harnessId) || !resolveModel(modelId) || !modelSupportedByHarness(modelId, harnessId)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `runtime ${harnessId}/${modelId} is not a selectable model on this deployment`,
    });
  }
  const approved = (await ctx.deps.config?.getApprovedHarnessesDurable()) ?? null;
  if (approved && !approved.includes(harnessId)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `harness ${harnessId} is not approved` });
  }
  await ctx.deps.sessionLockStore.put(id, { harnessId, modelId });
  audit(ctx.deps, {
    principalId: scoped.actor.id,
    action: "session_lock.retargeted",
    resource: id,
    scopeLabel: scoped.record.scopeId,
    detail: JSON.stringify({ from: existing, to: { harnessId, modelId } }),
  });
  return sendJson(ctx.res, 200, { ok: true, sessionId: id, lock: { harnessId, modelId } });
}

export async function releaseSessionLock(ctx: ApiCtx): Promise<void> {
  const id = ctx.params.id;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const scoped = await requireScopedResource(ctx, () => ctx.deps.sessions?.get(id), (s) => s.scopeId, "session");
  if (!scoped) return;
  if (!ctx.deps.sessionLockStore) return sendJson(ctx.res, 404, { error: "not_found" });
  const existing = await ctx.deps.sessionLockStore.get(id);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found", message: "session is not locked" });
  await ctx.deps.sessionLockStore.delete(id);
  audit(ctx.deps, {
    principalId: scoped.actor.id,
    action: "session_lock.released",
    resource: id,
    scopeLabel: scoped.record.scopeId,
    detail: JSON.stringify({ previous: existing }),
  });
  return sendJson(ctx.res, 200, { ok: true, sessionId: id, released: existing });
}

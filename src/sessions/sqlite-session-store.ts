import { randomUUID } from "node:crypto";
import { openSqliteDatabase } from "../persistence/sqlite-map.ts";
import type { Session, SessionEntry, ScopeId } from "../types.ts";
import type {
  AttributedTurn,
  CronGroupSummary,
  GetEntriesOptions,
  GetTapeOptions,
  LeaseAttempt,
  LeaseHolder,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ParticipantWindow,
  ScopeSessionStats,
  SessionPage,
  SessionStore,
  SessionSummary,
  StoreOptions,
  TapeRecord,
} from "./session-store.ts";
import {
  cronIdOf,
  isOverheardEntry,
  sessionBucket,
  sessionCategory,
  sessionOrigin,
  userMessagePreview,
} from "./session-store.ts";

type Row = Record<string, unknown>;

function idDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

function num(v: unknown): number {
  return Number(v);
}

function nullableNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function boolInt(v: boolean | undefined): number | null {
  if (v == null) return null;
  return v ? 1 : 0;
}

function rowToSession(r: Row): Session {
  return {
    id: r.id as string,
    type: r.type as Session["type"],
    scopeId: r.scope_id as ScopeId,
    threadRef: r.thread_ref as string,
    createdAt: num(r.created_at),
    ...(r.title != null ? { title: r.title as string } : {}),
    ...(r.channel_name != null ? { channelName: r.channel_name as string } : {}),
    ...(r.surface != null ? { surface: r.surface as string } : {}),
    ...(r.forked_from_session_id != null && r.fork_boundary_seq != null
      ? {
          forkedFrom: {
            sessionId: r.forked_from_session_id as string,
            ...(r.forked_from_title != null ? { title: r.forked_from_title as string } : {}),
          },
          forkBoundarySeq: num(r.fork_boundary_seq),
        }
      : {}),
  };
}

function rowToEntry(r: Row): SessionEntry {
  return {
    sessionId: r.session_id as string,
    seq: num(r.seq),
    parentSeq: nullableNum(r.parent_seq),
    type: r.type as SessionEntry["type"],
    payload: JSON.parse(r.payload as string),
    scopeLabel: r.scope_label as ScopeId,
    createdAt: num(r.created_at),
  };
}

function rowToTape(r: Row): TapeRecord {
  const meta: NonNullable<TapeRecord["meta"]> = {};
  if (r.bare_text != null) meta.bareText = r.bare_text as string;
  if (r.ts != null) meta.ts = r.ts as string;
  if (r.change_time != null) meta.changeTime = r.change_time as string;
  if (r.hidden != null) meta.hidden = num(r.hidden) !== 0;
  if (r.overheard != null) meta.overheard = num(r.overheard) !== 0;
  if (r.author != null) meta.author = r.author as string;
  return {
    kind: r.kind as TapeRecord["kind"],
    payload: JSON.parse(r.payload as string),
    scopeLabel: r.scope_label as ScopeId,
    ...(r.harness != null ? { harness: r.harness as string } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(r.entry_seq != null ? { entrySeq: num(r.entry_seq) } : {}),
    ...(r.covers_entry_seq != null ? { coversEntrySeq: num(r.covers_entry_seq) } : {}),
    sessionId: r.session_id as string,
    seq: num(r.seq),
    createdAt: num(r.created_at),
  };
}

function rowToLlmRequest(r: Row): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: nullableNum(r.turn_seq),
    step: num(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: num(r.created_at),
    request: JSON.parse(r.request as string),
    truncated: num(r.truncated) !== 0,
    ttftMs: nullableNum(r.ttft_ms),
    durationMs: nullableNum(r.duration_ms),
    stepGapMs: nullableNum(r.step_gap_ms),
    toolWallMs: r.tool_wall_json != null ? (JSON.parse(r.tool_wall_json as string) as number[]) : null,
    gapPhases: r.gap_phases_json != null ? JSON.parse(r.gap_phases_json as string) : null,
    usage: r.usage_json != null ? JSON.parse(r.usage_json as string) : null,
    transport: r.transport_json != null ? JSON.parse(r.transport_json as string) : null,
  };
}

interface WindowRow {
  validFrom: number;
  validTo: number | null;
  validFromSeq: number;
  validToSeq: number | null;
  title: string | null;
  archived: boolean;
  pinned: boolean;
  color: string | null;
}

function rowToWindow(r: Row): WindowRow {
  return {
    validFrom: num(r.valid_from),
    validTo: nullableNum(r.valid_to),
    validFromSeq: num(r.valid_from_seq),
    validToSeq: nullableNum(r.valid_to_seq),
    title: (r.title as string | null) ?? null,
    archived: num(r.archived) !== 0,
    pinned: num(r.pinned) !== 0,
    color: (r.color as string | null) ?? null,
  };
}

export function createSqliteSessionStore(sqlitePath: string, opts: StoreOptions = {}): SessionStore & {
  close(): void;
} {
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;
  const db = openSqliteDatabase(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_id TEXT NOT NULL,
      thread_ref TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL,
      title TEXT, channel_name TEXT, surface TEXT, last_activity INTEGER,
      messages INTEGER, turns INTEGER,
      forked_from_session_id TEXT, forked_from_title TEXT, fork_boundary_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_entries (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_seq INTEGER,
      type TEXT NOT NULL, payload TEXT, scope_label TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS participants (
      session_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      valid_from INTEGER NOT NULL, valid_to INTEGER, valid_from_seq INTEGER, valid_to_seq INTEGER,
      title TEXT, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, color TEXT,
      PRIMARY KEY (session_id, principal_id)
    );
    CREATE TABLE IF NOT EXISTS session_leases (
      session_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
      holder TEXT, acquired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_tape (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      kind TEXT NOT NULL, harness TEXT, payload TEXT NOT NULL, scope_label TEXT NOT NULL,
      bare_text TEXT, ts TEXT, change_time TEXT, hidden INTEGER, overheard INTEGER, author TEXT,
      entry_seq INTEGER, covers_entry_seq INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS session_llm_requests (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_seq INTEGER,
      step INTEGER NOT NULL, model TEXT NOT NULL, scope_label TEXT NOT NULL,
      request TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      ttft_ms INTEGER, duration_ms INTEGER, step_gap_ms INTEGER,
      tool_wall_json TEXT, usage_json TEXT, transport_json TEXT, gap_phases_json TEXT
    );
  `);

  const q = {
    sessionByThread: db.prepare("SELECT * FROM sessions WHERE thread_ref = ?"),
    sessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    insertSession: db.prepare(
      "INSERT INTO sessions (id, type, scope_id, thread_ref, created_at, title, channel_name, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    updateChannelName: db.prepare("UPDATE sessions SET channel_name = ? WHERE id = ?"),
    updateSurface: db.prepare("UPDATE sessions SET surface = ? WHERE id = ?"),
    updateTitle: db.prepare("UPDATE sessions SET title = ? WHERE id = ?"),
    updateFork: db.prepare(
      "UPDATE sessions SET forked_from_session_id = ?, forked_from_title = ?, fork_boundary_seq = ? WHERE id = ?",
    ),
    allSessions: db.prepare("SELECT * FROM sessions ORDER BY rowid"),
    deleteSessionRow: db.prepare("DELETE FROM sessions WHERE id = ?"),
    leaseById: db.prepare("SELECT * FROM session_leases WHERE session_id = ?"),
    upsertLease: db.prepare(
      "INSERT INTO session_leases (session_id, token, expires_at, holder, acquired_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, holder = excluded.holder, acquired_at = excluded.acquired_at",
    ),
    extendLease: db.prepare("UPDATE session_leases SET expires_at = ? WHERE session_id = ?"),
    releaseLease: db.prepare("DELETE FROM session_leases WHERE session_id = ? AND token = ?"),
    dropLease: db.prepare("DELETE FROM session_leases WHERE session_id = ?"),
    entryCount: db.prepare("SELECT COUNT(*) AS n FROM session_entries WHERE session_id = ?"),
    insertEntry: db.prepare(
      "INSERT INTO session_entries (session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    entriesSince: db.prepare("SELECT * FROM session_entries WHERE session_id = ? AND seq >= ? ORDER BY seq"),
    entriesAll: db.prepare("SELECT * FROM session_entries WHERE session_id = ? ORDER BY seq"),
    deleteEntries: db.prepare("DELETE FROM session_entries WHERE session_id = ?"),
    tapeCount: db.prepare("SELECT COUNT(*) AS n FROM session_tape WHERE session_id = ?"),
    insertTape: db.prepare(
      "INSERT INTO session_tape (session_id, seq, kind, harness, payload, scope_label, bare_text, ts, change_time, hidden, overheard, author, entry_seq, covers_entry_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    tapeAll: db.prepare("SELECT * FROM session_tape WHERE session_id = ? ORDER BY seq"),
    tapeSince: db.prepare("SELECT * FROM session_tape WHERE session_id = ? AND seq > ? ORDER BY seq"),
    deleteTape: db.prepare("DELETE FROM session_tape WHERE session_id = ?"),
    insertLlm: db.prepare(
      "INSERT INTO session_llm_requests (id, session_id, turn_seq, step, model, scope_label, request, truncated, created_at, ttft_ms, duration_ms, step_gap_ms, tool_wall_json, usage_json, transport_json, gap_phases_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    llmBySession: db.prepare("SELECT * FROM session_llm_requests WHERE session_id = ? ORDER BY rowid"),
    deleteLlm: db.prepare("DELETE FROM session_llm_requests WHERE session_id = ?"),
    windowGet: db.prepare("SELECT * FROM participants WHERE session_id = ? AND principal_id = ?"),
    windowInsert: db.prepare(
      "INSERT INTO participants (session_id, principal_id, valid_from, valid_to, valid_from_seq, valid_to_seq, title, archived, pinned, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, principal_id) DO UPDATE SET valid_from = excluded.valid_from, valid_to = excluded.valid_to, valid_from_seq = excluded.valid_from_seq, valid_to_seq = excluded.valid_to_seq, title = excluded.title",
    ),
    windowResetHistory: db.prepare(
      "UPDATE participants SET valid_from = 0, valid_from_seq = 0 WHERE session_id = ? AND principal_id = ?",
    ),
    windowSetTitle: db.prepare("UPDATE participants SET title = ? WHERE session_id = ? AND principal_id = ?"),
    windowSetArchived: db.prepare("UPDATE participants SET archived = ? WHERE session_id = ? AND principal_id = ?"),
    windowSetPinned: db.prepare("UPDATE participants SET pinned = ? WHERE session_id = ? AND principal_id = ?"),
    windowSetColor: db.prepare("UPDATE participants SET color = ? WHERE session_id = ? AND principal_id = ?"),
    windowClose: db.prepare(
      "UPDATE participants SET valid_to = ?, valid_to_seq = ? WHERE session_id = ? AND principal_id = ? AND valid_to IS NULL",
    ),
    windowsByPrincipal: db.prepare("SELECT * FROM participants WHERE principal_id = ? ORDER BY rowid"),
    windowsBySession: db.prepare("SELECT * FROM participants WHERE session_id = ? ORDER BY rowid"),
    allWindows: db.prepare("SELECT * FROM participants ORDER BY rowid"),
    deleteWindows: db.prepare("DELETE FROM participants WHERE session_id = ?"),
  };

  const sessionRow = (id: string): Row | undefined => q.sessionById.get(id) as Row | undefined;
  const entriesOf = (sessionId: string): SessionEntry[] =>
    (q.entriesAll.all(sessionId) as Row[]).map(rowToEntry);
  const entryCountOf = (sessionId: string): number => num((q.entryCount.get(sessionId) as Row).n);
  const windowRow = (sessionId: string, principalId: string): WindowRow | null => {
    const r = q.windowGet.get(sessionId, principalId) as Row | undefined;
    return r ? rowToWindow(r) : null;
  };

  const store: SessionStore & { close(): void } = {
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface) {
      const existing = q.sessionByThread.get(threadRef) as Row | undefined;
      if (existing) {
        const s = rowToSession(existing);
        if (channelName && s.channelName !== channelName) {
          q.updateChannelName.run(channelName, s.id);
          s.channelName = channelName;
        }
        if (surface && !s.surface) {
          q.updateSurface.run(surface, s.id);
          s.surface = surface;
        }
        return s;
      }
      const session: Session = {
        id: randomUUID(),
        type,
        scopeId,
        threadRef,
        createdAt: Date.now(),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
      };
      q.insertSession.run(
        session.id,
        session.type,
        session.scopeId,
        session.threadRef,
        session.createdAt,
        session.title ?? null,
        session.channelName ?? null,
        session.surface ?? null,
      );
      return session;
    },

    async getByThread(threadRef) {
      const r = q.sessionByThread.get(threadRef) as Row | undefined;
      return r ? rowToSession(r) : null;
    },

    async get(id) {
      const r = sessionRow(id);
      return r ? rowToSession(r) : null;
    },

    async updateTitle(sessionId, title) {
      q.updateTitle.run(title, sessionId);
    },

    async updateForkProvenance(sessionId, provenance) {
      q.updateFork.run(
        provenance.forkedFrom.sessionId,
        provenance.forkedFrom.title ?? null,
        provenance.forkBoundarySeq,
        sessionId,
      );
    },

    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      const held = q.leaseById.get(sessionId) as Row | undefined;
      if (held && now() < num(held.expires_at)) {
        return {
          lease: null,
          ...(held.holder != null ? { heldBy: held.holder as LeaseHolder } : {}),
          heldSince: num(held.acquired_at),
          heldUntil: num(held.expires_at),
        };
      }
      const token = randomUUID();
      q.upsertLease.run(sessionId, token, now() + leaseTtlMs, holder ?? null, now());
      return { lease: { sessionId, token } };
    },

    async releaseLease(lease) {
      q.releaseLease.run(lease.sessionId, lease.token);
    },

    async forceReleaseLease(sessionId) {
      q.dropLease.run(sessionId);
    },

    async append(lease, entry: NewEntry): Promise<SessionEntry> {
      const held = q.leaseById.get(lease.sessionId) as Row | undefined;
      if (!held || held.token !== lease.token) {
        throw new Error("append without a valid session lease");
      }
      q.extendLease.run(now() + leaseTtlMs, lease.sessionId);
      if (!sessionRow(lease.sessionId)) throw new Error(`unknown session: ${lease.sessionId}`);
      const seq = entryCountOf(lease.sessionId);
      const full: SessionEntry = {
        sessionId: lease.sessionId,
        seq,
        parentSeq: seq === 0 ? null : seq - 1,
        type: entry.type,
        payload: entry.payload,
        scopeLabel: entry.scopeLabel as ScopeId,
        createdAt: now(),
      };
      q.insertEntry.run(
        lease.sessionId,
        seq,
        full.parentSeq,
        full.type,
        JSON.stringify(full.payload ?? null),
        full.scopeLabel,
        full.createdAt,
      );
      return full;
    },

    async getEntries(sessionId, opts?: GetEntriesOptions) {
      const since = opts?.sinceSeq ?? 0;
      const rows = q.entriesSince.all(sessionId, since) as Row[];
      const filtered = rows.map(rowToEntry);
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : filtered;
    },

    async appendTape(lease, rec: NewTapeRecord): Promise<TapeRecord> {
      const held = q.leaseById.get(lease.sessionId) as Row | undefined;
      if (!held || held.token !== lease.token) throw new Error("tape append without a valid session lease");
      q.extendLease.run(now() + leaseTtlMs, lease.sessionId);
      const seq = num((q.tapeCount.get(lease.sessionId) as Row).n);
      const full: TapeRecord = { ...rec, sessionId: lease.sessionId, seq, createdAt: now() };
      q.insertTape.run(
        lease.sessionId,
        seq,
        rec.kind,
        rec.harness ?? null,
        JSON.stringify(rec.payload ?? null),
        rec.scopeLabel,
        rec.meta?.bareText ?? null,
        rec.meta?.ts ?? null,
        rec.meta?.changeTime ?? null,
        boolInt(rec.meta?.hidden),
        boolInt(rec.meta?.overheard),
        rec.meta?.author ?? null,
        rec.entrySeq ?? null,
        rec.coversEntrySeq ?? null,
        full.createdAt,
      );
      return full;
    },

    async getTape(sessionId, opts?: GetTapeOptions) {
      const rows = (
        opts?.sinceSeq !== undefined
          ? (q.tapeSince.all(sessionId, opts.sinceSeq) as Row[])
          : (q.tapeAll.all(sessionId) as Row[])
      ).map(rowToTape);
      return opts?.limit !== undefined ? rows.slice(-opts.limit) : rows;
    },

    async tapeCoverage(sessionId) {
      const log = (q.tapeAll.all(sessionId) as Row[]).map(rowToTape);
      return log.reduce(
        (m, r) =>
          Math.max(
            m,
            r.kind === "annotation" && (r.payload as { turnEnd?: unknown } | null)?.turnEnd === true
              ? (r.entrySeq ?? -1)
              : -1,
            r.kind === "context_event" && (r.payload as { event?: unknown } | null)?.event === "legacy_import"
              ? (r.coversEntrySeq ?? -1)
              : -1,
          ),
        -1,
      );
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest) {
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        request: rec.request,
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        stepGapMs: rec.stepGapMs ?? null,
        toolWallMs: rec.toolWallMs ?? null,
        gapPhases: rec.gapPhases ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      q.insertLlm.run(
        full.id,
        sessionId,
        full.turnSeq,
        full.step,
        full.model,
        full.scopeLabel,
        JSON.stringify(full.request ?? null),
        full.truncated ? 1 : 0,
        full.createdAt,
        full.ttftMs,
        full.durationMs,
        full.stepGapMs,
        full.toolWallMs != null ? JSON.stringify(full.toolWallMs) : null,
        full.usage != null ? JSON.stringify(full.usage) : null,
        full.transport != null ? JSON.stringify(full.transport) : null,
        full.gapPhases != null ? JSON.stringify(full.gapPhases) : null,
      );
      return full;
    },

    async listLlmRequests(sessionId, opts) {
      const all = (q.llmBySession.all(sessionId) as Row[]).map(rowToLlmRequest);
      const want = opts?.turnSeqs ? new Set(opts.turnSeqs) : null;
      const filtered =
        want || opts?.orphans
          ? all.filter(
              (r) =>
                (want != null && r.turnSeq !== null && want.has(r.turnSeq)) || (!!opts?.orphans && r.turnSeq === null),
            )
          : all;
      return filtered.map((r) => (opts?.omitRequest ? { ...r, request: null } : { ...r }));
    },

    async addParticipant(sessionId, principalId, title, opts) {
      const includeHistory = opts?.includeHistory === true;
      const existing = windowRow(sessionId, principalId);
      if (!existing || existing.validTo !== null) {
        const retainedTitle = title !== undefined ? title : (existing?.title ?? undefined);
        q.windowInsert.run(
          sessionId,
          principalId,
          includeHistory ? 0 : now(),
          null,
          includeHistory ? 0 : entryCountOf(sessionId),
          null,
          retainedTitle ?? null,
          existing?.archived ? 1 : 0,
          existing?.pinned ? 1 : 0,
          existing?.color ?? null,
        );
      } else {
        if (includeHistory) q.windowResetHistory.run(sessionId, principalId);
        if (title !== undefined) q.windowSetTitle.run(title, sessionId, principalId);
      }
    },

    async removeParticipant(sessionId, principalId) {
      q.windowClose.run(now(), entryCountOf(sessionId), sessionId, principalId);
    },

    async listByParticipant(principalId) {
      const rows = q.windowsByPrincipal.all(principalId) as Row[];
      const out: Session[] = [];
      for (const w of rows) {
        const sessionId = w.session_id as string;
        const s = sessionRow(sessionId);
        if (!s) continue;
        const session = rowToSession(s);
        const view = rowToWindow(w);
        const all = entriesOf(sessionId);
        const log = all.filter((e) => e.type === "user");
        const lastActivityAt = log.length ? Math.max(session.createdAt, ...log.map((e) => e.createdAt)) : session.createdAt;
        const visible = all.some(
          (e) => e.seq >= view.validFromSeq && (view.validToSeq === null || e.seq < view.validToSeq),
        );
        out.push({
          ...session,
          ...(view.title != null ? { title: view.title } : {}),
          ...(view.archived ? { archived: true } : {}),
          ...(view.pinned ? { pinned: true } : {}),
          ...(view.color != null ? { color: view.color } : {}),
          lastActivityAt,
          hasEntries: visible,
        });
      }
      return out;
    },

    async deleteSession(sessionId) {
      q.deleteSessionRow.run(sessionId);
      q.deleteEntries.run(sessionId);
      q.deleteWindows.run(sessionId);
      q.dropLease.run(sessionId);
      q.deleteTape.run(sessionId);
      q.deleteLlm.run(sessionId);
    },

    async updateParticipantView(sessionId, principalId, patch) {
      if (patch.title !== undefined) q.windowSetTitle.run(patch.title, sessionId, principalId);
      if (patch.archived !== undefined) q.windowSetArchived.run(patch.archived ? 1 : 0, sessionId, principalId);
      if (patch.pinned !== undefined) q.windowSetPinned.run(patch.pinned ? 1 : 0, sessionId, principalId);
      if (patch.color !== undefined) q.windowSetColor.run(patch.color, sessionId, principalId);
    },

    async visibleEntries(sessionId, principalId) {
      const win = windowRow(sessionId, principalId);
      if (!win) return [];
      const log = entriesOf(sessionId);
      return log.filter((e) => e.seq >= win.validFromSeq && (win.validToSeq === null || e.seq < win.validToSeq));
    },

    async listAll() {
      return (q.allSessions.all() as Row[]).map(rowToSession);
    },

    async sessionsByThreadRefs(threadRefs) {
      const wanted = new Set(threadRefs);
      return (q.allSessions.all() as Row[])
        .map(rowToSession)
        .filter((s) => wanted.has(s.threadRef))
        .map((s) => ({ id: s.id, threadRef: s.threadRef, scopeId: s.scopeId, type: s.type, title: s.title ?? null }));
    },

    async distinctScopes() {
      const byScope = new Map<string, string | undefined>();
      for (const s of (q.allSessions.all() as Row[]).map(rowToSession)) {
        const prev = byScope.get(s.scopeId);
        if (!byScope.has(s.scopeId) || (s.channelName && !prev)) byScope.set(s.scopeId, s.channelName);
      }
      return [...byScope].map(([scopeId, channelName]) => ({ scopeId: scopeId as ScopeId, ...(channelName ? { channelName } : {}) }));
    },

    async scopeSessionSummaries(
      scope,
      orgWide,
      page?: SessionPage,
      includePreviews = true,
      sessionIds?: string[],
    ): Promise<SessionSummary[]> {
      const idSet = sessionIds ? new Set(sessionIds) : null;
      const out: SessionSummary[] = [];
      for (const s of (q.allSessions.all() as Row[]).map(rowToSession)) {
        if (!orgWide && s.scopeId !== scope) continue;
        if (idSet && !idSet.has(s.id)) continue;
        const origin = sessionOrigin(s.threadRef);
        if (page?.category && sessionCategory(origin) !== page.category) continue;
        if (
          page?.origin === "other_background"
            ? origin === "conversation" || origin === "cron"
            : page?.origin && origin !== page.origin
        )
          continue;
        if (page?.cronId && cronIdOf(s.threadRef) !== page.cronId) continue;
        const log = entriesOf(s.id);
        const userEntries = log.filter((e) => e.type === "user" && !isOverheardEntry(e));
        out.push({
          id: s.id,
          type: s.type,
          origin,
          scopeId: s.scopeId,
          threadRef: s.threadRef,
          turns: userEntries.length,
          messages: log.length,
          lastActivity: log.length ? log[log.length - 1]!.createdAt : s.createdAt,
          createdAt: s.createdAt,
          firstMessage: includePreviews && userEntries.length ? userMessagePreview(userEntries[0]!.payload) : "",
          lastMessage:
            includePreviews && userEntries.length
              ? userMessagePreview(userEntries[userEntries.length - 1]!.payload, 100)
              : "",
        });
      }
      out.sort((a, b) => b.lastActivity - a.lastActivity || idDesc(a.id, b.id));
      if (!page) return out;
      const before = page.before;
      if (before) {
        return out
          .filter(
            (r) => r.lastActivity < before.lastActivity || (r.lastActivity === before.lastActivity && r.id < before.id),
          )
          .slice(0, page.limit);
      }
      return out.slice(page.offset, page.offset + page.limit);
    },

    async lastUserMessages(sessionIds) {
      const out = new Map<string, string>();
      for (const id of sessionIds) {
        const log = entriesOf(id);
        const userEntries = log.filter((e) => e.type === "user" && !isOverheardEntry(e));
        if (userEntries.length) out.set(id, userMessagePreview(userEntries[userEntries.length - 1]!.payload, 100));
      }
      return out;
    },

    async scopeCronGroups(scope, orgWide): Promise<CronGroupSummary[]> {
      const groups = new Map<string, CronGroupSummary>();
      for (const s of (q.allSessions.all() as Row[]).map(rowToSession)) {
        if (!orgWide && s.scopeId !== scope) continue;
        const cronId = cronIdOf(s.threadRef);
        if (!cronId) continue;
        const log = entriesOf(s.id);
        const turns = log.filter((e) => e.type === "user" && !isOverheardEntry(e)).length;
        const lastActivity = log.length ? log[log.length - 1]!.createdAt : s.createdAt;
        const g = groups.get(cronId) ?? {
          cronId,
          scopeId: s.scopeId,
          sessions: 0,
          turns: 0,
          messages: 0,
          lastActivity: 0,
          createdAt: s.createdAt,
        };
        g.sessions += 1;
        g.turns += turns;
        g.messages += log.length;
        g.lastActivity = Math.max(g.lastActivity, lastActivity);
        g.createdAt = Math.min(g.createdAt, s.createdAt);
        groups.set(cronId, g);
      }
      return [...groups.values()].sort((a, b) => {
        if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
        if (a.cronId < b.cronId) return 1;
        if (a.cronId > b.cronId) return -1;
        return 0;
      });
    },

    async scopeSessionStats(scope, orgWide, category, originFilter, cronId): Promise<ScopeSessionStats> {
      const byType: Record<string, number> = {};
      const byTypeAll: Record<string, number> = {};
      const totalByCategory = { conversation: 0, background: 0, all: 0 };
      const cronIds = new Set<string>();
      let total = 0;
      let turns = 0;
      for (const s of (q.allSessions.all() as Row[]).map(rowToSession)) {
        if (!orgWide && s.scopeId !== scope) continue;
        const origin = sessionOrigin(s.threadRef);
        const cat = sessionCategory(origin);
        totalByCategory[cat]++;
        totalByCategory.all++;
        const bucket = sessionBucket(origin, s.type);
        byTypeAll[bucket] = (byTypeAll[bucket] ?? 0) + 1;
        const sessionCronId = cronIdOf(s.threadRef);
        if (sessionCronId != null) cronIds.add(sessionCronId);
        if (category && cat !== category) continue;
        if (
          originFilter === "other_background"
            ? origin === "conversation" || origin === "cron"
            : originFilter && origin !== originFilter
        )
          continue;
        if (cronId && sessionCronId !== cronId) continue;
        total++;
        const log = entriesOf(s.id);
        turns += log.filter((e) => e.type === "user" && !isOverheardEntry(e)).length;
        byType[bucket] = (byType[bucket] ?? 0) + 1;
      }
      return { total, turns, byType, byTypeAll, totalByCategory, crons: cronIds.size };
    },

    async attributedTurns(): Promise<AttributedTurn[]> {
      const DAY = 86_400_000;
      const out: AttributedTurn[] = [];
      for (const w of q.allWindows.all() as Row[]) {
        const sessionId = w.session_id as string;
        const principalId = w.principal_id as string;
        const win = rowToWindow(w);
        const log = entriesOf(sessionId).filter((e) => e.type === "user" && !isOverheardEntry(e));
        const buckets = new Map<number, { turns: number; firstAt: number; lastAt: number }>();
        for (const e of log) {
          const t = e.createdAt;
          if (e.seq < win.validFromSeq || (win.validToSeq !== null && e.seq >= win.validToSeq)) continue;
          const day = Math.floor(t / DAY);
          const b = buckets.get(day);
          if (b) {
            b.turns += 1;
            if (t < b.firstAt) b.firstAt = t;
            if (t > b.lastAt) b.lastAt = t;
          } else buckets.set(day, { turns: 1, firstAt: t, lastAt: t });
        }
        for (const [day, b] of buckets)
          out.push({ principalId, sessionId, day, turns: b.turns, firstAt: b.firstAt, lastAt: b.lastAt });
      }
      return out;
    },

    async listParticipants(): Promise<ParticipantWindow[]> {
      return (q.allWindows.all() as Row[]).map((w) => ({
        sessionId: w.session_id as string,
        principalId: w.principal_id as string,
        validFrom: num(w.valid_from),
        validTo: nullableNum(w.valid_to),
      }));
    },

    async participantsOf(sessionId) {
      return (q.windowsBySession.all(sessionId) as Row[]).map((w) => w.principal_id as string);
    },

    close() {
      db.close();
    },
  };
  return store;
}

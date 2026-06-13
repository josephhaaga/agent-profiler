import type {
  BlobRecord,
  Insight,
  LlmCallRecord,
  PromptSegmentRecord,
  SessionRecord,
  ToolCallRecord,
  ToolDefRecord,
  TurnRecord,
} from "@agent-profiler/schema";
import { Database } from "bun:sqlite";

export interface StoreOptions {
  filePath?: string;
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    harness: row.harness as SessionRecord["harness"],
    agent: row.agent != null ? String(row.agent) : undefined,
    model: row.model != null ? String(row.model) : undefined,
    project: row.project != null ? String(row.project) : undefined,
    startedAt: String(row.started_at),
    endedAt: row.ended_at != null ? String(row.ended_at) : undefined,
    turnCount: Number(row.turn_count),
    llmCallCount: Number(row.llm_call_count),
    toolCallCount: Number(row.tool_call_count),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    costTotal: Number(row.cost_total),
    endReason: row.end_reason != null ? String(row.end_reason) : undefined,
  };
}

function rowToTurn(row: Record<string, unknown>): TurnRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    idx: Number(row.idx),
    userText: row.user_text != null ? String(row.user_text) : undefined,
    assistantText: row.assistant_text != null ? String(row.assistant_text) : undefined,
    startedAt: String(row.started_at),
    endedAt: row.ended_at != null ? String(row.ended_at) : undefined,
    llmRoundTrips: Number(row.llm_round_trips),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    cost: Number(row.cost),
    status: row.status != null ? String(row.status) : undefined,
    endSignal: row.end_signal != null ? (String(row.end_signal) as TurnRecord["endSignal"]) : undefined,
  };
}

function rowToLlmCall(row: Record<string, unknown>): LlmCallRecord {
  return {
    id: String(row.id),
    turnId: String(row.turn_id),
    sessionId: String(row.session_id),
    model: String(row.model),
    provider: row.provider != null ? String(row.provider) : undefined,
    paramsJson: row.params_json != null ? String(row.params_json) : undefined,
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    cost: Number(row.cost),
    latencyMs: Number(row.latency_ms),
    finishReason: row.finish_reason != null ? String(row.finish_reason) : undefined,
    inputMessagesRef: row.input_messages_ref != null ? String(row.input_messages_ref) : undefined,
    outputRef: row.output_ref != null ? String(row.output_ref) : undefined,
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row.id),
    turnId: String(row.turn_id),
    sessionId: String(row.session_id),
    name: String(row.name),
    kind: String(row.kind) as ToolCallRecord["kind"],
    server: row.server != null ? String(row.server) : undefined,
    skill: row.skill != null ? String(row.skill) : undefined,
    argsRef: row.args_ref != null ? String(row.args_ref) : undefined,
    outputRef: row.output_ref != null ? String(row.output_ref) : undefined,
    latencyMs: Number(row.latency_ms),
    tokensOutEst: Number(row.tokens_out_est),
    status: row.status != null ? String(row.status) : undefined,
  };
}

function rowToPromptSegment(row: Record<string, unknown>): PromptSegmentRecord {
  return {
    llmCallId: String(row.llm_call_id),
    ord: Number(row.ord),
    sourceKind: String(row.source_kind),
    sourceName: String(row.source_name),
    charLen: Number(row.char_len),
    tokenEst: Number(row.token_est),
    sha256: String(row.sha256),
    isStatic: Boolean(row.is_static),
    contributedBy: row.contributed_by != null ? String(row.contributed_by) : undefined,
  };
}

export class Store {
  readonly db: Database;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filePath ?? ":memory:");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        harness text not null,
        agent text,
        model text,
        project text,
        started_at text not null,
        ended_at text,
        turn_count integer not null default 0,
        llm_call_count integer not null default 0,
        tool_call_count integer not null default 0,
        prompt_tokens integer not null default 0,
        completion_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        cost_total real not null default 0,
        end_reason text
      );

      create table if not exists turns (
        id text primary key,
        session_id text not null references sessions(id),
        idx integer not null,
        user_text text,
        assistant_text text,
        started_at text not null,
        ended_at text,
        llm_round_trips integer not null default 0,
        prompt_tokens integer not null default 0,
        completion_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        cost real not null default 0,
        status text,
        end_signal text
      );
      create index if not exists turns_session_idx on turns(session_id);

      create table if not exists llm_calls (
        id text primary key,
        turn_id text not null references turns(id),
        session_id text not null references sessions(id),
        model text not null,
        provider text,
        params_json text,
        prompt_tokens integer not null default 0,
        completion_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        cost real not null default 0,
        latency_ms integer not null default 0,
        finish_reason text,
        input_messages_ref text,
        output_ref text
      );
      create index if not exists llm_calls_turn_idx on llm_calls(turn_id);
      create index if not exists llm_calls_session_idx on llm_calls(session_id);

      create table if not exists tool_calls (
        id text primary key,
        turn_id text not null references turns(id),
        session_id text not null references sessions(id),
        name text not null,
        kind text not null default 'other',
        server text,
        skill text,
        args_ref text,
        output_ref text,
        latency_ms integer not null default 0,
        tokens_out_est integer not null default 0,
        status text
      );
      create index if not exists tool_calls_turn_idx on tool_calls(turn_id);

      create table if not exists prompt_segments (
        llm_call_id text not null references llm_calls(id),
        ord integer not null,
        source_kind text not null,
        source_name text not null,
        char_len integer not null default 0,
        token_est integer not null default 0,
        sha256 text not null,
        is_static integer not null default 0,
        contributed_by text,
        primary key (llm_call_id, ord)
      );

      create table if not exists tool_defs (
        session_id text not null references sessions(id),
        name text not null,
        kind text not null default 'other',
        schema_json text not null,
        schema_tokens_est integer not null default 0,
        sha256 text not null,
        primary key (session_id, name)
      );

      create table if not exists blobs (
        ref text primary key,
        mime text not null,
        bytes text not null
      );

      create table if not exists insights (
        id text primary key,
        scope_type text not null,
        scope_id text not null,
        kind text not null,
        severity text not null,
        title text not null,
        summary text not null,
        evidence_json text not null,
        created_at text not null
      );
      create index if not exists insights_scope_idx on insights(scope_type, scope_id);
    `);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  upsertSession(session: SessionRecord): void {
    this.db.query(`
      insert into sessions (
        id, harness, agent, model, project, started_at, ended_at,
        turn_count, llm_call_count, tool_call_count,
        prompt_tokens, completion_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, cost_total, end_reason
      ) values (
        $id, $harness, $agent, $model, $project, $startedAt, $endedAt,
        $turnCount, $llmCallCount, $toolCallCount,
        $promptTokens, $completionTokens, $reasoningTokens,
        $cacheReadTokens, $cacheWriteTokens, $costTotal, $endReason
      ) on conflict(id) do update set
        harness=excluded.harness,
        agent=excluded.agent,
        model=excluded.model,
        project=excluded.project,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        turn_count=excluded.turn_count,
        llm_call_count=excluded.llm_call_count,
        tool_call_count=excluded.tool_call_count,
        prompt_tokens=excluded.prompt_tokens,
        completion_tokens=excluded.completion_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens,
        cost_total=excluded.cost_total,
        end_reason=excluded.end_reason
    `).run({
      $id: session.id,
      $harness: session.harness,
      $agent: session.agent ?? null,
      $model: session.model ?? null,
      $project: session.project ?? null,
      $startedAt: session.startedAt,
      $endedAt: session.endedAt ?? null,
      $turnCount: session.turnCount,
      $llmCallCount: session.llmCallCount,
      $toolCallCount: session.toolCallCount,
      $promptTokens: session.promptTokens,
      $completionTokens: session.completionTokens,
      $reasoningTokens: session.reasoningTokens,
      $cacheReadTokens: session.cacheReadTokens,
      $cacheWriteTokens: session.cacheWriteTokens,
      $costTotal: session.costTotal,
      $endReason: session.endReason ?? null,
    });
  }

  listSessions(limit = 50): SessionRecord[] {
    const rows = this.db
      .query(`select * from sessions order by started_at desc limit $limit`)
      .all({ $limit: limit }) as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .query(`select * from sessions where id = $id limit 1`)
      .get({ $id: id }) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : undefined;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  upsertTurn(turn: TurnRecord): void {
    this.db.query(`
      insert into turns (
        id, session_id, idx, user_text, assistant_text,
        started_at, ended_at, llm_round_trips,
        prompt_tokens, completion_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, cost, status, end_signal
      ) values (
        $id, $sessionId, $idx, $userText, $assistantText,
        $startedAt, $endedAt, $llmRoundTrips,
        $promptTokens, $completionTokens, $reasoningTokens,
        $cacheReadTokens, $cacheWriteTokens, $cost, $status, $endSignal
      ) on conflict(id) do update set
        session_id=excluded.session_id,
        idx=excluded.idx,
        user_text=excluded.user_text,
        assistant_text=excluded.assistant_text,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        llm_round_trips=excluded.llm_round_trips,
        prompt_tokens=excluded.prompt_tokens,
        completion_tokens=excluded.completion_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens,
        cost=excluded.cost,
        status=excluded.status,
        end_signal=excluded.end_signal
    `).run({
      $id: turn.id,
      $sessionId: turn.sessionId,
      $idx: turn.idx,
      $userText: turn.userText ?? null,
      $assistantText: turn.assistantText ?? null,
      $startedAt: turn.startedAt,
      $endedAt: turn.endedAt ?? null,
      $llmRoundTrips: turn.llmRoundTrips,
      $promptTokens: turn.promptTokens,
      $completionTokens: turn.completionTokens,
      $reasoningTokens: turn.reasoningTokens,
      $cacheReadTokens: turn.cacheReadTokens,
      $cacheWriteTokens: turn.cacheWriteTokens,
      $cost: turn.cost,
      $status: turn.status ?? null,
      $endSignal: turn.endSignal ?? null,
    });
  }

  listTurns(sessionId: string): TurnRecord[] {
    const rows = this.db
      .query(`select * from turns where session_id = $sessionId order by idx asc`)
      .all({ $sessionId: sessionId }) as Array<Record<string, unknown>>;
    return rows.map(rowToTurn);
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.db
      .query(`select * from turns where id = $id limit 1`)
      .get({ $id: id }) as Record<string, unknown> | undefined;
    return row ? rowToTurn(row) : undefined;
  }

  // ── LLM Calls ─────────────────────────────────────────────────────────────

  upsertLlmCall(call: LlmCallRecord): void {
    this.db.query(`
      insert into llm_calls (
        id, turn_id, session_id, model, provider, params_json,
        prompt_tokens, completion_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, cost,
        latency_ms, finish_reason, input_messages_ref, output_ref
      ) values (
        $id, $turnId, $sessionId, $model, $provider, $paramsJson,
        $promptTokens, $completionTokens, $reasoningTokens,
        $cacheReadTokens, $cacheWriteTokens, $cost,
        $latencyMs, $finishReason, $inputMessagesRef, $outputRef
      ) on conflict(id) do update set
        turn_id=excluded.turn_id,
        session_id=excluded.session_id,
        model=excluded.model,
        provider=excluded.provider,
        params_json=excluded.params_json,
        prompt_tokens=excluded.prompt_tokens,
        completion_tokens=excluded.completion_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens,
        cost=excluded.cost,
        latency_ms=excluded.latency_ms,
        finish_reason=excluded.finish_reason,
        input_messages_ref=excluded.input_messages_ref,
        output_ref=excluded.output_ref
    `).run({
      $id: call.id,
      $turnId: call.turnId,
      $sessionId: call.sessionId,
      $model: call.model,
      $provider: call.provider ?? null,
      $paramsJson: call.paramsJson ?? null,
      $promptTokens: call.promptTokens,
      $completionTokens: call.completionTokens,
      $reasoningTokens: call.reasoningTokens,
      $cacheReadTokens: call.cacheReadTokens,
      $cacheWriteTokens: call.cacheWriteTokens,
      $cost: call.cost,
      $latencyMs: call.latencyMs,
      $finishReason: call.finishReason ?? null,
      $inputMessagesRef: call.inputMessagesRef ?? null,
      $outputRef: call.outputRef ?? null,
    });
  }

  listLlmCalls(turnId: string): LlmCallRecord[] {
    const rows = this.db
      .query(`select * from llm_calls where turn_id = $turnId order by rowid asc`)
      .all({ $turnId: turnId }) as Array<Record<string, unknown>>;
    return rows.map(rowToLlmCall);
  }

  listLlmCallsBySession(sessionId: string): LlmCallRecord[] {
    const rows = this.db
      .query(`select * from llm_calls where session_id = $sessionId order by rowid asc`)
      .all({ $sessionId: sessionId }) as Array<Record<string, unknown>>;
    return rows.map(rowToLlmCall);
  }

  // ── Tool Calls ────────────────────────────────────────────────────────────

  upsertToolCall(tc: ToolCallRecord): void {
    this.db.query(`
      insert into tool_calls (
        id, turn_id, session_id, name, kind, server, skill,
        args_ref, output_ref, latency_ms, tokens_out_est, status
      ) values (
        $id, $turnId, $sessionId, $name, $kind, $server, $skill,
        $argsRef, $outputRef, $latencyMs, $tokensOutEst, $status
      ) on conflict(id) do update set
        turn_id=excluded.turn_id,
        session_id=excluded.session_id,
        name=excluded.name,
        kind=excluded.kind,
        server=excluded.server,
        skill=excluded.skill,
        args_ref=excluded.args_ref,
        output_ref=excluded.output_ref,
        latency_ms=excluded.latency_ms,
        tokens_out_est=excluded.tokens_out_est,
        status=excluded.status
    `).run({
      $id: tc.id,
      $turnId: tc.turnId,
      $sessionId: tc.sessionId,
      $name: tc.name,
      $kind: tc.kind,
      $server: tc.server ?? null,
      $skill: tc.skill ?? null,
      $argsRef: tc.argsRef ?? null,
      $outputRef: tc.outputRef ?? null,
      $latencyMs: tc.latencyMs,
      $tokensOutEst: tc.tokensOutEst,
      $status: tc.status ?? null,
    });
  }

  listToolCalls(turnId: string): ToolCallRecord[] {
    const rows = this.db
      .query(`select * from tool_calls where turn_id = $turnId order by rowid asc`)
      .all({ $turnId: turnId }) as Array<Record<string, unknown>>;
    return rows.map(rowToToolCall);
  }

  listToolCallsBySession(sessionId: string): ToolCallRecord[] {
    const rows = this.db
      .query(`select * from tool_calls where session_id = $sessionId order by rowid asc`)
      .all({ $sessionId: sessionId }) as Array<Record<string, unknown>>;
    return rows.map(rowToToolCall);
  }

  // ── Prompt Segments ───────────────────────────────────────────────────────

  upsertPromptSegments(segments: PromptSegmentRecord[]): void {
    for (const seg of segments) {
      this.db.query(`
        insert into prompt_segments (
          llm_call_id, ord, source_kind, source_name,
          char_len, token_est, sha256, is_static, contributed_by
        ) values (
          $llmCallId, $ord, $sourceKind, $sourceName,
          $charLen, $tokenEst, $sha256, $isStatic, $contributedBy
        ) on conflict(llm_call_id, ord) do update set
          source_kind=excluded.source_kind,
          source_name=excluded.source_name,
          char_len=excluded.char_len,
          token_est=excluded.token_est,
          sha256=excluded.sha256,
          is_static=excluded.is_static,
          contributed_by=excluded.contributed_by
      `).run({
        $llmCallId: seg.llmCallId,
        $ord: seg.ord,
        $sourceKind: seg.sourceKind,
        $sourceName: seg.sourceName,
        $charLen: seg.charLen,
        $tokenEst: seg.tokenEst,
        $sha256: seg.sha256,
        $isStatic: seg.isStatic ? 1 : 0,
        $contributedBy: seg.contributedBy ?? null,
      });
    }
  }

  listPromptSegments(llmCallId: string): PromptSegmentRecord[] {
    const rows = this.db
      .query(`select * from prompt_segments where llm_call_id = $llmCallId order by ord asc`)
      .all({ $llmCallId: llmCallId }) as Array<Record<string, unknown>>;
    return rows.map(rowToPromptSegment);
  }

  // ── Tool Defs ─────────────────────────────────────────────────────────────

  upsertToolDef(def: ToolDefRecord): void {
    this.db.query(`
      insert into tool_defs (session_id, name, kind, schema_json, schema_tokens_est, sha256)
      values ($sessionId, $name, $kind, $schemaJson, $schemaTokensEst, $sha256)
      on conflict(session_id, name) do update set
        kind=excluded.kind,
        schema_json=excluded.schema_json,
        schema_tokens_est=excluded.schema_tokens_est,
        sha256=excluded.sha256
    `).run({
      $sessionId: def.sessionId,
      $name: def.name,
      $kind: def.kind,
      $schemaJson: def.schemaJson,
      $schemaTokensEst: def.schemaTokensEst,
      $sha256: def.sha256,
    });
  }

  listToolDefs(sessionId: string): ToolDefRecord[] {
    const rows = this.db
      .query(`select * from tool_defs where session_id = $sessionId order by name asc`)
      .all({ $sessionId: sessionId }) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      name: String(row.name),
      kind: String(row.kind) as ToolDefRecord["kind"],
      schemaJson: String(row.schema_json),
      schemaTokensEst: Number(row.schema_tokens_est),
      sha256: String(row.sha256),
    }));
  }

  // ── Blobs ─────────────────────────────────────────────────────────────────

  putBlob(ref: string, mime: string, bytes: string): void {
    this.db.query(`
      insert into blobs (ref, mime, bytes) values ($ref, $mime, $bytes)
      on conflict(ref) do update set mime=excluded.mime, bytes=excluded.bytes
    `).run({ $ref: ref, $mime: mime, $bytes: bytes });
  }

  getBlob(ref: string): BlobRecord | undefined {
    const row = this.db
      .query(`select * from blobs where ref = $ref limit 1`)
      .get({ $ref: ref }) as Record<string, unknown> | undefined;
    return row
      ? { ref: String(row.ref), mime: String(row.mime), bytes: String(row.bytes) }
      : undefined;
  }

  // ── Insights ──────────────────────────────────────────────────────────────

  upsertInsight(insight: Insight): void {
    this.db.query(`
      insert into insights (
        id, scope_type, scope_id, kind, severity, title, summary, evidence_json, created_at
      ) values (
        $id, $scopeType, $scopeId, $kind, $severity, $title, $summary, $evidenceJson, $createdAt
      ) on conflict(id) do update set
        scope_type=excluded.scope_type,
        scope_id=excluded.scope_id,
        kind=excluded.kind,
        severity=excluded.severity,
        title=excluded.title,
        summary=excluded.summary,
        evidence_json=excluded.evidence_json,
        created_at=excluded.created_at
    `).run({
      $id: insight.id,
      $scopeType: insight.scopeType,
      $scopeId: insight.scopeId,
      $kind: insight.kind,
      $severity: insight.severity,
      $title: insight.title,
      $summary: insight.summary,
      $evidenceJson: JSON.stringify(insight.evidence),
      $createdAt: insight.createdAt,
    });
  }

  listInsights(scopeType?: string, scopeId?: string): Insight[] {
    let sql = "select * from insights";
    const params: Record<string, unknown> = {};
    const clauses: string[] = [];
    if (scopeType) {
      clauses.push("scope_type = $scopeType");
      params.$scopeType = scopeType;
    }
    if (scopeId) {
      clauses.push("scope_id = $scopeId");
      params.$scopeId = scopeId;
    }
    if (clauses.length) sql += ` where ${clauses.join(" and ")}`;
    sql += " order by created_at desc";
    // bun:sqlite .all() accepts SQLQueryBindings; cast through any for dynamic params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows2 = (this.db.query(sql) as any).all(params) as Array<Record<string, unknown>>;
    return rows2.map((row) => ({
      id: String(row.id),
      scopeType: row.scope_type as Insight["scopeType"],
      scopeId: String(row.scope_id),
      kind: String(row.kind),
      severity: row.severity as Insight["severity"],
      title: String(row.title),
      summary: String(row.summary),
      evidence: JSON.parse(String(row.evidence_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }

  // ── Analytics helpers ─────────────────────────────────────────────────────

  /** Tool attribution: total latency and tokens per tool name across a session. */
  getToolAttribution(sessionId: string): Array<{
    name: string; kind: string; call_count: number;
    total_latency_ms: number; total_tokens_out: number;
  }> {
    return this.db.query(`
      select name, kind,
             count(*) as call_count,
             sum(latency_ms) as total_latency_ms,
             sum(tokens_out_est) as total_tokens_out
      from tool_calls
      where session_id = $sessionId
      group by name, kind
      order by total_latency_ms desc
    `).all({ $sessionId: sessionId }) as Array<{
      name: string; kind: string; call_count: number;
      total_latency_ms: number; total_tokens_out: number;
    }>;
  }

  /** Prefix hash stream for cache analysis across consecutive LLM calls in a session. */
  getPrefixHashStream(sessionId: string): Array<{
    llmCallId: string; sha256: string; tokenEst: number;
  }> {
    return (this.db.query(`
      select ps.llm_call_id, ps.sha256, ps.token_est
      from prompt_segments ps
      join llm_calls lc on lc.id = ps.llm_call_id
      where lc.session_id = $sessionId and ps.is_static = 1
      order by lc.rowid asc, ps.ord asc
    `).all({ $sessionId: sessionId }) as Array<Record<string, unknown>>).map((r) => ({
      llmCallId: String(r.llm_call_id),
      sha256: String(r.sha256),
      tokenEst: Number(r.token_est),
    }));
  }
}

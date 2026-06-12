import type { Insight, SessionRecord } from "@agent-profiler/schema";
import { Database } from "bun:sqlite";

export interface StoreOptions {
  filePath?: string;
}

export class Store {
  private readonly db: Database;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filePath ?? ":memory:");
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
    `);
  }

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
    return this.db.query(`select * from sessions order by started_at desc limit $limit`).all({ $limit: limit }) as SessionRecord[];
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.query(`select * from sessions where id = $id limit 1`).get({ $id: id }) as SessionRecord | undefined;
  }

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
    if (scopeType || scopeId) {
      const clauses: string[] = [];
      if (scopeType) clauses.push(`scope_type = ${JSON.stringify(scopeType)}`);
      if (scopeId) clauses.push(`scope_id = ${JSON.stringify(scopeId)}`);
      sql += ` where ${clauses.join(" and ")}`;
    }
    sql += " order by created_at desc";
    const rows = this.db.query(sql).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
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
}

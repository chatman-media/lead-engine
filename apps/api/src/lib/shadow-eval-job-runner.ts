import { withTenant } from "@chatman-media/conversation-engine";
import { CANDIDATE_BY_SLUG, runShadowEval } from "@chatman-media/sales";
import { shadowEvaluations, styles, tenants } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import {
  type AdminQualityRoutesOpts,
  buildQualityRunnerDeps,
  isPresentPersona,
  makeShadowEvaluationRepo,
  parseStyleFromShadowPlanRow,
  type ShadowEvaluationRunConfig,
} from "../routes/admin-quality.ts";

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_LEASE_SECONDS = 15 * 60;
const DEFAULT_STALE_RUNNING_SECONDS = 30 * 60;

type RunnerLog = {
  warn?: (message: string, ctx?: Record<string, unknown>) => void;
};

type ShadowEvalJobRunnerOpts = Omit<AdminQualityRoutesOpts, "shadowEvalRunner"> & {
  pollMs?: number;
  batchSize?: number;
  leaseSeconds?: number;
  staleRunningSeconds?: number;
  workerId?: string;
  log?: RunnerLog;
};

type ClaimedShadowEvaluation = {
  id: number;
  tenantId: number;
  parentStyleId: number;
  parentStyleSlug: string;
  newStyleId: number;
  newStyleSlug: string;
  pairsDone: number;
  aWins: number;
  bWins: number;
  draws: number;
  runConfigJson: string;
  claimToken: string;
};

type StyleRow = {
  id: number;
  slug: string;
  displayName: string;
  configJson: string;
};

export class ShadowEvalJobRunner {
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly staleRunningSeconds: number;
  private readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlight = false;

  constructor(private readonly opts: ShadowEvalJobRunnerOpts) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.staleRunningSeconds = opts.staleRunningSeconds ?? DEFAULT_STALE_RUNNING_SECONDS;
    this.workerId = opts.workerId ?? `api-${Math.random().toString(36).slice(2, 10)}`;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.pollMs);
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.stopped) return;
    void this.runOnce().catch((err) =>
      this.warn("shadow-eval queue tick failed", { err: toErrorMessage(err) }),
    );
  }

  async runOnce(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      let processed = 0;
      const now = nowEpoch();
      const tenantRows = await this.opts.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.status, "active"));

      for (const { id: tenantId } of tenantRows) {
        await this.failUnrecoverableRunning(tenantId, now);
        while (processed < this.batchSize) {
          const claimed = await this.claimNext(tenantId, now);
          if (!claimed) break;
          await this.runClaimed(claimed);
          processed++;
        }
        if (processed >= this.batchSize) break;
      }

      return processed;
    } finally {
      this.inFlight = false;
    }
  }

  private async claimNext(tenantId: number, now: number): Promise<ClaimedShadowEvaluation | null> {
    const claimToken = `${this.workerId}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAt = now + this.leaseSeconds;
    const rows = await withTenant(this.opts.db, tenantId, async (tx) => {
      return (await tx.execute(sql`
        UPDATE ${shadowEvaluations}
        SET
          claim_token = ${claimToken},
          claimed_at = ${now},
          lease_expires_at = ${leaseExpiresAt},
          attempts = attempts + 1,
          error_message = NULL
        WHERE id IN (
          SELECT id
          FROM ${shadowEvaluations}
          WHERE tenant_id = ${tenantId}
            AND status = 'running'
            AND run_config_json IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
          ORDER BY started_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `)) as unknown as Array<Record<string, unknown>>;
    });
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as number,
      tenantId: row.tenant_id as number,
      parentStyleId: row.parent_style_id as number,
      parentStyleSlug: row.parent_style_slug as string,
      newStyleId: row.new_style_id as number,
      newStyleSlug: row.new_style_slug as string,
      pairsDone: row.pairs_done as number,
      aWins: row.a_wins as number,
      bWins: row.b_wins as number,
      draws: row.draws as number,
      runConfigJson: row.run_config_json as string,
      claimToken: row.claim_token as string,
    };
  }

  private async runClaimed(row: ClaimedShadowEvaluation): Promise<void> {
    const repo = makeShadowEvaluationRepo(this.opts.db, row.tenantId, {
      claimToken: row.claimToken,
      leaseSeconds: this.leaseSeconds,
    });
    const configResult = parseRunConfig(row.runConfigJson);
    if (configResult.kind === "invalid") {
      await repo.update(row.id, { status: "failed", error: configResult.error });
      return;
    }

    const [parentStyleRow, candidateStyleRow] = await Promise.all([
      this.loadStyle(row.tenantId, row.parentStyleId, row.parentStyleSlug),
      this.loadStyle(row.tenantId, row.newStyleId, row.newStyleSlug),
    ]);
    if (!parentStyleRow) {
      await repo.update(row.id, { status: "failed", error: "parent style not found" });
      return;
    }
    if (!candidateStyleRow) {
      await repo.update(row.id, { status: "failed", error: "candidate style not found" });
      return;
    }

    const parentStyle = parseStyleFromShadowPlanRow(parentStyleRow);
    if (parentStyle.kind === "invalid") {
      await repo.update(row.id, {
        status: "failed",
        error: "parent style failed schema validation",
      });
      return;
    }
    const candidateStyle = parseStyleFromShadowPlanRow(candidateStyleRow);
    if (candidateStyle.kind === "invalid") {
      await repo.update(row.id, {
        status: "failed",
        error: "candidate style failed schema validation",
      });
      return;
    }

    const personas = configResult.config.personas.map((slug) => CANDIDATE_BY_SLUG.get(slug));
    if (personas.some((persona) => !persona)) {
      await repo.update(row.id, { status: "failed", error: "persona not found" });
      return;
    }

    const depsResult = await buildQualityRunnerDeps(
      this.opts,
      row.tenantId,
      configResult.config.reflect,
    );
    if (depsResult.kind === "unavailable") {
      await repo.update(row.id, { status: "failed", error: depsResult.error });
      return;
    }

    await runShadowEval(
      {
        ...depsResult.deps,
        shadowRepo: repo,
      },
      {
        evalId: row.id,
        parentStyle: parentStyle.style,
        parentStyleId: row.parentStyleId,
        newStyle: candidateStyle.style,
        newStyleId: row.newStyleId,
        personas: personas.filter(isPresentPersona),
        runs: configResult.config.runs,
        maxTurns: configResult.config.maxTurns,
        resume: {
          pairsDone: row.pairsDone,
          aWins: row.aWins,
          bWins: row.bWins,
          draws: row.draws,
        },
      },
    );
  }

  private async loadStyle(
    tenantId: number,
    styleId: number,
    styleSlug: string,
  ): Promise<StyleRow | null> {
    return withTenant(this.opts.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          id: styles.id,
          slug: styles.slug,
          displayName: styles.displayName,
          configJson: styles.configJson,
        })
        .from(styles)
        .where(
          and(
            eq(styles.tenantId, tenantId),
            eq(styles.id, styleId),
            eq(styles.slug, styleSlug),
            sql`${styles.deletedAt} IS NULL`,
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  private async failUnrecoverableRunning(tenantId: number, now: number): Promise<void> {
    const cutoff = now - this.staleRunningSeconds;
    const rows = await withTenant(this.opts.db, tenantId, async (tx) => {
      return (await tx.execute(sql`
        UPDATE ${shadowEvaluations}
        SET
          status = 'failed',
          error_message = 'shadow evaluation missing durable run config; start a new run',
          claim_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          completed_at = ${now}
        WHERE tenant_id = ${tenantId}
          AND status = 'running'
          AND run_config_json IS NULL
          AND started_at < ${cutoff}
        RETURNING id
      `)) as unknown as Array<{ id: number }>;
    });
    if (rows.length > 0) {
      this.warn("marked unrecoverable shadow evaluations failed", {
        tenantId,
        count: rows.length,
      });
    }
  }

  private warn(message: string, ctx?: Record<string, unknown>): void {
    if (this.opts.log?.warn) this.opts.log.warn(message, ctx);
    else console.warn(`[shadow-eval-queue] ${message}`, ctx ?? {});
  }
}

function parseRunConfig(
  raw: string,
): { kind: "ok"; config: ShadowEvaluationRunConfig } | { kind: "invalid"; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "invalid shadow evaluation run config json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", error: "invalid shadow evaluation run config" };
  }
  const config = parsed as Partial<ShadowEvaluationRunConfig>;
  if (config.version !== 1)
    return { kind: "invalid", error: "unsupported shadow evaluation run config version" };
  const runs = config.runs;
  if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 1 || runs > 20) {
    return { kind: "invalid", error: "invalid shadow evaluation runs" };
  }
  const maxTurns = config.maxTurns;
  if (
    typeof maxTurns !== "number" ||
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 20
  ) {
    return { kind: "invalid", error: "invalid shadow evaluation maxTurns" };
  }
  if (typeof config.reflect !== "boolean") {
    return { kind: "invalid", error: "invalid shadow evaluation reflect flag" };
  }
  if (
    !Array.isArray(config.personas) ||
    config.personas.length === 0 ||
    config.personas.some((slug) => typeof slug !== "string" || slug.trim().length === 0)
  ) {
    return { kind: "invalid", error: "invalid shadow evaluation personas" };
  }
  return {
    kind: "ok",
    config: {
      version: 1,
      runs,
      maxTurns,
      reflect: config.reflect,
      personas: [...new Set(config.personas.map((slug) => slug.trim()))],
    },
  };
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

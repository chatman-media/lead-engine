import { KbRepo } from "../../db/repos/kb.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { sanitizeLlmOutput } from "../../rag/answer.ts";
import type { ChatMessage } from "../../rag/chat.ts";
import { json, type RouteHandler } from "../../router.ts";
import { composeSystemPrompt } from "../../sales/prompt.ts";
import { nextStage } from "../../sales/stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage, StyleSchema } from "../../sales/types.ts";
import { parseIdParam, parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

export function createListStylesHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async () => {
    const rows = (await styles.listActive()).map((row) => ({
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      version: row.version,
      parent_id: row.parent_id,
      is_active: row.is_active,
      created_at: row.created_at,
    }));
    return json({ styles: rows });
  });
}

export function createGetStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const row = await styles.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });
    let parsedConfig: unknown = null;
    let parseError: string | null = null;
    try {
      parsedConfig = styles.parseRow(row);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    return json({
      style: {
        id: row.id,
        slug: row.slug,
        display_name: row.display_name,
        version: row.version,
        parent_id: row.parent_id,
        is_active: row.is_active,
        created_at: row.created_at,
        config: parsedConfig,
        config_raw: row.config_json,
        parse_error: parseError,
      },
    });
  });
}

interface PlaygroundBody {
  userMessage?: unknown;
  /** Optional override; if absent, stage is auto-detected from the message. */
  stage?: unknown;
  /**
   * Whether to do a KB pre-search and inject hits into the prompt.
   * Default true — mirrors webhook behavior. Set false to see what the
   * model produces without grounding (useful for stylistic-only checks).
   */
  useKb?: unknown;
  /** Whether to drop the few-shot block (mirrors turn-2+ behavior). */
  dropFewShot?: unknown;
}

const FUNNEL_STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);

/**
 * POST /admin/api/styles/:id/playground — dry-run a style against a user
 * message, no DB writes, no Telegram traffic. Returns:
 *   - the resolved stage (auto-detected unless overridden)
 *   - the KB hits that would have been injected (or empty array)
 *   - the full composed system prompt (so operator can sanity-check)
 *   - the model's reply
 *   - duration_ms (so operator can budget against their hardware)
 *
 * This is the "save and pray" antidote: edit a style, click Run with a
 * sample prospect message, see what comes back BEFORE versioning the row.
 */
export function createStylePlaygroundHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.sql);
  const kb = new KbRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    if (!deps.rag) {
      return json(
        {
          error:
            "playground requires LLM to be configured (LLM_PROVIDER + a chat/embed client). Server started without it.",
        },
        { status: 503 },
      );
    }
    // Capture under a local so TS narrowing carries through the async
    // closures below — without this, every `deps.rag.foo` access has
    // to either non-null-assert or re-narrow.
    const rag = deps.rag;

    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const row = await styles.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    let style: ReturnType<typeof styles.parseRow>;
    try {
      style = styles.parseRow(row);
    } catch (err) {
      return json(
        {
          error: `style config_json fails StyleSchema: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 422 },
      );
    }

    const body = await parseJsonBody<PlaygroundBody>(req);
    if (body instanceof Response) return body;
    const userMessage = typeof body.userMessage === "string" ? body.userMessage.trim() : "";
    if (!userMessage) {
      return json({ error: "userMessage is required" }, { status: 400 });
    }

    const stageOverride =
      typeof body.stage === "string" && FUNNEL_STAGE_SET.has(body.stage)
        ? (body.stage as FunnelStage)
        : null;
    const stage: FunnelStage =
      stageOverride ??
      nextStage({
        // Treat playground as a fresh conversation: turn 1, no prior stage.
        // Operator can pin stage via `body.stage` if testing later-funnel turns.
        turnNumber: 1,
        currentStage: null,
        lastUserMessage: userMessage,
      });

    const useKb = body.useKb !== false; // default true
    const dropFewShot = body.dropFewShot === true; // default false

    // Replicate the webhook's RAG pipeline inline (intentionally NOT calling
    // answerWithRag) so we can:
    //   - return the composed system prompt for the operator to inspect;
    //   - skip the NO_CONTEXT_MARKER escalation behavior — playground runs
    //     the LLM unconditionally so the operator can see what the model
    //     produces even without KB grounding.
    const startedAt = Date.now();

    let kbHits: Array<{
      chunk_id: number;
      title: string;
      text: string;
      distance: number;
    }> = [];
    let kbContext: string | null = null;

    if (useKb) {
      try {
        const [vec] = await rag.embedder.embed([userMessage]);
        if (vec) {
          const topK = rag.topK ?? 5;
          const all = await kb.search(vec, topK);
          const filtered =
            rag.maxDistance === undefined ? all : all.filter((h) => h.distance <= rag.maxDistance!);
          kbHits = filtered.map((h) => ({
            chunk_id: h.chunk_id,
            title: h.title,
            text: h.text,
            distance: h.distance,
          }));
          if (filtered.length > 0) {
            kbContext = filtered
              .map((h, i) => `[#${i + 1}] (source: ${h.title})\n${h.text}`)
              .join("\n\n");
          }
        }
      } catch (err) {
        return json(
          {
            error: `embedder/KB lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 502 },
        );
      }
    }

    const systemPrompt = composeSystemPrompt(style, stage, kbContext, {
      includeFewShot: !dropFewShot,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let reply: string;
    try {
      const raw = await rag.chat.complete(messages, {
        temperature: style.model.temperature,
      });
      reply = sanitizeLlmOutput(raw);
    } catch (err) {
      return json(
        {
          error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 502 },
      );
    }

    const durationMs = Date.now() - startedAt;

    return json({
      stage,
      stage_source: stageOverride ? "override" : "auto",
      kb_hits: kbHits,
      system_prompt: systemPrompt,
      reply,
      duration_ms: durationMs,
      model: { id: style.model.id, temperature: style.model.temperature },
    });
  });
}

/**
 * POST /admin/api/styles — create a fresh sales style from scratch.
 *
 * Used by the "Clone from existing" UI flow: operator picks a template style,
 * tweaks the JSON (slug, displayName, persona name, voice, hooks, …), saves.
 * Resulting row is version=1, parent_id=null, is_active=1 — its own root of a
 * new version chain.
 *
 * Slug uniqueness: enforced against ACTIVE rows only. A historical
 * (deactivated) row with the same slug is fine — that means the slug was
 * once used and edited many times; the chain is terminated and now the slug
 * can be reused. This is not great practice but the CHECK lets operators
 * recover from accidental deactivation without DB surgery.
 */
export function createCreateStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req }) => {
    const body = await parseJsonBody<{ config?: unknown }>(req);
    if (body instanceof Response) return body;
    if (typeof body.config !== "object" || body.config === null) {
      return json({ error: "body.config must be a Style object" }, { status: 400 });
    }

    const parsed = StyleSchema.safeParse(body.config);
    if (!parsed.success) {
      return json(
        {
          error: "config fails StyleSchema validation",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 },
      );
    }
    const config = parsed.data;

    // Refuse if there's already an ACTIVE style with this slug. Deactivated
    // rows with the same slug are tolerated (see comment block above).
    if (await styles.bySlug(config.slug)) {
      return json(
        {
          error: `style with slug "${config.slug}" already exists. Edit the existing one or pick a different slug.`,
        },
        { status: 409 },
      );
    }

    const inserted = await styles.insert({
      slug: config.slug,
      displayName: config.displayName,
      config,
      version: 1,
      parentId: null,
    });

    return json(
      {
        style: {
          id: inserted.id,
          slug: inserted.slug,
          display_name: inserted.display_name,
          version: inserted.version,
          parent_id: inserted.parent_id,
          is_active: inserted.is_active,
          created_at: inserted.created_at,
          config,
          config_raw: inserted.config_json,
          parse_error: null,
        },
      },
      { status: 201 },
    );
  });
}

/**
 * PATCH /admin/api/styles/:id — save edit as a NEW version.
 *
 * The current row is deactivated (is_active=0); a new row is inserted with
 * version+1, parent_id pointing at the deactivated row. Conversations already
 * pinned to the old version keep seeing the prompt they started with.
 */
export function createEditStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const body = await parseJsonBody<{ config?: unknown }>(req);
    if (body instanceof Response) return body;
    if (typeof body.config !== "object" || body.config === null) {
      return json({ error: "body.config must be a Style object" }, { status: 400 });
    }

    const parseResult = StyleSchema.safeParse(body.config);
    if (!parseResult.success) {
      return json(
        {
          error: "config fails StyleSchema validation",
          issues: parseResult.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 },
      );
    }

    let newRow: Awaited<ReturnType<typeof styles.editAsNewVersion>>;
    try {
      newRow = await styles.editAsNewVersion(id, parseResult.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return json({ error: msg }, { status: 404 });
      }
      if (msg.includes("not active") || msg.includes("slug mismatch")) {
        return json({ error: msg }, { status: 409 });
      }
      throw err;
    }

    return json({
      style: {
        id: newRow.id,
        slug: newRow.slug,
        display_name: newRow.display_name,
        version: newRow.version,
        parent_id: newRow.parent_id,
        is_active: newRow.is_active,
        created_at: newRow.created_at,
        config: parseResult.data,
        config_raw: newRow.config_json,
        parse_error: null,
      },
    });
  });
}

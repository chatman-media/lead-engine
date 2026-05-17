export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export interface Chunk {
  index: number;
  text: string;
  /** Rough token estimate: ~4 chars per token. */
  tokenCount: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChars: 1500,
  overlapChars: 150,
};

/** Approximate token count for English/mixed text: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Splits `text` into overlapping chunks bounded by `maxChars`. Tries to break
 * on paragraph boundaries (\n\n) first, then on whitespace, before slicing
 * mid-word. Empty/whitespace-only input yields an empty array.
 */
export function chunkText(text: string, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const { maxChars, overlapChars } = { ...DEFAULT_OPTIONS, ...opts };
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be in [0, maxChars)");
  }
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const segments: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      if (buf) {
        segments.push(buf);
        buf = "";
      }
      for (const part of splitLong(p, maxChars, overlapChars)) {
        segments.push(part);
      }
      continue;
    }
    if (!buf) {
      buf = p;
    } else if (buf.length + 2 + p.length <= maxChars) {
      buf = `${buf}\n\n${p}`;
    } else {
      segments.push(buf);
      buf = p;
    }
  }
  if (buf) segments.push(buf);

  if (overlapChars > 0 && segments.length > 1) {
    for (let i = 1; i < segments.length; i++) {
      const prevTail = (segments[i - 1] ?? "").slice(-overlapChars);
      let current = `${prevTail}${segments[i] ?? ""}`;
      if (current.length > maxChars) {
        current = current.slice(0, maxChars);
      }
      segments[i] = current;
    }
  }

  return segments.map((text, index) => ({
    index,
    text,
    tokenCount: estimateTokens(text),
  }));
}

export interface SectionChunk extends Chunk {
  /** Heading that introduces this section, or null for the document preamble. */
  heading: string | null;
  /** Heading level (1–6) derived from the number of `#` characters, or null. */
  headingLevel: number | null;
}

/**
 * Semantic chunker that splits Markdown/plain-text documents by headings
 * (`#`, `##`, …) and paragraph breaks, keeping each heading with its content.
 *
 * Compared to `chunkText()`:
 * - Never breaks a heading away from its first paragraph
 * - Each chunk carries the heading context, so retrieval results are
 *   self-contained even without surrounding text
 * - Falls back to `chunkText()` for sections that exceed `maxChars`
 *
 * Use this for structured knowledge-base documents (FAQs, wikis, product
 * pages). Use `chunkText()` for unstructured long-form prose.
 *
 * @example
 * ```ts
 * import { chunkBySections } from "@chatman-media/rag";
 *
 * const chunks = chunkBySections(markdownString, { maxChars: 1200 });
 * // chunks[0].heading → "Installation"
 * // chunks[0].text    → "## Installation\n\nRun `bun add …`"
 * ```
 */
export function chunkBySections(text: string, opts: Partial<ChunkOptions> = {}): SectionChunk[] {
  const { maxChars, overlapChars } = { ...DEFAULT_OPTIONS, ...opts };
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Split on Markdown headings — keep the heading line with its section body.
  const lines = trimmed.split("\n");

  interface RawSection {
    heading: string | null;
    headingLevel: number | null;
    body: string;
  }

  const sections: RawSection[] = [];
  let currentHeading: string | null = null;
  let currentLevel: number | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join("\n").trim();
    if (body || currentHeading) {
      sections.push({ heading: currentHeading, headingLevel: currentLevel, body });
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      flush();
      currentHeading = m[2] ?? null;
      currentLevel = (m[1] ?? "").length;
      bodyLines = [];
    } else {
      bodyLines.push(line);
    }
  }
  flush();

  const result: SectionChunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    // Build full section text: prepend heading if present
    const headingPrefix =
      section.heading && section.headingLevel
        ? `${"#".repeat(section.headingLevel)} ${section.heading}\n\n`
        : "";
    const full = `${headingPrefix}${section.body}`.trim();
    if (!full) continue;

    if (full.length <= maxChars) {
      result.push({
        index: globalIndex++,
        text: full,
        tokenCount: estimateTokens(full),
        heading: section.heading,
        headingLevel: section.headingLevel,
      });
    } else {
      // Section is too large — fall back to chunkText, preserve heading context
      const subChunks = chunkText(full, { maxChars, overlapChars });
      for (const sub of subChunks) {
        result.push({
          ...sub,
          index: globalIndex++,
          heading: section.heading,
          headingLevel: section.headingLevel,
        });
      }
    }
  }

  return result;
}

function splitLong(text: string, maxChars: number, overlapChars: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, maxChars - overlapChars);
  for (let i = 0; i < text.length; i += step) {
    const slice = text.slice(i, i + maxChars);
    out.push(slice);
    if (i + maxChars >= text.length) break;
  }
  return out;
}

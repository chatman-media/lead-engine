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
      const prevTail = segments[i - 1]!.slice(-overlapChars);
      segments[i] = `${prevTail}${segments[i]}`;
      if (segments[i]!.length > maxChars) {
        segments[i] = segments[i]!.slice(0, maxChars);
      }
    }
  }

  return segments.map((text, index) => ({
    index,
    text,
    tokenCount: estimateTokens(text),
  }));
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

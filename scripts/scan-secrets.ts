#!/usr/bin/env bun
/**
 * Lightweight secret scanner — runs in CI before commit / push to catch
 * accidentally-leaked tokens, API keys, passwords. Not a replacement for
 * gitleaks/trufflehog at the repo level, but good enough for the local
 * fast-feedback loop. Reports to stderr + exits non-zero on any hit.
 *
 * Patterns are deliberately conservative. False-negative is preferable to
 * a noisy CI that operators learn to ignore. Add new patterns as we see
 * real leakage classes.
 *
 * Run:
 *   bun run scripts/scan-secrets.ts
 *   bun run scripts/scan-secrets.ts --staged   (only staged files via git)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Pattern {
  name: string;
  re: RegExp;
  /** Substring whitelist — when the FULL match contains any of these,
   *  the hit is suppressed. Prevents flagging the env.example file's
   *  obviously-fake placeholders. */
  ignoreSubstrings?: string[];
}

const PATTERNS: Pattern[] = [
  // Telegram bot tokens: 9-10 digits + ":" + 35 chars from base64-ish set.
  // Real token shape; matches the prod token in tests would catch it.
  {
    name: "telegram-bot-token",
    re: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/g,
    ignoreSubstrings: ["123456789:ABC", "EXAMPLE", "your_token"],
  },
  // Generic OpenAI-style keys: sk-… 32+ chars
  {
    name: "openai-api-key",
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
    ignoreSubstrings: ["sk-XXXX", "sk-example", "sk-test"],
  },
  // Anthropic-style keys: sk-ant-…
  {
    name: "anthropic-api-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  // AWS access keys
  {
    name: "aws-access-key-id",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: "aws-secret-access-key",
    re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  },
  // Google API key
  {
    name: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // GitHub PAT / fine-grained PAT
  {
    name: "github-token",
    re: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{36,}\b/g,
  },
  // Slack tokens
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // Stripe live key
  {
    name: "stripe-live-key",
    re: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
  },
  // Generic high-entropy hex secret assigned to an env-y name. Length 32+
  // hex catches webhook secrets / app secrets.
  {
    name: "env-style-hex-secret",
    re: /\b(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)\w*\s*[:=]\s*["']?([a-f0-9]{32,})["']?/gi,
    ignoreSubstrings: ["process.env.", "envOptional", "envRequired", "env.example"],
  },
  // PEM private key headers
  {
    name: "pem-private-key",
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
  },
];

// Files / directories we don't scan. The scanner is a safety net for
// SOURCE — generated artefacts and the lockfile are not where leaks land.
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "data",
  ".claude",
  "playwright-report",
  ".next",
  "coverage",
  "kb", // KB markdown dumps — sometimes contain bot-token-shaped strings in chat history
]);
const IGNORE_FILE_PATTERNS: RegExp[] = [
  /\.lock$/,
  /\.lockb$/,
  /package-lock\.json$/,
  /bun\.lock$/,
  /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|mp3|mp4|wav|ogg|opus|pdf)$/i,
  /\.min\.(js|css)$/,
];
// Files that MAY contain placeholder-shaped strings — scanner runs but
// matches against the file's `ignoreSubstrings` first.
const PLACEHOLDER_FILES = new Set(["env.example", ".env.example", "README.md"]);

type Hit = {
  file: string;
  line: number;
  pattern: string;
  excerpt: string;
};

function isIgnored(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (IGNORE_DIRS.has(seg)) return true;
  }
  for (const re of IGNORE_FILE_PATTERNS) {
    if (re.test(rel)) return true;
  }
  return false;
}

function listFiles(root: string): string[] {
  // Use git ls-files when in a repo so .gitignore is respected automatically.
  // Falls back to manual walk when git is unavailable.
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status === 0) {
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => join(root, p))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
  }
  // Fall back: scan via ripgrep listing if available, otherwise abort.
  const rg = spawnSync("rg", ["--files"], { cwd: root, encoding: "utf-8" });
  if (rg.status === 0) {
    return rg.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => join(root, p));
  }
  console.error("[scan-secrets] Neither git nor ripgrep available; aborting.");
  process.exit(2);
}

function listStagedFiles(root: string): string[] {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=AM"], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error(`[scan-secrets] git diff --cached failed: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => join(root, p))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function scanFile(absPath: string, root: string): Hit[] {
  const rel = relative(root, absPath);
  if (isIgnored(rel)) return [];
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return []; // binary or unreadable
  }
  // Cheap binary-check — bail if file has lots of NUL.
  if (content.includes("\0")) return [];

  const isPlaceholder = PLACEHOLDER_FILES.has(rel) || PLACEHOLDER_FILES.has(rel.split("/").pop()!);
  // Test files routinely embed placeholder-shaped secrets to exercise
  // detection / redaction logic. Allow shapes that obviously aren't real
  // (long runs of the same letter, or contain the literal `XXXX`/`YYYY`/`ZZZZ`).
  const isTestFile = rel.startsWith("tests/") || /\.test\.[cm]?[tj]s$/.test(rel);
  const hits: Hit[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    while (true) {
      const match = p.re.exec(content);
      if (!match) break;
      const full = match[0];
      const ignored =
        (isPlaceholder && /example|placeholder|your[_-]token|XXXX|YYYY|ZZZZ/i.test(full)) ||
        (isTestFile && /XXXX|YYYY|ZZZZ|FAKE|PLACEHOLDER/.test(full)) ||
        p.ignoreSubstrings?.some((s) => full.includes(s));
      if (ignored) continue;
      const lineNum = content.slice(0, match.index).split("\n").length;
      hits.push({
        file: rel,
        line: lineNum,
        pattern: p.name,
        excerpt: full.length > 80 ? `${full.slice(0, 60)}…[+${full.length - 60}]` : full,
      });
    }
  }
  return hits;
}

function main() {
  const root = process.cwd();
  const stagedOnly = process.argv.includes("--staged");
  const files = stagedOnly ? listStagedFiles(root) : listFiles(root);

  const t0 = Date.now();
  const hits: Hit[] = [];
  for (const f of files) {
    hits.push(...scanFile(f, root));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`[scan-secrets] scanned ${files.length} files in ${elapsed}s`);

  if (hits.length === 0) {
    console.log("[scan-secrets] no secrets detected ✓");
    process.exit(0);
  }

  console.error(
    `\n[scan-secrets] ${hits.length} potential secret${hits.length > 1 ? "s" : ""} found:\n`,
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.pattern}]  ${h.excerpt}`);
  }
  console.error(
    `\nIf any of these are FALSE POSITIVES — replace them with placeholders (XXXX, your_token) ` +
      `or extend ignoreSubstrings in scripts/scan-secrets.ts. ` +
      `If REAL — rotate the credential immediately and remove from history.`,
  );
  process.exit(1);
}

main();

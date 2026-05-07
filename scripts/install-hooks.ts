#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
/**
 * Installs the project's git hooks into `.git/hooks/`. Idempotent:
 * re-running replaces stale hooks with the current source. Run via:
 *
 *   bun run hooks:install
 *
 * The hooks themselves live under `scripts/git-hooks/` so they're
 * version-controlled and reviewable. `.git/hooks/` is per-clone and
 * never committed, so we sync from source on demand.
 */
import { chmodSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function gitRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error("[install-hooks] not inside a git repo");
    process.exit(1);
  }
  return r.stdout.trim();
}

/** Hooks live in the COMMON git dir so they're shared across all
 *  worktrees of a repo (`.git/hooks/`, not `.git/worktrees/<name>/hooks/`). */
function gitCommonDir(): string {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error("[install-hooks] git rev-parse --git-common-dir failed");
    process.exit(1);
  }
  // git may return a relative path on older versions
  const out = r.stdout.trim();
  return resolve(gitRoot(), out);
}

const root = gitRoot();
const srcDir = resolve(root, "scripts/git-hooks");
const dstDir = join(gitCommonDir(), "hooks");

if (!existsSync(srcDir)) {
  console.error(`[install-hooks] source dir not found: ${srcDir}`);
  process.exit(1);
}
if (!existsSync(dstDir)) {
  console.error(`[install-hooks] .git/hooks not found — is this really a git repo?`);
  process.exit(1);
}

let installed = 0;
for (const file of readdirSync(srcDir)) {
  if (file.startsWith(".")) continue;
  const src = join(srcDir, file);
  const dst = join(dstDir, file);
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  console.log(`  + ${file}`);
  installed++;
}

console.log(`\n[install-hooks] installed ${installed} hook(s) into ${dstDir}`);
console.log("[install-hooks] use `git commit --no-verify` to skip when needed");

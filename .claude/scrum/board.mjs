#!/usr/bin/env bun
// Тонкая обёртка над `gh` для доски Projects v2 «Lead Engine».
// Единственное место, где живут ID проекта/полей/опций (см. board.config.json).
//
// Использование:
//   bun .claude/scrum/board.mjs status                 — счётчики по колонкам
//   bun .claude/scrum/board.mjs list "Todo"            — карточки в колонке (JSON)
//   bun .claude/scrum/board.mjs issue <number>         — полный issue (JSON)
//   bun .claude/scrum/board.mjs move <itemId> "In Review"  — двинуть карточку
//   bun .claude/scrum/board.mjs comment <number>       — коммент к issue (тело из stdin)
//   bun .claude/scrum/board.mjs config                 — распечатать конфиг
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dir, "board.config.json"), "utf8"));

function gh(args, opts = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function statusOptId(name) {
  const id = cfg.status[name];
  if (!id) {
    throw new Error(
      `Unknown status "${name}". Known: ${Object.keys(cfg.status).join(", ")}`,
    );
  }
  return id;
}

function listItems() {
  const raw = gh([
    "project",
    "item-list",
    String(cfg.projectNumber),
    "--owner",
    cfg.owner,
    "--format",
    "json",
    "--limit",
    "300",
  ]);
  const data = JSON.parse(raw);
  return (data.items || []).map((it) => ({
    itemId: it.id,
    status: it.status || null,
    type: it.content?.type || null,
    number: it.content?.number ?? null,
    title: it.title || it.content?.title || "",
    url: it.content?.url || null,
    repository: it.content?.repository || null,
  }));
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  switch (cmd) {
    case "status": {
      const items = listItems();
      const counts = {};
      for (const key of Object.keys(cfg.status)) counts[key] = 0;
      for (const it of items) {
        if (it.status && it.status in counts) counts[it.status] += 1;
      }
      process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
      break;
    }
    case "list": {
      const status = rest.join(" ").trim();
      let items = listItems();
      if (status) items = items.filter((it) => it.status === status);
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      break;
    }
    case "issue": {
      const number = rest[0];
      if (!number) throw new Error("issue <number> required");
      const raw = gh([
        "issue",
        "view",
        String(number),
        "--repo",
        cfg.repo,
        "--json",
        "number,title,body,labels,url,state,assignees",
      ]);
      process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
      break;
    }
    case "move": {
      const itemId = rest[0];
      const status = rest.slice(1).join(" ").trim();
      if (!itemId || !status) throw new Error('move <itemId> "<status>" required');
      gh([
        "project",
        "item-edit",
        "--id",
        itemId,
        "--project-id",
        cfg.projectId,
        "--field-id",
        cfg.statusFieldId,
        "--single-select-option-id",
        statusOptId(status),
      ]);
      process.stdout.write(`moved ${itemId} -> ${status}\n`);
      break;
    }
    case "comment": {
      const number = rest[0];
      if (!number) throw new Error("comment <number> required (body on stdin)");
      const body = readFileSync(0, "utf8");
      gh(["issue", "comment", String(number), "--repo", cfg.repo, "--body-file", "-"], {
        input: body,
      });
      process.stdout.write(`commented on #${number}\n`);
      break;
    }
    case "config": {
      process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
      break;
    }
    default:
      process.stderr.write(
        'usage: board.mjs <status | list [status] | issue <n> | move <itemId> "<status>" | comment <n> | config>\n',
      );
      process.exit(1);
  }
} catch (err) {
  process.stderr.write(`board.mjs error: ${err?.message || err}\n`);
  process.exit(1);
}

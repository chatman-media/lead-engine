/**
 * Apply topic tags to currently-untagged KB documents using keyword rules
 * over their concatenated chunk text. Re-runnable: re-tags untagged rows
 * only — won't disturb anything already tagged. Print a counts summary at
 * the end so you can see the resulting distribution.
 *
 * Topic routing in src/rag/answer.ts (via classifyTopic) only kicks in when
 * docs ARE tagged — without tags every retrieval is a global search and
 * stale chat dumps get equal weight with curated content. Tagging fixes
 * that without deleting anything.
 *
 * Rules below are applied in priority order; first match wins. Update the
 * lists when the corpus shifts — the script is meant to be edited.
 */
import { config } from "../src/config.ts";
import { openDb } from "../src/db/sqlite.ts";

interface DocRow {
  id: number;
  title: string;
  text: string;
}

const RULES: Array<{ topic: string; patterns: RegExp[] }> = [
  // 1. Service / one-liner noise — login codes, "ок", "так бро", emoji-only.
  // Catches the worst signal-to-noise dumps so they never lead retrieval.
  {
    topic: "noise",
    patterns: [
      /код\s+для\s+входа/i,
      /telegram\s+code/i,
      /^\s*(ок|ok|👍|хорошо|спасибо|так\s+бро)\s*[!.?]*\s*$/i,
    ],
  },
  // 2. Concrete vacancy facts — rates, named cities, club types.
  {
    topic: "vacancy",
    patterns: [
      /\bюан/i,
      /₩/,
      /\bKTV\b/i,
      /караоке\s+хостес/i,
      /Ша[оа]хин/i,
      /Шаосин/i,
      /\bИу\b/i,
      /Санья/i,
      /Чжэцзян/i,
      /flower\s+consumption/i,
      /\b(хостес|хостесс)\b/i,
    ],
  },
  // 3. Visa / paperwork.
  {
    topic: "visa",
    patterns: [
      /\bвиз[аеуы]/i,
      /паспорт/i,
      /посольств/i,
      /консульств/i,
      /оформлен/i,
      /приглашен/i,
    ],
  },
  // 4. Payment / earnings (without specific city — generic).
  {
    topic: "payment",
    patterns: [
      /\bоплат/i,
      /\bставк/i,
      /чаев/i,
      /\bкомисси/i,
      /\bпремия\b/i,
      /\bбонус/i,
      /\bаванс/i,
      /\bрасход/i,
      /\bштраф/i,
    ],
  },
  // 5. Housing / accommodation.
  {
    topic: "housing",
    patterns: [/жил[ьеёяю]/i, /общежит/i, /квартир/i, /комнат/i, /проживан/i],
  },
  // 6. Travel / flights.
  {
    topic: "travel",
    patterns: [/\bрейс/i, /перел[её]т/i, /аэропорт/i, /\bбилет/i],
  },
  // 7. Candidate requirements.
  {
    topic: "requirements",
    patterns: [
      /\bрост\b/i,
      /\bвес\b/i,
      /\bвозраст/i,
      /\bпортфолио\b/i,
      /\bфотосет/i,
      /(\d+)\s*-\s*(\d+)\s*лет/i,
    ],
  },
];

const FALLBACK_TOPIC = "faq";

function classify(text: string): string {
  for (const { topic, patterns } of RULES) {
    if (patterns.some((p) => p.test(text))) return topic;
  }
  return FALLBACK_TOPIC;
}

const db = openDb({ path: config.dbPath });

const docs = db
  .query<DocRow, []>(
    `SELECT d.id AS id,
            d.title AS title,
            COALESCE(GROUP_CONCAT(c.text, '\n'), '') AS text
     FROM kb_documents d
     LEFT JOIN kb_chunks c ON c.document_id = d.id
     WHERE d.topic IS NULL
     GROUP BY d.id`,
  )
  .all();

console.log(`Found ${docs.length} untagged documents to classify.`);

const counts: Record<string, number> = {};
const update = db.prepare(`UPDATE kb_documents SET topic = ? WHERE id = ?`);

const tx = db.transaction((rows: DocRow[]) => {
  for (const row of rows) {
    // Title contributes to classification too — channel-dump titles often
    // carry the topical hint (e.g. "159-китаи-г-шаосин.md" → vacancy).
    const topic = classify(`${row.title}\n${row.text}`);
    update.run(topic, row.id);
    counts[topic] = (counts[topic] ?? 0) + 1;
  }
});
tx(docs);

console.log("\nResulting distribution:");
for (const [topic, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${topic.padEnd(14)} ${n}`);
}

const totalAll = db
  .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM kb_documents`)
  .get()!.n;
const stillUntagged = db
  .query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM kb_documents WHERE topic IS NULL`,
  )
  .get()!.n;
console.log(
  `\nTotal docs: ${totalAll}, still untagged: ${stillUntagged} (acts as neutral in topic-filtered search).`,
);

db.close();

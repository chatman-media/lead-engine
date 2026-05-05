import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderVacanciesBlock, VacanciesRepo } from "@/db/repos/vacancies.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;
let repo: VacanciesRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
  repo = new VacanciesRepo(db);
});
afterEach(() => db.close());

describe("VacanciesRepo", () => {
  test("create + listActive round-trip", () => {
    const v = repo.create({ title: "Шаохинг", body: "3000 юаней/смена" });
    expect(v.title).toBe("Шаохинг");
    expect(v.body).toBe("3000 юаней/смена");
    expect(v.is_active).toBe(1);
    expect(repo.listActive()).toHaveLength(1);
  });

  test("create trims whitespace from title and body", () => {
    const v = repo.create({ title: "  Стамбул  ", body: "  условия  " });
    expect(v.title).toBe("Стамбул");
    expect(v.body).toBe("условия");
  });

  test("listActive excludes inactive rows; listAll includes them", () => {
    const a = repo.create({ title: "A", body: "a body" });
    const b = repo.create({ title: "B", body: "b body" });
    repo.update(b.id, { isActive: false });
    expect(repo.listActive().map((v) => v.id)).toEqual([a.id]);
    expect(repo.listAll().map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("listActive ordering: freshest update first", async () => {
    const a = repo.create({ title: "A", body: "a" });
    // Wait a beat so updated_at differs
    await new Promise((r) => setTimeout(r, 1100));
    const b = repo.create({ title: "B", body: "b" });
    expect(repo.listActive()[0]!.id).toBe(b.id);
    // Editing A bumps it to the top
    repo.update(a.id, { body: "a updated" });
    expect(repo.listActive()[0]!.id).toBe(a.id);
  });

  test("update patches partial fields without touching others", () => {
    const v = repo.create({ title: "T1", body: "B1" });
    repo.update(v.id, { title: "T2" });
    const after = repo.byId(v.id);
    expect(after?.title).toBe("T2");
    expect(after?.body).toBe("B1");
  });

  test("update returns null for missing id (no row)", () => {
    expect(repo.update(99999, { title: "x" })).toBeNull();
  });

  test("delete removes the row, returns false on missing id", () => {
    const v = repo.create({ title: "T", body: "B" });
    expect(repo.delete(v.id)).toBe(true);
    expect(repo.byId(v.id)).toBeNull();
    expect(repo.delete(v.id)).toBe(false);
  });

  test("countActive ignores inactive rows", () => {
    const a = repo.create({ title: "A", body: "a" });
    repo.create({ title: "B", body: "b" });
    expect(repo.countActive()).toBe(2);
    repo.update(a.id, { isActive: false });
    expect(repo.countActive()).toBe(1);
  });
});

describe("renderVacanciesBlock", () => {
  test("returns empty string when input is empty", () => {
    expect(renderVacanciesBlock([])).toBe("");
  });

  test("returns empty string when no rows are active", () => {
    const closed = repo.create({ title: "T", body: "B" });
    repo.update(closed.id, { isActive: false });
    expect(renderVacanciesBlock(repo.listAll())).toBe("");
  });

  test("renders a heading + numbered active items", () => {
    repo.create({ title: "Шаохинг", body: "3000 ю/смена" });
    repo.create({ title: "Стамбул", body: "USD 500/нед" });
    const block = renderVacanciesBlock(repo.listActive());
    expect(block).toContain("АКТУАЛЬНЫЕ ВАКАНСИИ");
    expect(block).toContain("Шаохинг");
    expect(block).toContain("Стамбул");
    expect(block).toContain("3000 ю/смена");
    expect(block).toContain("USD 500/нед");
    expect(block).toContain("[В1]");
    expect(block).toContain("[В2]");
  });

  test("filters out inactive entries even if listAll() is passed", () => {
    const a = repo.create({ title: "Active", body: "ab" });
    const b = repo.create({ title: "Closed", body: "cb" });
    repo.update(b.id, { isActive: false });
    const block = renderVacanciesBlock(repo.listAll());
    expect(block).toContain("Active");
    expect(block).not.toContain("Closed");
    expect(a.id).toBeGreaterThan(0);
  });

  test("renders the URL line + link-handling instruction when set", () => {
    repo.create({
      title: "Корея",
      body: "оклад ₩110k",
      url: "https://t.me/infinity_agency_world",
    });
    repo.create({ title: "Шаохинг", body: "10k юаней" }); // no url
    const block = renderVacanciesBlock(repo.listActive());
    expect(block).toContain("Ссылка: https://t.me/infinity_agency_world");
    // The instruction telling the bot when to drop the link.
    expect(block).toContain("ТОЛЬКО когда кандидат сам спрашивает");
    // Vacancy without URL → no "Ссылка:" line on its block
    const vacanciesText = block.split("[В")[2] ?? ""; // chunk for the 2nd vacancy
    expect(vacanciesText).not.toContain("Ссылка:");
  });
});

describe("VacanciesRepo URL handling", () => {
  test("create stores trimmed url + auto-prefixes scheme", () => {
    const a = repo.create({ title: "T", body: "B", url: "  t.me/foo  " });
    expect(a.url).toBe("https://t.me/foo");
    const b = repo.create({ title: "T2", body: "B2", url: "https://x.com" });
    expect(b.url).toBe("https://x.com");
    const c = repo.create({ title: "T3", body: "B3", url: "tg://resolve?domain=foo" });
    expect(c.url).toBe("tg://resolve?domain=foo");
  });

  test("create normalises empty/whitespace url to null", () => {
    const a = repo.create({ title: "T", body: "B", url: "" });
    expect(a.url).toBeNull();
    const b = repo.create({ title: "T2", body: "B2", url: "   " });
    expect(b.url).toBeNull();
    const c = repo.create({ title: "T3", body: "B3" });
    expect(c.url).toBeNull();
  });

  test("update can clear url with null and replace with a new value", () => {
    const v = repo.create({ title: "T", body: "B", url: "t.me/a" });
    expect(v.url).toBe("https://t.me/a");
    const cleared = repo.update(v.id, { url: null });
    expect(cleared?.url).toBeNull();
    const set = repo.update(v.id, { url: "t.me/b" });
    expect(set?.url).toBe("https://t.me/b");
  });

  test("update keeps existing url when patch omits it", () => {
    const v = repo.create({ title: "T", body: "B", url: "t.me/a" });
    const patched = repo.update(v.id, { title: "T2" });
    expect(patched?.url).toBe("https://t.me/a");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { renderVacanciesBlock, VacanciesRepo } from "@/db/repos/vacancies.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let repo: VacanciesRepo;

beforeEach(() => {
  repo = new VacanciesRepo(sql);
});

describe("VacanciesRepo", () => {
  test("create + listActive round-trip", async () => {
    const v = await repo.create({ title: "Шаохинг", body: "3000 юаней/смена" });
    expect(v.title).toBe("Шаохинг");
    expect(v.body).toBe("3000 юаней/смена");
    expect(v.is_active).toBe(true);
    expect(await repo.listActive()).toHaveLength(1);
  });

  test("create trims whitespace from title and body", async () => {
    const v = await repo.create({ title: "  Стамбул  ", body: "  условия  " });
    expect(v.title).toBe("Стамбул");
    expect(v.body).toBe("условия");
  });

  test("listActive excludes inactive rows; listAll includes them", async () => {
    const a = await repo.create({ title: "A", body: "a body" });
    const b = await repo.create({ title: "B", body: "b body" });
    await repo.update(b.id, { isActive: false });
    expect((await repo.listActive()).map((v) => v.id)).toEqual([a.id]);
    expect((await repo.listAll()).map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("listActive ordering: freshest update first", async () => {
    const a = await repo.create({ title: "A", body: "a" });
    // Wait a beat so updated_at differs
    await new Promise((r) => setTimeout(r, 1100));
    const b = await repo.create({ title: "B", body: "b" });
    expect((await repo.listActive())[0]!.id).toBe(b.id);
    // Editing A bumps it to the top
    await repo.update(a.id, { body: "a updated" });
    expect((await repo.listActive())[0]!.id).toBe(a.id);
  });

  test("update patches partial fields without touching others", async () => {
    const v = await repo.create({ title: "T1", body: "B1" });
    await repo.update(v.id, { title: "T2" });
    const after = await repo.byId(v.id);
    expect(after?.title).toBe("T2");
    expect(after?.body).toBe("B1");
  });

  test("update returns null for missing id (no row)", async () => {
    expect(await repo.update(99999, { title: "x" })).toBeNull();
  });

  test("delete removes the row, returns false on missing id", async () => {
    const v = await repo.create({ title: "T", body: "B" });
    expect(await repo.delete(v.id)).toBe(true);
    expect(await repo.byId(v.id)).toBeNull();
    expect(await repo.delete(v.id)).toBe(false);
  });

  test("countActive ignores inactive rows", async () => {
    const a = await repo.create({ title: "A", body: "a" });
    await repo.create({ title: "B", body: "b" });
    expect(await repo.countActive()).toBe(2);
    await repo.update(a.id, { isActive: false });
    expect(await repo.countActive()).toBe(1);
  });
});

describe("renderVacanciesBlock", () => {
  test("returns empty string when input is empty", () => {
    expect(renderVacanciesBlock([])).toBe("");
  });

  test("returns empty string when no rows are active", async () => {
    const closed = await repo.create({ title: "T", body: "B" });
    await repo.update(closed.id, { isActive: false });
    expect(renderVacanciesBlock(await repo.listAll())).toBe("");
  });

  test("renders a heading + numbered active items", async () => {
    await repo.create({ title: "Шаохинг", body: "3000 ю/смена" });
    await repo.create({ title: "Стамбул", body: "USD 500/нед" });
    const block = renderVacanciesBlock(await repo.listActive());
    expect(block).toContain("АКТУАЛЬНЫЕ ВАКАНСИИ");
    expect(block).toContain("Шаохинг");
    expect(block).toContain("Стамбул");
    expect(block).toContain("3000 ю/смена");
    expect(block).toContain("USD 500/нед");
    expect(block).toContain("[В1]");
    expect(block).toContain("[В2]");
  });

  test("filters out inactive entries even if listAll() is passed", async () => {
    const a = await repo.create({ title: "Active", body: "ab" });
    const b = await repo.create({ title: "Closed", body: "cb" });
    await repo.update(b.id, { isActive: false });
    const block = renderVacanciesBlock(await repo.listAll());
    expect(block).toContain("Active");
    expect(block).not.toContain("Closed");
    expect(a.id).toBeGreaterThan(0);
  });

  test("renders ОТКРЫТЫЕ ЛОКАЦИИ from titles + hard redirect rule", async () => {
    await repo.create({ title: "Корея — Караоке хостес", body: "₩110k" });
    await repo.create({ title: "Шаохинг / Иу — Premium хостес", body: "10k юаней" });
    await repo.create({ title: "Менеджер — Шаохинг / Иу / Корея", body: "..." });
    const block = renderVacanciesBlock(await repo.listActive());

    // Headline is auto-extracted before " — " separator; deduped preserving order.
    expect(block).toContain("ОТКРЫТЫЕ ЛОКАЦИИ:");
    expect(block).toMatch(/ОТКРЫТЫЕ ЛОКАЦИИ:.*Корея/);
    expect(block).toMatch(/ОТКРЫТЫЕ ЛОКАЦИИ:.*Шаохинг \/ Иу/);
    expect(block).toMatch(/ОТКРЫТЫЕ ЛОКАЦИИ:.*Менеджер/);

    // The hard redirect rule must be present so the LLM stops answering about
    // unsupported locations from KB chunks.
    expect(block).toContain("ЖЁСТКОЕ ПРАВИЛО");
    expect(block).toContain("Дубай");
    expect(block).toContain("НЕ переноси цифры");
  });

  test("renders the URL line + link-handling instruction when set", async () => {
    await repo.create({
      title: "Корея",
      body: "оклад ₩110k",
      url: "https://t.me/infinity_agency_world",
    });
    await repo.create({ title: "Шаохинг", body: "10k юаней" }); // no url
    const block = renderVacanciesBlock(await repo.listActive());
    expect(block).toContain("Ссылка: https://t.me/infinity_agency_world");
    // The instruction telling the bot to always include the link.
    expect(block).toContain("ВСЕГДА включай её когда называешь эту вакансию");
    // Vacancy without URL → no "Ссылка:" line on its block
    const vacanciesText = block.split("[В")[2] ?? ""; // chunk for the 2nd vacancy
    expect(vacanciesText).not.toContain("Ссылка:");
  });
});

describe("VacanciesRepo URL handling", () => {
  test("create stores trimmed url + auto-prefixes scheme", async () => {
    const a = await repo.create({ title: "T", body: "B", url: "  t.me/foo  " });
    expect(a.url).toBe("https://t.me/foo");
    const b = await repo.create({ title: "T2", body: "B2", url: "https://x.com" });
    expect(b.url).toBe("https://x.com");
    const c = await repo.create({ title: "T3", body: "B3", url: "tg://resolve?domain=foo" });
    expect(c.url).toBe("tg://resolve?domain=foo");
  });

  test("create normalises empty/whitespace url to null", async () => {
    const a = await repo.create({ title: "T", body: "B", url: "" });
    expect(a.url).toBeNull();
    const b = await repo.create({ title: "T2", body: "B2", url: "   " });
    expect(b.url).toBeNull();
    const c = await repo.create({ title: "T3", body: "B3" });
    expect(c.url).toBeNull();
  });

  test("update can clear url with null and replace with a new value", async () => {
    const v = await repo.create({ title: "T", body: "B", url: "t.me/a" });
    expect(v.url).toBe("https://t.me/a");
    const cleared = await repo.update(v.id, { url: null });
    expect(cleared?.url).toBeNull();
    const set = await repo.update(v.id, { url: "t.me/b" });
    expect(set?.url).toBe("https://t.me/b");
  });

  test("update keeps existing url when patch omits it", async () => {
    const v = await repo.create({ title: "T", body: "B", url: "t.me/a" });
    const patched = await repo.update(v.id, { title: "T2" });
    expect(patched?.url).toBe("https://t.me/a");
  });
});

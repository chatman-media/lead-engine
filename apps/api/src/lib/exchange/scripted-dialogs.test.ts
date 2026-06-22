import { describe, expect, it } from "bun:test";
import {
  __clearScriptedDialogsCache,
  getScriptedDialog,
  loadScriptedDialogs,
  parseCandidateCaseMarkdown,
} from "./scripted-dialogs.ts";

describe("parseCandidateCaseMarkdown", () => {
  it("извлекает заголовок, ходы и медиа", () => {
    const md = [
      "# Реплики кандидата: RUB→THB, QR, KYC",
      "",
      "## 1",
      "Здравствуйте, хочу перевести 35 000 через qr",
      "снятие в зелёном банкомате",
      "",
      "## 2",
      "[фото]",
      "[фото]",
      "Можете сверить?",
      "",
      "## 3",
      "[файл]",
    ].join("\n");
    const d = parseCandidateCaseMarkdown("07-test", "THB", md);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.title).toBe("RUB→THB, QR, KYC");
    expect(d.currency).toBe("THB");
    expect(d.turns).toHaveLength(3);
    // Ход 1: только текст (две строки склеены).
    expect(d.turns[0]?.text).toBe(
      "Здравствуйте, хочу перевести 35 000 через qr\nснятие в зелёном банкомате",
    );
    expect(d.turns[0]?.media).toEqual([]);
    // Ход 2: два фото + текст.
    expect(d.turns[1]?.media).toEqual(["photo", "photo"]);
    expect(d.turns[1]?.text).toBe("Можете сверить?");
    // Ход 3: только файл, без текста.
    expect(d.turns[2]?.media).toEqual(["document"]);
    expect(d.turns[2]?.text).toBe("");
    expect(d.mediaCount).toBe(3);
  });

  it("оставляет inline-редакции в тексте, не считая их вложениями", () => {
    const md = [
      "# Реплики кандидата: THB→RUB",
      "## 1",
      "Карта привязана к номеру",
      "[телефон]",
      "Сбербанк",
    ].join("\n");
    const d = parseCandidateCaseMarkdown("13-test", "THB", md);
    expect(d?.turns).toHaveLength(1);
    expect(d?.turns[0]?.media).toEqual([]);
    expect(d?.turns[0]?.text).toContain("[телефон]");
  });

  it("возвращает null для файла без реплик (index.md)", () => {
    const md = ["# Exchange candidate cases", "", "Таблица кейсов…"].join("\n");
    expect(parseCandidateCaseMarkdown("index", "THB", md)).toBeNull();
  });
});

describe("loadScriptedDialogs", () => {
  it("грузит THB-диалоги из candidate-cases (>=10 кейсов)", () => {
    const dialogs = loadScriptedDialogs("THB");
    expect(dialogs.length).toBeGreaterThanOrEqual(10);
    // Все имеют непустые ходы и осмысленный заголовок.
    for (const d of dialogs) {
      expect(d.turns.length).toBeGreaterThan(0);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.currency).toBe("THB");
    }
    // index.md не попал в список.
    expect(dialogs.find((d) => d.id === "index")).toBeUndefined();
  });

  it("грузит PHP-диалоги из ph/ (>=5 кейсов)", () => {
    const dialogs = loadScriptedDialogs("PHP");
    expect(dialogs.length).toBeGreaterThanOrEqual(5);
    for (const d of dialogs) expect(d.currency).toBe("PHP");
  });
});

describe("getScriptedDialog", () => {
  it("находит диалог по id (lines 168-171)", () => {
    const all = loadScriptedDialogs("THB");
    const first = all[0];
    expect(first).toBeDefined();
    if (!first) return;
    const found = getScriptedDialog("THB", first.id);
    expect(found?.id).toBe(first.id);
  });

  it("неизвестный id → undefined", () => {
    expect(getScriptedDialog("THB", "no-such-dialog-xyz")).toBeUndefined();
  });
});

describe("__clearScriptedDialogsCache", () => {
  it("сбрасывает кэш — повторная загрузка перечитывает файлы (line 176)", () => {
    const before = loadScriptedDialogs("THB");
    __clearScriptedDialogsCache();
    const after = loadScriptedDialogs("THB");
    // другой инстанс массива (кэш был очищен), но тот же контент
    expect(after).not.toBe(before);
    expect(after.length).toBe(before.length);
  });
});

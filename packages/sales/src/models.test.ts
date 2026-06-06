import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_ID, getModelInfo, listModels, listModelsByProvider, MODELS } from "./models.ts";

describe("models", () => {
  it("MODELS непустой, id уникальны", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("getModelInfo: найден / не найден", () => {
    expect(getModelInfo(MODELS[0]!.id)?.id).toBe(MODELS[0]!.id);
    expect(getModelInfo("no-such-model")).toBeUndefined();
  });
  it("listModels возвращает весь список", () => {
    expect(listModels()).toBe(MODELS);
  });
  it("listModelsByProvider фильтрует по провайдеру", () => {
    const provider = MODELS[0]!.provider;
    const filtered = listModelsByProvider(provider);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((m) => m.provider === provider)).toBe(true);
  });
  it("DEFAULT_MODEL_ID = первая модель", () => {
    expect(DEFAULT_MODEL_ID).toBe(MODELS[0]!.id);
  });
});

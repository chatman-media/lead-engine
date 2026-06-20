import { describe, expect, it } from "bun:test";
import { DEFAULT_PH_BBOX, validateBbox } from "./osm-sync.ts";

describe("validateBbox", () => {
  it("принимает корректный bbox (дефолт Манилы)", () => {
    expect(() => validateBbox(DEFAULT_PH_BBOX)).not.toThrow();
    expect(() => validateBbox("14.35, 120.90, 14.80, 121.15")).not.toThrow();
  });

  it("режет неверное число компонентов / нечисловые", () => {
    expect(() => validateBbox("14.35,120.90,14.80")).toThrow();
    expect(() => validateBbox("14.35,120.90,14.80,121.15,99")).toThrow();
    expect(() => validateBbox("a,b,c,d")).toThrow();
    // Попытка инъекции Overpass QL в bbox.
    expect(() => validateBbox("0,0,1,1];out;node[amenity=atm];//")).toThrow();
  });

  it("режет выход за диапазон широты/долготы", () => {
    expect(() => validateBbox("-91,0,10,10")).toThrow();
    expect(() => validateBbox("0,0,91,10")).toThrow();
    expect(() => validateBbox("0,-181,10,10")).toThrow();
  });

  it("режет инвертированный bbox (min >= max)", () => {
    expect(() => validateBbox("20,0,10,10")).toThrow();
    expect(() => validateBbox("0,20,10,10")).toThrow();
  });
});

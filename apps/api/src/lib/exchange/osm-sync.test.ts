import { afterEach, describe, expect, it } from "bun:test";
import type { Db } from "@chatman-media/conversation-engine";
import {
  DEFAULT_PH_BBOX,
  fetchOsmAtms,
  resolveBankConfig,
  syncOsmAtms,
  validateBbox,
} from "./osm-sync.ts";

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

describe("resolveBankConfig", () => {
  it("матчит банк по operator/brand/name", () => {
    expect(resolveBankConfig({ operator: "Landbank of the Philippines" })?.bankName).toBe(
      "Landbank",
    );
    expect(resolveBankConfig({ brand: "PNB" })?.bankName).toBe("PNB");
    expect(resolveBankConfig({ name: "DBP ATM" })?.bankName).toBe("DBP");
  });

  it("неизвестный банк → null", () => {
    expect(resolveBankConfig({ name: "Какой-то ларёк" })).toBeNull();
    expect(resolveBankConfig({})).toBeNull();
  });
});

describe("fetchOsmAtms", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("happy: фильтрует elements до node-ов", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        elements: [
          { type: "node", id: 1, lat: 14.5, lon: 121.0, tags: { amenity: "atm" } },
          { type: "way", id: 2 },
        ],
      })) as unknown as typeof fetch;
    const nodes = await fetchOsmAtms(DEFAULT_PH_BBOX);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe(1);
  });

  it("не-ok ответ → throw Overpass HTTP", async () => {
    globalThis.fetch = (async () =>
      new Response("err", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchOsmAtms(DEFAULT_PH_BBOX)).rejects.toThrow("Overpass HTTP 500");
  });

  it("все попытки 429 → retry/backoff → throw 'перегружен' (lines 194, 212-222)", async () => {
    const origST = globalThis.setTimeout;
    // мгновенный setTimeout: backoff не тормозит тест.
    globalThis.setTimeout = ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.fetch = (async () =>
      new Response("busy", { status: 429 })) as unknown as typeof fetch;
    try {
      await expect(fetchOsmAtms(DEFAULT_PH_BBOX)).rejects.toThrow("перегружен");
    } finally {
      globalThis.setTimeout = origST;
    }
  });

  it("невалидный bbox → throw до сети", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ elements: [] });
    }) as unknown as typeof fetch;
    await expect(fetchOsmAtms("bad")).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("syncOsmAtms", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("апсертит банковские ATM, скипает небанковские; покрывает buildLabel/Address/City", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        elements: [
          // branch → label "Landbank Makati"; addr:full → address; addr:city → city
          {
            type: "node",
            id: 1,
            lat: 14.5,
            lon: 121.0,
            tags: {
              operator: "Landbank",
              branch: "Makati",
              "addr:full": "123 Ayala Ave",
              "addr:city": "Makati",
            },
          },
          // нет branch → place=suburb; street+housenumber → address; city из suburb
          {
            type: "node",
            id: 2,
            lat: 14.6,
            lon: 121.1,
            tags: {
              brand: "PNB",
              "addr:suburb": "Quezon",
              "addr:street": "Main St",
              "addr:housenumber": "5",
            },
          },
          // только name → label=bankName; нет адреса/города → null
          { type: "node", id: 3, lat: 14.7, lon: 121.2, tags: { name: "DBP" } },
          // небанковский → skipped
          { type: "node", id: 4, lat: 14.8, lon: 121.3, tags: { amenity: "atm" } },
        ],
      })) as unknown as typeof fetch;

    const execs: unknown[] = [];
    const db = {
      execute: async (q: unknown) => {
        execs.push(q);
        return undefined;
      },
    } as unknown as Db;

    const res = await syncOsmAtms(db, 1, { quoteAsset: "PHP" });
    expect(res.fetched).toBe(4);
    expect(res.upserted).toBe(3);
    expect(res.skipped).toBe(1);
    expect(execs).toHaveLength(3);
  });
});

import { describe, expect, it } from "bun:test";
import { chooseFunnelForIntent, classifyServiceIntent } from "./service-intent-router.ts";

describe("service-intent-router", () => {
  const funnels = [
    { id: 1, slug: "exchange", verticalTemplateId: "exchange_v1" },
    { id: 2, slug: "real_estate", verticalTemplateId: "real_estate_v1" },
    { id: 3, slug: "product", verticalTemplateId: "saas_v1" },
    { id: 4, slug: "partners", verticalTemplateId: null },
  ];

  it("classifies core business intents", () => {
    expect(classifyServiceIntent("хочу обменять USDT trc20 на баты")).toBe("exchange");
    expect(classifyServiceIntent("нужна вилла в аренду на Пхукете")).toBe("real_estate");
    expect(classifyServiceIntent("покажи демо продукта и подписку")).toBe("product");
    expect(classifyServiceIntent("можете подключить партнёрский сервис?")).toBe("partner_service");
  });

  it("chooses matching funnel and falls back on unclear text", () => {
    expect(chooseFunnelForIntent(funnels, "курс USDT")?.slug).toBe("exchange");
    expect(chooseFunnelForIntent(funnels, "ищу condo")?.slug).toBe("real_estate");
    expect(chooseFunnelForIntent(funnels, "что у вас есть?")?.slug).toBe("exchange");
  });
});

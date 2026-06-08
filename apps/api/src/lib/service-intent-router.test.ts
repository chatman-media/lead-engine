import { describe, expect, it } from "bun:test";
import {
  chooseFunnelForIntent,
  chooseServiceRoute,
  classifyServiceIntent,
  type RoutableCatalogItem,
} from "./service-intent-router.ts";

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

  it("prefers matching service catalog item before deterministic intent fallback", () => {
    const catalog = [
      item({ id: 10, slug: "vip_support", name: "VIP сопровождение", routeType: "funnel", funnelId: 2 }),
    ];
    const route = chooseServiceRoute({
      funnels,
      catalogItems: catalog,
      text: "нужно VIP сопровождение для клиента",
    });

    expect(route.source).toBe("catalog");
    expect(route.catalogItem?.slug).toBe("vip_support");
    expect(route.funnel?.slug).toBe("real_estate");
  });

  it("routes partner/webhook/manual catalog items to selected or default funnel", () => {
    const partnerRoute = chooseServiceRoute({
      funnels,
      catalogItems: [
        item({
          id: 11,
          slug: "airport_transfer",
          name: "Трансфер аэропорт",
          routeType: "partner_service",
          partnerServiceId: 7,
          partnerServiceFunnelId: 4,
        }),
      ],
      text: "нужен трансфер аэропорт завтра",
    });
    expect(partnerRoute.source).toBe("catalog");
    expect(partnerRoute.funnel?.slug).toBe("partners");

    const webhookRoute = chooseServiceRoute({
      funnels,
      catalogItems: [
        item({
          id: 13,
          slug: "visa_consulting",
          name: "Визовая консультация",
          routeType: "webhook",
          funnelId: 3,
          webhookUrl: "https://partner.example/hook",
        }),
      ],
      text: "нужна визовая консультация",
    });
    expect(webhookRoute.source).toBe("catalog");
    expect(webhookRoute.funnel?.slug).toBe("product");

    const manualRoute = chooseServiceRoute({
      funnels,
      catalogItems: [
        item({ id: 12, slug: "custom_request", name: "Индивидуальный запрос", routeType: "manual" }),
      ],
      text: "индивидуальный запрос на завтра",
    });
    expect(manualRoute.source).toBe("catalog");
    expect(manualRoute.funnel?.slug).toBe("exchange");
  });
});

function item(input: Partial<RoutableCatalogItem> & { id: number; slug: string; name: string }): RoutableCatalogItem {
  return {
    category: null,
    description: null,
    routeType: "manual",
    funnelId: null,
    partnerServiceId: null,
    partnerServiceFunnelId: null,
    partnerServiceStageDefinitionId: null,
    webhookUrl: null,
    ...input,
  };
}

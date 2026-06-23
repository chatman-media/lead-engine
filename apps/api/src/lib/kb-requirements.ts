export type KbRequirement = {
  key: string;
  title: string;
  description: string;
  topic: string;
  required: boolean;
  scopeType: "funnel" | "stage";
  funnelId: number;
  stageSlug: string | null;
  covered: boolean;
  matchedDocuments: number;
};

export type KbRequirementDraft = Omit<KbRequirement, "covered" | "matchedDocuments">;

export type KbRequirementCoverageDocument = {
  topic: string | null;
  scopeType: string;
  funnelId: number | null;
  stageSlug: string | null;
};

function addRequirement(map: Map<string, KbRequirementDraft>, req: KbRequirementDraft) {
  if (!map.has(req.key)) map.set(req.key, req);
}

export function buildKbRequirementDrafts(input: {
  funnel: { id: number; slug: string; verticalTemplateId: string | null };
  stages: Array<{
    slug: string;
    displayName: string;
    stageType: string;
    fields: Array<{ fieldType: string; required: boolean }>;
  }>;
}): KbRequirementDraft[] {
  const { funnel, stages } = input;
  const out = new Map<string, KbRequirementDraft>();
  const isExchange =
    funnel.slug.includes("exchange") || funnel.verticalTemplateId === "exchange_v1";

  addRequirement(out, {
    key: "business_overview",
    title: "Что делает бизнес",
    description: "Краткое описание услуги, кому она подходит, что бот может обещать клиенту.",
    topic: "business_overview",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });
  addRequirement(out, {
    key: "process_and_sla",
    title: "Процесс и сроки",
    description: "Как проходит заявка по шагам, типичные сроки, где нужен оператор.",
    topic: "process",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });
  addRequirement(out, {
    key: "pricing_terms",
    title: "Цены, лимиты и условия",
    description: "Что можно называть клиенту, где брать цену, какие лимиты/комиссии/исключения.",
    topic: "pricing",
    required: true,
    scopeType: "funnel",
    funnelId: funnel.id,
    stageSlug: null,
  });

  if (isExchange) {
    for (const req of [
      {
        key: "exchange_how_to_pay",
        title: "Как оплатить / перевести",
        description: "Пошаговая инструкция по RUB/crypto оплате, что прислать как proof.",
        topic: "how_to_pay",
      },
      {
        key: "exchange_kyc_aml",
        title: "KYC и AML правила",
        description: "Когда нужна верификация, какие документы, что делать при high-risk.",
        topic: "kyc_aml",
      },
      {
        key: "exchange_payout",
        title: "Способы выдачи THB",
        description: "Офис, cardless ATM, курьер, банковский перевод, зоны и ограничения.",
        topic: "payout",
      },
      {
        key: "exchange_locations",
        title: "Офисы и точки выдачи",
        description: "Адреса, часы работы, районы, как выбрать ближайшую точку.",
        topic: "locations",
      },
    ]) {
      addRequirement(out, {
        ...req,
        required: true,
        scopeType: "funnel",
        funnelId: funnel.id,
        stageSlug: null,
      });
    }
  }

  for (const stage of stages) {
    const hasRequiredMedia = stage.fields.some(
      (field) => field.required && ["file", "photo", "video"].includes(field.fieldType),
    );
    if (stage.stageType === "payment") {
      addRequirement(out, {
        key: `stage_${stage.slug}_payment`,
        title: `${stage.displayName}: оплата`,
        description:
          "Методы оплаты, реквизиты/ссылки, подтверждение платежа, что нельзя писать без проверки.",
        topic: "payment",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (
      stage.stageType === "document_upload" ||
      stage.stageType === "document_signature" ||
      hasRequiredMedia
    ) {
      addRequirement(out, {
        key: `stage_${stage.slug}_documents`,
        title: `${stage.displayName}: документы`,
        description: "Какие документы нужны, формат файлов, кто проверяет и что делать при ошибке.",
        topic: "documents",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (stage.stageType === "awaiting_operator" || stage.stageType === "external_approval") {
      addRequirement(out, {
        key: `stage_${stage.slug}_handoff`,
        title: `${stage.displayName}: решение оператора`,
        description:
          "Что бот может сказать до ответа оператора, SLA, какие данные передать человеку.",
        topic: "operator_handoff",
        required: false,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
    if (stage.stageType === "rate_confirmation") {
      addRequirement(out, {
        key: `stage_${stage.slug}_rate_policy`,
        title: `${stage.displayName}: курс/расчёт`,
        description: "Источник курса, срок фиксации, что делать при торге или устаревшем курсе.",
        topic: "rates",
        required: true,
        scopeType: "stage",
        funnelId: funnel.id,
        stageSlug: stage.slug,
      });
    }
  }

  return [...out.values()];
}

export function coverKbRequirements(
  drafts: KbRequirementDraft[],
  docs: KbRequirementCoverageDocument[],
): KbRequirement[] {
  return drafts.map((req) => {
    const matchedDocuments = docs.filter((doc) => {
      if (doc.topic !== req.topic && doc.topic !== req.key) return false;
      if (doc.scopeType === "global") return true;
      if (doc.scopeType === "funnel") return doc.funnelId === req.funnelId;
      if (doc.scopeType === "stage") {
        return doc.funnelId === req.funnelId && doc.stageSlug === req.stageSlug;
      }
      return false;
    }).length;
    return {
      ...req,
      covered: matchedDocuments > 0,
      matchedDocuments,
    };
  });
}

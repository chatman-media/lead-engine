import { Button } from "@/components/ui/button";

/**
 * #696 — быстрые ответы оператора. Когда ход у оператора (mode='human'), в
 * правой панели вместо справочных фрагментов БЗ показываем готовые заготовки
 * сообщений под текущую стадию — клик добавляет текст в поле ответа.
 *
 * v1: шаблоны захардкожены по стадии воронки (обмен) + универсальный набор.
 * Дальше — вынести в пер-тенант настройки (см. issue #696).
 */

const COMMON_REPLIES = [
  "Здравствуйте! Чем могу помочь?",
  "Минуту, уточняю информацию.",
  "Спасибо за обращение! Хорошего дня.",
];

const STAGE_REPLIES: Record<string, string[]> = {
  quote_calculated: [
    "Подтверждаю курс. Готовы оформить заявку?",
    "Как удобнее получить средства — наличными в офисе или переводом?",
  ],
  kyc_collection: [
    "Для продолжения нужна верификация: фото документа и короткий видео-кружок с ФИО и фразой о направлении обмена.",
    "Спасибо, материалы получены — проверяю и вернусь к вам.",
  ],
  order_created: [
    "Заявка создана. Сейчас пришлю реквизиты для оплаты.",
    "Как только получим оплату — подготовим выдачу.",
  ],
  requisites_sent: [
    "Реквизиты отправил. Подтвердите, пожалуйста, после оплаты.",
    "Оплата получена, готовим выдачу.",
  ],
};

export function QuickReplies({
  stage,
  onPick,
}: {
  stage: string | null;
  onPick: (text: string) => void;
}) {
  const stageReplies = (stage && STAGE_REPLIES[stage]) || [];
  const replies = [...stageReplies, ...COMMON_REPLIES];
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">⚡ Быстрые ответы</span>
        {stage && <span className="text-[10px] text-muted-foreground">{stage}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        {replies.map((text) => (
          <Button
            key={text}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs"
            onClick={() => onPick(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}

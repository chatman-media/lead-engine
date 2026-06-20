import { ScrollArea, Separator } from "@lead-engine/admin-ui";

const stages = [
  "Новый лид",
  "Квалификация",
  "Предложен курс",
  "Реквизиты отправлены",
  "Ждёт оплату",
  "Оплата получена",
  "Код выдан",
  "Завершено",
  "Возврат",
  "Эскалация",
];

export function StageList() {
  return (
    <div className="p-6">
      <ScrollArea className="h-44 w-56 rounded-md border">
        <div className="p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Этапы воронки</div>
          {stages.map((s) => (
            <div key={s}>
              <div className="py-1.5 text-sm">{s}</div>
              <Separator />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

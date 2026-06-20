import { Label, Textarea } from "@lead-engine/admin-ui";

export function WithLabel() {
  return (
    <div className="flex w-full max-w-md flex-col gap-2 p-6">
      <Label htmlFor="note">Заметка по лиду</Label>
      <Textarea
        id="note"
        rows={4}
        defaultValue="Клиент просил курс получше, обещал объём от 5 000 USDT в неделю. Передал оператору на согласование."
      />
    </div>
  );
}

export function States() {
  return (
    <div className="flex w-full max-w-md flex-col gap-4 p-6">
      <Textarea placeholder="Шаблон быстрого ответа…" rows={3} />
      <Textarea disabled placeholder="Редактирование недоступно" rows={2} />
    </div>
  );
}

import { Button } from "@lead-engine/admin-ui";

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-6">
      <Button>Создать заявку</Button>
      <Button variant="secondary">Отмена</Button>
      <Button variant="outline">Подробнее</Button>
      <Button variant="ghost">Пропустить</Button>
      <Button variant="destructive">Удалить лида</Button>
      <Button variant="link">Открыть диалог</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-6">
      <Button size="sm">Маленькая</Button>
      <Button size="default">Обычная</Button>
      <Button size="lg">Большая</Button>
      <Button size="icon" aria-label="Добавить">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-6">
      <Button>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
        Далее
      </Button>
      <Button variant="outline" disabled>
        Сохранение…
      </Button>
      <Button variant="destructive" disabled>
        Недоступно
      </Button>
    </div>
  );
}

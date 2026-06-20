import { Badge } from "@lead-engine/admin-ui";

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-6">
      <Badge>Новый</Badge>
      <Badge variant="secondary">Черновик</Badge>
      <Badge variant="outline">Архив</Badge>
      <Badge variant="success">Оплачено</Badge>
      <Badge variant="warning">Ждёт оплату</Badge>
      <Badge variant="destructive">Просрочено</Badge>
    </div>
  );
}

export function WithCounts() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-6">
      <Badge variant="success">+12.4%</Badge>
      <Badge variant="warning">3 в очереди</Badge>
      <Badge variant="destructive">2 эскалации</Badge>
      <Badge variant="secondary">USDT → THB</Badge>
    </div>
  );
}

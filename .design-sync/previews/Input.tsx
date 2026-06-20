import { Input, Label } from "@lead-engine/admin-ui";

export function WithLabel() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2 p-6">
      <Label htmlFor="email">Email клиента</Label>
      <Input id="email" type="email" placeholder="client@example.com" />
    </div>
  );
}

export function States() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-4 p-6">
      <Input placeholder="Сумма заявки, USDT" defaultValue="1 200" />
      <Input placeholder="Отключено" disabled />
      <Input placeholder="Курс" aria-invalid defaultValue="—" />
    </div>
  );
}

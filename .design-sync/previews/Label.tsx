import { Input, Label } from "@lead-engine/admin-ui";

export function Default() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2 p-6">
      <Label htmlFor="wallet">Кошелёк оператора</Label>
      <Input id="wallet" placeholder="TRC-20 адрес" />
      <p className="text-xs text-muted-foreground">Используется для приёма USDT по этой заявке.</p>
    </div>
  );
}

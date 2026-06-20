import { Label, PasswordInput } from "@lead-engine/admin-ui";

export function WithLabel() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2 p-6">
      <Label htmlFor="pwd">Пароль</Label>
      <PasswordInput id="pwd" defaultValue="super-secret" />
      <p className="text-xs text-muted-foreground">Нажмите на иконку, чтобы показать или скрыть.</p>
    </div>
  );
}

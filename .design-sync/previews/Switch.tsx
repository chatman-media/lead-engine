import { Label, Switch } from "@lead-engine/admin-ui";

export function States() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Switch defaultChecked id="ai" />
        <Label htmlFor="ai">AI отвечает автоматически</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="notify" />
        <Label htmlFor="notify">Уведомлять оператора</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch defaultChecked disabled id="locked" />
        <Label htmlFor="locked">Передано оператору (заблокировано)</Label>
      </div>
    </div>
  );
}

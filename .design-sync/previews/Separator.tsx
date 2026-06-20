import { Separator } from "@lead-engine/admin-ui";

export function Horizontal() {
  return (
    <div className="w-full max-w-sm p-6">
      <div className="text-sm font-medium">Lead Engine</div>
      <div className="text-xs text-muted-foreground">Платформа автоматизации продаж</div>
      <Separator className="my-3" />
      <div className="flex h-5 items-center gap-3 text-xs text-muted-foreground">
        <span>Воронки</span>
        <Separator orientation="vertical" />
        <span>Диалоги</span>
        <Separator orientation="vertical" />
        <span>Обмен</span>
      </div>
    </div>
  );
}

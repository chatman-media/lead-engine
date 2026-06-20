import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lead-engine/admin-ui";

export function LeadActions() {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Действия</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Заявка #4821</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Открыть диалог</DropdownMenuItem>
        <DropdownMenuItem>Передать оператору</DropdownMenuItem>
        <DropdownMenuItem>Пересчитать курс</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Отменить заявку</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { Avatar, AvatarFallback, AvatarImage } from "@lead-engine/admin-ui";

export function Fallbacks() {
  return (
    <div className="flex items-center gap-3 p-6">
      <Avatar>
        <AvatarFallback>АК</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="bg-primary/15 text-primary">МО</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="bg-secondary text-secondary-foreground">ИП</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarImage src="https://i.pravatar.cc/64?img=12" alt="Оператор" />
        <AvatarFallback>ОП</AvatarFallback>
      </Avatar>
    </div>
  );
}

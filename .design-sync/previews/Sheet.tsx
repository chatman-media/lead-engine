import {
  Button,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@lead-engine/admin-ui";

export function EditRequest() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Реквизиты</Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col gap-4 p-6">
        <SheetTitle>Реквизиты выдачи</SheetTitle>
        <div className="flex flex-col gap-2">
          <Label htmlFor="bank">Банк / способ</Label>
          <Input id="bank" defaultValue="Kasikorn Bank" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="acc">Номер счёта</Label>
          <Input id="acc" defaultValue="xxx-x-x4821-x" />
        </div>
        <Button className="mt-2">Сохранить и отправить</Button>
      </SheetContent>
    </Sheet>
  );
}

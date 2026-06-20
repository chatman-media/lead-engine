import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@lead-engine/admin-ui";

export function ConfirmPayout() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button>Выдать код</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Подтвердить выдачу кода</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Заявка #4821 · USDT → THB · 1 200 USDT. Оплата получена. После выдачи кода заявка перейдёт
          в стадию «Завершено».
        </p>
        <DialogFooter>
          <Button variant="outline">Отмена</Button>
          <Button>Выдать код</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

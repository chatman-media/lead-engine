import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@lead-engine/admin-ui";

export function LeadCard() {
  return (
    <div className="p-6">
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Заявка на обмен #4821</CardTitle>
          <CardDescription>USDT → THB · 1 200 USDT</CardDescription>
          <CardAction>
            <Badge variant="warning">Ждёт оплату</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Клиент подтвердил курс 36.4 ₿. Реквизиты отправлены, ожидаем поступление средств на
          кошелёк оператора.
        </CardContent>
        <CardFooter className="gap-2">
          <Button size="sm">Подтвердить оплату</Button>
          <Button size="sm" variant="outline">
            В диалог
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function StatCard() {
  return (
    <div className="p-6">
      <Card className="max-w-xs">
        <CardHeader>
          <CardDescription>Конверсия воронки</CardDescription>
          <CardTitle className="text-3xl">68.4%</CardTitle>
          <CardAction>
            <Badge variant="success">+4.2%</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          за последние 7 дней · 312 новых лидов
        </CardContent>
      </Card>
    </div>
  );
}

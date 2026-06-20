import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lead-engine/admin-ui";

export function LeadTabs() {
  return (
    <div className="p-6">
      <Tabs defaultValue="dialog" className="w-80">
        <TabsList>
          <TabsTrigger value="dialog">Диалог</TabsTrigger>
          <TabsTrigger value="request">Заявка</TabsTrigger>
          <TabsTrigger value="history">История</TabsTrigger>
        </TabsList>
        <TabsContent value="dialog" className="pt-3 text-sm text-muted-foreground">
          Переписка с клиентом и быстрые ответы оператора.
        </TabsContent>
        <TabsContent value="request" className="pt-3 text-sm text-muted-foreground">
          Сумма, направление обмена, курс и реквизиты.
        </TabsContent>
        <TabsContent value="history" className="pt-3 text-sm text-muted-foreground">
          Лог изменений стадии и действий оператора.
        </TabsContent>
      </Tabs>
    </div>
  );
}

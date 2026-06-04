import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SaasWebhooks } from "./SaasWebhooks.tsx";
import { ToolsSettings } from "./ToolsSettings.tsx";

/**
 * «Интеграции» — объединяет инструменты бота и исходящие вебхуки в один раздел
 * с вкладками. Сами страницы переиспользуются в embedded-режиме (без своих
 * заголовков и внешних отступов).
 */
export function SaasIntegrations() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Интеграции"
        description="Инструменты бота и исходящие вебхуки в CRM / n8n / Zapier"
      />
      <Tabs defaultValue="tools">
        <TabsList>
          <TabsTrigger value="tools">Инструменты</TabsTrigger>
          <TabsTrigger value="webhooks">Вебхуки</TabsTrigger>
        </TabsList>
        <TabsContent value="tools" className="mt-4">
          <ToolsSettings embedded />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <SaasWebhooks embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}

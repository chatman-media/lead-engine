# Service catalog and provider marketplace

_Обновлено: 2026-06-09._

Этот документ описывает слой каталога услуг: как tenant показывает клиенту набор
услуг, как marketplace-провайдеры устанавливаются в каталог, и как заявка
маршрутизируется в собственную воронку, партнёра, webhook или оператора.

Высокоуровнево:

```text
service catalog item
  -> routeType=funnel          -> Lead Engine workflow
  -> routeType=partner_service -> partner handoff + commission ledger
  -> routeType=webhook         -> external provider/system
  -> routeType=manual          -> operator handles manually
```

## UI

Основная страница — `/catalog`
(`apps/admin-ui/src/pages/SaasServiceCatalog.tsx`).

На странице есть три блока:

| Блок | Что делает |
|---|---|
| Marketplace провайдеров | Показывает curated providers, фильтр по категории, кнопку "Добавить в каталог" |
| Свой провайдер | Создаёт custom provider + partner service + catalog item за один flow |
| Добавить услугу | Создаёт обычный catalog item: собственная воронка, партнёр, webhook или manual |

Связанные страницы:

| Страница | Назначение |
|---|---|
| `/partners` | Управление партнёрами, услугами партнёров и сделками |
| `/leads/:id` | Операторский handoff: send offer, фото/QR, движение `awaiting_operator` стадии |
| `/funnel` | Воронки, которые catalog item может использовать при `routeType='funnel'` |

## Curated marketplace

Source of truth: `apps/api/src/lib/provider-marketplace.ts`.

Curated providers сейчас:

| Key | Category | Handoff |
|---|---|---|
| `phuket_transfer_network` | Трансфер | `await_callback` |
| `island_cleaning_crew` | Уборка | `await_callback` |
| `spa_mobile_masters` | Массаж | `await_callback` |
| `beauty_desk_phuket` | Салон красоты | `await_callback` |
| `staykey_housing` | Бронь жилья | `await_callback` |
| `rate_desk_exchange` | Exchange | `fire_and_forget` |

Каждый provider описывает:

- `category`, `name`, `description`;
- `coverage`, `sla`, `pricingMode`;
- `commissionPct` / `commissionHint`;
- `requiredFields`;
- `defaultServiceName`, `serviceSlug`;
- `handoffMode`.

## API

### Provider marketplace

Route factory: `apps/api/src/routes/admin-provider-marketplace.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/provider-marketplace` | Curated providers + installed refs + custom providers |
| `POST` | `/api/admin/provider-marketplace/:providerKey/install` | Install curated provider |
| `POST` | `/api/admin/provider-marketplace/custom` | Create custom provider and install it |

Curated install is idempotent by provider key. If the provider is already
installed, the endpoint returns the existing installed reference with
`created=false`.

### Service catalog

Route factory: `apps/api/src/routes/admin-service-catalog.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/service-catalog` | List catalog items with joined funnel/partner labels |
| `POST` | `/api/admin/service-catalog/items` | Create catalog item |
| `PATCH` | `/api/admin/service-catalog/items/:id` | Update catalog item |
| `DELETE` | `/api/admin/service-catalog/items/:id` | Delete catalog item |

`routeType` values:

| Route type | Required target | Meaning |
|---|---|---|
| `manual` | none | Operator handles without automation |
| `funnel` | `funnelId` | Route request into an existing Lead Engine process |
| `partner_service` | `partnerServiceId` | Route to partner/provider service |
| `webhook` | `webhookUrl` | Send request to external system |

### Partners and deals

Route factory: `apps/api/src/routes/admin-partners.ts`.

| Method | Path | Description |
|---|---|---|
| `GET` / `POST` | `/api/admin/partners` | List/create partners |
| `PATCH` | `/api/admin/partners/:id` | Update partner |
| `GET/POST` | `/api/admin/partner-services` | Partner service CRUD |
| `GET` / `POST` | `/api/admin/partner-deals` | List/create partner deals |
| `PATCH` | `/api/admin/partner-deals/:id` | Deal status/amount updates |

`partner_deals.handoff_mode` is:

| Mode | Meaning |
|---|---|
| `fire_and_forget` | Platform records/sends handoff, provider callback is not required |
| `await_callback` | Provider/operator is expected to confirm acceptance/result |

## Data model

Main tables:

| Table | Purpose |
|---|---|
| `service_catalog_items` | Tenant-visible service shelf; route type and target |
| `partners` | Providers/partners with contact, commission, settlement currency |
| `partner_services` | Specific service offered by partner; category, commission, optional stage/funnel |
| `partner_deals` | Handoff/deal ledger; status, gross amount, commission, settlement |

Marketplace install writes:

```text
providers marketplace item
  -> partners row
  -> partner_services row
  -> service_catalog_items row
```

Metadata is stored in JSON fields:

- `service_catalog_items.metadata_json` includes `source`,
  `providerKey`, `coverage`, `sla`, `pricingMode`, `commissionPct`,
  `requiredFields`, `handoffMode`, `installedAt`.
- `partners.notes` stores marketplace/custom-provider marker data and provider
  operating notes.
- `partner_services.notes` stores provider name, required fields and handoff
  mode.

All four tables are tenant-scoped and protected by RLS. Production routes wrap
reads/writes in `withTenant(db, tenantId, fn)`.

## Runtime semantics

The catalog is a routing layer, not a separate workflow engine.

For `routeType='funnel'`, Lead Engine uses the configured funnel stages and the
existing field extractor / reply strategy. The service catalog item is the
front-door offer; the funnel remains the execution model.

For `routeType='partner_service'`, the platform creates or references a partner
service and can create `partner_deals` records to track the handoff lifecycle:
`sent`, `accepted`, `rejected`, `completed`, `cancelled`, `disputed`,
`settled`.

For `routeType='webhook'`, the catalog item stores the target URL. This is the
extension point for external provider systems.

For `routeType='manual'`, the catalog item is visible and routable, but the
operator is responsible for execution.

## Audit

Marketplace and catalog routes record audit actions without raw secrets:

```text
provider_marketplace.install
provider_marketplace.custom_create
service_catalog.create
service_catalog.update
service_catalog.delete
partner.create
partner.update
partner_service.create
```

Do not include provider credentials, channel tokens, LLM keys or payment
requisites in audit details.

## Tests

Relevant integration tests:

| File | Coverage |
|---|---|
| `apps/api/src/routes/admin-provider-marketplace.integration.test.ts` | list/install/custom provider, idempotency, tenant isolation |
| `apps/api/src/routes/admin-service-catalog.integration.test.ts` | route type validation, target validation, CRUD |
| `apps/api/src/routes/admin-partners.integration.test.ts` | partners, partner services, deals |

Run targeted tests with:

```bash
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
  bun test apps/api/src/routes/admin-provider-marketplace.integration.test.ts
```

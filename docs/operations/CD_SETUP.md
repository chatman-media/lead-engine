# CD — авто-деплой на сервер

Push в `main` → CI прогоняет тесты → job **`deploy`** заходит по SSH на сервер
и запускает `./deploy.sh` (тот самый, что в [SERVER_RUNBOOK.md](SERVER_RUNBOOK.md)).

Текущие публичные URL:

| Среда | URL | Что проверять |
|---|---|---|
| Прод | `https://exchanges.agency` | лендинг, API/webhooks, `/healthz`, `/widget.js` |
| Прод `www` | `https://www.exchanges.agency` | тот же лендинг |
| Прод-админка | `https://client.exchanges.agency` | admin-ui SPA на корне; `/api` и `/ws` проксируются на prod API |
| Прод `/admin` | `https://exchanges.agency/admin` | 301-редирект на `https://client.exchanges.agency/` |
| Дев | `https://dev.exchanges.agency` | дев-лендинг/API; админка остаётся на `/admin/` |

```
push main ──▶ workspace (tests) ──▶ deploy (ssh → ./deploy.sh) ──▶ health-check
                  │
                  └──▶ release (npm publish, параллельно)
```

Job описан в [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) (`jobs.deploy`).
Деплоится только реальный `push` в `main` и только после зелёных тестов
(`needs: workspace`). Деплои не пересекаются (`concurrency: deploy-production`).

## Дев-окружение (dev.exchanges.agency)

Push в ветку **`dev`** → те же тесты → job **`deploy-dev`** → SSH тем же ключом →
`/opt/lead-engine-dev` (`APP_DIR=/opt/lead-engine-dev ./deploy.sh`). Рабочий цикл:
фичи → `dev` (смотрим на dev.exchanges.agency) → merge `dev` → `main` (прод).

На сервере дев-инстанс — полная копия прода со своими ресурсами:

| Что              | Прод                          | Дев                                   |
| ---------------- | ----------------------------- | ------------------------------------- |
| Каталог          | `/opt/lead-engine`            | `/opt/lead-engine-dev`                |
| Порт API         | 3000                          | 3001                                  |
| База             | `lead_engine`                 | `lead_engine_dev` (тот же Postgres)   |
| systemd          | `lead-engine-api` / `-worker` | `lead-engine-dev-api` / `-dev-worker` |
| nginx            | `exchanges.agency`, `www.exchanges.agency`, `client.exchanges.agency` | `dev.exchanges.agency` |
| admin-ui         | `https://client.exchanges.agency/` (`ADMIN_UI_BASE=/`) | `https://dev.exchanges.agency/admin/` |

На проде `PLATFORM_PUBLIC_URL=https://exchanges.agency`, а `ADMIN_UI_BASE=/`
задан только в `/opt/lead-engine/.env`: это нужно, чтобы сборка admin-ui
работала на корне `client.exchanges.agency`. На деве `ADMIN_UI_BASE` не задаём,
иначе сломается `/admin/`.

Ветку и юниты deploy.sh берёт из `/opt/lead-engine-dev/.deploy.env`:

```
GIT_BRANCH=dev
API_SERVICE=lead-engine-dev-api
WORKER_SERVICE=lead-engine-dev-worker
```

`PLATFORM_PUBLIC_URL=https://dev.exchanges.agency` живёт в `/opt/lead-engine-dev/.env`
(оттуда же health-check). Новых GitHub-секретов не нужно — сервер и SSH-ключ те же.
Каналы (Telegram-боты и т.п.) на деве подключать только отдельные: продовый бот,
подключённый к деву, перетянет вебхук на себя.

---

## Разовая настройка

Всё ниже выполняется **локально** (на твоей машине). Сервер уже настроен
(systemd-юниты `lead-engine-api` / `lead-engine-worker`, `.env` с
`DATABASE_URL` / `PLATFORM_MASTER_KEY` / `PLATFORM_PUBLIC_URL`) — его не трогаем.

### 1. Выделенная SSH-пара для CI

Отдельный ключ (не твой личный), без passphrase — Actions не введёт пароль:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy@lead-engine" \
  -f ~/.ssh/lead-engine-deploy -N ""
```

Получишь `~/.ssh/lead-engine-deploy` (приватный) и `.pub` (публичный).

### 2. Положить публичный ключ на сервер

```bash
ssh-copy-id -i ~/.ssh/lead-engine-deploy.pub root@ip-170-205-30-16.my-advin.com
```

Если `ssh-copy-id` нет — вручную (введёшь root-пароль один раз):

```bash
cat ~/.ssh/lead-engine-deploy.pub | ssh root@ip-170-205-30-16.my-advin.com \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

Проверить, что ключ работает без пароля:

```bash
ssh -i ~/.ssh/lead-engine-deploy root@ip-170-205-30-16.my-advin.com \
  'cd /opt/lead-engine && git rev-parse --short HEAD && echo SSH-OK'
```

### 3. Добавить секреты в GitHub

Через `gh` CLI (приватный ключ уходит из файла напрямую — не светится в истории):

```bash
gh secret set DEPLOY_SSH_HOST --repo chatman-media/lead-engine \
  --body "ip-170-205-30-16.my-advin.com"
gh secret set DEPLOY_SSH_USER --repo chatman-media/lead-engine \
  --body "root"
gh secret set DEPLOY_SSH_KEY  --repo chatman-media/lead-engine \
  < ~/.ssh/lead-engine-deploy
```

Либо через UI: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret            | Значение                                            |
| ----------------- | --------------------------------------------------- |
| `DEPLOY_SSH_HOST` | `ip-170-205-30-16.my-advin.com` (или IP)            |
| `DEPLOY_SSH_USER` | `root`                                              |
| `DEPLOY_SSH_KEY`  | весь приватный ключ `~/.ssh/lead-engine-deploy`     |

> Нестандартный SSH-порт? Добавь секрет `DEPLOY_SSH_PORT` и строку
> `port: ${{ secrets.DEPLOY_SSH_PORT }}` в `with:` job'а `deploy`.

### 4. Проверка

Закоммить и запушь в `main` (или замёрж PR). В **Actions** появится прогон
`CI` с job'ом `Deploy`. Лог покажет шаги `deploy.sh` (pull → install → migrate →
build → restart → health) и зелёный `Деплой завершён 🚀`.

После prod-деплоя внешний smoke:

```bash
curl -fsS https://exchanges.agency/healthz
curl -fsSI https://exchanges.agency/
curl -fsSI https://client.exchanges.agency/
curl -fsSI -L https://exchanges.agency/admin
```

После dev-деплоя:

```bash
curl -fsS https://dev.exchanges.agency/healthz
curl -fsSI https://dev.exchanges.agency/admin/
```

Историю деплоев также видно в **Deployments → production** (GitHub Environment).

---

## Эксплуатация

- **Где смотреть:** вкладка Actions, job `Deploy` внутри прогона `CI`.
- **Откатить:** `git revert` проблемного коммита и push в `main` — задеплоится
  предыдущее состояние. Либо вручную на сервере: `cd /opt/lead-engine &&
  git checkout <good-sha> && ./deploy.sh` (см. рунбук).
- **Ручной перезапуск без деплоя:** на сервере `./deploy.sh --skip-build`
  (только pull + миграции) или `./deploy.sh --no-restart`.

## Если упало

| Симптом                                  | Причина / что проверить                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `Permission denied (publickey)`          | Публичный ключ не в `~/.ssh/authorized_keys` на сервере, либо в секрет попал `.pub`, а не приватный ключ. Перепроверь шаг 1–3. |
| `ssh: handshake failed` / таймаут        | Неверный `DEPLOY_SSH_HOST` или закрыт 22-й порт фаерволом для раннеров GitHub.           |
| `health-check не прошёл`                 | API не поднялся — `journalctl -u lead-engine-api -n 50` на сервере.                      |
| `status=127` / `bun: command not found` в журнале сервиса | У systemd-юнита пустой `PATH` (нет `~/.bun/bin`), а `bun run start` запускает вложенный `bun` через `/usr/bin/bash`. На этом Linux-боксе bun **не** добавляет свой каталог в PATH скрипта (на macOS — добавляет, потому локально не воспроизводится). Лечится drop-in'ом: `sudo mkdir -p /etc/systemd/system/lead-engine-api.service.d && printf '[Service]\nEnvironment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n' \| sudo tee /etc/systemd/system/lead-engine-api.service.d/path.conf` (и то же для `lead-engine-worker`), затем `sudo systemctl daemon-reload && sudo systemctl restart lead-engine-api lead-engine-worker`. |
| `bun не найден в PATH`                   | Уже закрыто: PATH к `~/.bun/bin` прописан и в workflow, и в `deploy.sh`. Если bun лежит не в `~/.bun` — задай `BUN_INSTALL` в `/opt/lead-engine/.deploy.env`. |
| `git pull` просит пароль / Permission    | На сервере нет доступа к origin (приватный репо). Настрой на сервере deploy-key/токен для `git fetch`. |
| Деплой завис на сборке                   | Подними `command_timeout` в job'е `deploy` (сейчас `18m`).                               |

> **Безопасность.** Ключ `lead-engine-deploy` — только для деплоя; если утечёт,
> удали его из `~/.ssh/authorized_keys` на сервере и сгенерируй новый.
> Опциональное усиление: добавить `fingerprint:` сервера в `with:` action'а,
> чтобы CI проверял host key (защита от MITM).

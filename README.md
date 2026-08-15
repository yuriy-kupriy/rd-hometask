# HW-05 — Docker multi-stage + docker-compose

Мінімальний Fastify + `pg` сервіс на TypeScript ([app/src/server.ts](app/src/server.ts))
у multi-stage Docker-образі, піднятий разом із Postgres через `docker-compose`.
`builder`-стадія компілює `tsc`, `runner` отримує лише скомпільований `dist/` і
prod-залежності — TypeScript, `tsx` та `@types/*` у фінальний образ не потрапляють.

## Запуск

```bash
docker compose up -d
```

Це піднімає `api` (порт `3000`) і `db` (Postgres 17, лише всередині мережі compose).
`api` чекає, поки `db` пройде healthcheck (`condition: service_healthy`), перш ніж стартувати.

Перевірка:

```bash
curl -s http://localhost:3000/health   # {"status":"ok"}
curl -s http://localhost:3000/         # діагностика: hostname, uid, версія node, статус БД
curl -s http://localhost:3000/db       # SELECT now(), current_user з Postgres
```

Статус healthcheck контейнера:

```bash
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q api)
```

Зупинка:

```bash
docker compose down          # контейнери й мережа; том pgdata лишається
docker compose down -v       # + видалити том (дані Postgres)
```

## Dev-режим

`docker compose up -d` без прапорців автоматично підхоплює `docker-compose.override.yml`
поруч із `docker-compose.yml`: збирає образ до стадії `builder` (з TypeScript, `tsx` та
іншими dev-залежностями), пробрасує `app/src` (і маніфести) у контейнер bind mount'ом
і запускає `npm run dev` (`tsx watch src/server.ts` — виконує `.ts` напряму, без
окремого кроку `tsc`, з hot-reload при кожній зміні файлу).

Для CI/прод — тільки базовий файл, без override:

```bash
docker compose -f docker-compose.yml up -d
```

### Запуск поза Docker (напряму на хості)

`npm start` і `npm run dev` — не самодостатні: перед ними обов'язково потрібен
`npm install` (немає `node_modules` у чекауті), а `npm start` додатково вимагає
`npm run build` (він запускає скомпільований `dist/server.js`, якого без збірки
не існує). Без цього обидва падають з `MODULE_NOT_FOUND` / `command not found: tsx`.

```bash
cd app
npm install

npm run dev      # tsx watch src/server.ts — напряму з .ts, з hot-reload

# або прод-режим:
npm run build     # tsc → dist/
npm start          # node dist/server.js
```

`DATABASE_URL` не заданий поза Docker, тож `/db` поверне `503`; `/health` і `/`
працюють без бази.

## Тести

[app/test/routes.test.ts](app/test/routes.test.ts) перевіряє `/health`, `/` і `/db`
через `fastify.inject()` (без реального прослуховування порту) — `node:test` +
`node:assert/strict`, запускається `tsx` без окремого кроку компіляції.

```bash
docker build --target builder -t l5-docker-api:builder -f Dockerfile ./app
docker run --rm l5-docker-api:builder npm test
```

Без `DATABASE_URL` `/db` тестується на `503`; тест на `200` з реальними даними
пропускається (і навпаки — якщо `DATABASE_URL` задано):

```bash
docker compose -f docker-compose.yml up -d db
docker run --rm --network rd-hometask_default \
  -e DATABASE_URL="postgres://app:secret@db:5432/app" \
  l5-docker-api:builder npm test
```

## Лінтер/форматер

[Biome](https://biomejs.dev) ([app/biome.json](app/biome.json)) перевіряє й форматує
`src/` і `test/`: правила `recommended`, сортування імпортів, одинарні лапки,
2-пробільний відступ. `devDependency`, у `runner`-образ не потрапляє.

```bash
docker build --target builder -t l5-docker-api:builder -f Dockerfile ./app
docker run --rm l5-docker-api:builder npm run lint        # перевірка
docker run --rm l5-docker-api:builder npm run lint:fix     # автофікс
```

## Структура

| Файл | Призначення |
|---|---|
| `Dockerfile` | multi-stage (`builder` → `runner`), non-root, healthcheck |
| `.dockerignore`, `app/.dockerignore` | виключають `node_modules`, `.git`, `.env` тощо з контексту збірки |
| `docker-compose.yml` | база: `api` + `db`, придатна для CI |
| `docker-compose.override.yml` | dev: bind mount `./app`, hot-reload, порт |
| `app/` | сервіс (Fastify + pg, TypeScript) — `context: ./app` для `Dockerfile` |
| `app/src/app.ts` | Fastify-застосунок (роути) без `listen()` — використовується і сервером, і тестами |
| `app/src/server.ts` | entry point: `buildApp()` + `listen()`; `app/tsconfig.json` — конфіг збірки в `dist/` |
| `app/test/routes.test.ts` | тести ендпоінтів через `fastify.inject()` |
| `app/biome.json` | конфіг Biome (lint + format) |
| `app/Dockerfile.naive`, `app/Dockerfile.naive-slim` | одностадійні образи (з `tsc`-збіркою) лише для порівняння розміру нижче |

## Розмір образу: multi-stage vs «в лоб»

```bash
docker build -f app/Dockerfile.naive       -t l5-docker-api:naive       ./app  # node:22, dev deps лишаються
docker build -f app/Dockerfile.naive-slim  -t l5-docker-api:naive-slim  ./app  # node:22-slim, dev deps лишаються
docker build -f Dockerfile                 -t l5-docker-api:multistage ./app  # node:22-slim, тільки runner (без dev deps)
docker images l5-docker-api
```

Три варіанти ізолюють кожен фактор окремо: різницю дає базовий образ (`node:22`
vs `node:22-slim`) і різницю дає сам multi-stage (прибирання `devDependencies`).

| Образ                      | Базовий образ  | Dev-залежності? | Розмір                        |
|----------------------------|----------------|------------------|--------------------------------|
| `l5-docker-api:naive`      | `node:22`      | так             | 1.28 GB (1 281 630 219 bytes) |
| `l5-docker-api:naive-slim` | `node:22-slim` | так             | 397 MB (397 437 363 bytes)    |
| `l5-docker-api:multistage` | `node:22-slim` | ні (`runner`)   | 258 MB (258 207 524 bytes)    |

- **`naive` → `naive-slim`: −843 MB (−69%)** — сам перехід з `node:22` на `node:22-slim`
  прибирає повний Debian-шар з інструментами збірки, які застосунку не потрібні.
- **`naive-slim` → `multistage`: −133 MB (−35%)** — далі ефект multi-stage: `runner`
  ставить тільки `dist/` (скомпільований JS) через `npm ci --omit=dev`, тож
  `typescript`, `tsx`, `@types/*` і нативний бінарник `@biomejs/biome` у фінальний
  образ узагалі не потрапляють.
- **Разом (`naive` → `multistage`): −1 GB (−80%)**.

## Перевірка персистентності Postgres

Дані лежать в іменованому томі `pgdata`, тож переживають `docker compose down`
(без `-v`). Перевірялося так:

```bash
docker compose up -d

docker compose exec db psql -U app -d app -c \
  "CREATE TABLE demo (id serial primary key, note text); INSERT INTO demo(note) VALUES ('persisted-check');"

docker compose down          # без -v — том не чіпається

docker compose up -d

docker compose exec db psql -U app -d app -c "SELECT * FROM demo;"
# id |      note
# ----+-----------------
#   1 | persisted-check
```

Рядок лишився на місці після перезапуску.

# wikijs-mcp-google-auth

**MCP-шар поверх існуючого Wiki.js 2.5.x**: корпоративний користувач логіниться
через Google Workspace і працює з wiki через LLM (claude.ai, Claude Desktop,
будь-який MCP-клієнт) — **строго в межах своїх прав у Wiki.js**.

Ключовий принцип: **Wiki.js — єдине джерело правди для авторизації.**
MCP-сервер не має власних users/groups/permissions і жодного global API key.
Кожна операція виконується з нативним Wiki.js JWT конкретного користувача,
і рішення «можна/не можна» ухвалює сам Wiki.js (Groups / Permissions / Page
Rules).

```
Google Workspace ──OAuth/OIDC──▶ MCP Server ──signed assertion──▶ Wiki.js
                                     │         auth module «mcpdelegation»
                                     │         → refreshToken() → нативний JWT
                                     │
 MCP клієнт (claude.ai / Desktop) ◀──┴── tools: search / get / list /
                                          create / update / delete / whoami
                                          (усі — через GraphQL з JWT юзера)
```

## Складові

| Директорія | Що це |
|---|---|
| `packages/wikijs-auth-module/` | Custom authentication module для Wiki.js 2.5.x — приймає підписані RS256-assertions від MCP-сервера і віддає нативний Wiki.js JWT ([деталі](packages/wikijs-auth-module/README.md)) |
| `packages/mcp-server/` | Віддалений MCP-сервер (Streamable HTTP): OAuth 2.1 authorization server для MCP-клієнтів поверх Google OIDC + token broker + tools |
| `deploy/docker-compose.dev.yml` | Ізольований тестовий стенд (Wiki.js 2.5.303 + Postgres + сід ACL) — **тільки для розробки/CI** |
| `deploy/docker-compose.prod.yml` | Прод-деплой: лише MCP-сервер, що вказує на ваш існуючий Wiki.js |
| `deploy/seed/seed.mjs` | Ідемпотентний сід тестового стенда |

## Як це працює

1. MCP-клієнт підключається до `https://mcp.company.com/mcp` і проходить
   OAuth 2.1 (Dynamic Client Registration + PKCE). Google не підтримує DCR,
   тому MCP-сервер сам є authorization server-ом для клієнтів, а Google
   використовується лише для автентифікації людини. Google-токени назовні
   не виходять; клієнти отримують opaque-токени MCP-сервера. Після
   Google-логіну користувач бачить **екран згоди**, де названо застосунок і
   його redirect URI, — це захист від confused-deputy (щоб чужий
   зареєстрований клієнт не отримав токен користувача без його відома);
   згода запам'ятовується per-user на кожен клієнт.
2. `id_token` від Google верифікується (підпис, `iss`, `aud`,
   `email_verified`, **`hd` = ваш Workspace-домен**).
3. Token broker MCP-сервера обмінює Google-ідентичність на **нативний
   Wiki.js JWT**: підписує коротку RS256-assertion (TTL 60 с, унікальний
   `jti`) і викликає штатну GraphQL-мутацію `authentication.login` зі
   стратегією `mcpdelegation`. Модуль у Wiki.js верифікує assertion,
   знаходить користувача за email і повертає JWT через стандартний
   `refreshToken()`-флоу. JWT кешується і оновлюється до закінчення строку.
4. Кожен виклик tool іде у Wiki.js GraphQL з `Authorization: Bearer <JWT
   користувача>`. Заборонена сторінка не прочитається, не зміниться і **не
   з'явиться у пошуку чи списках** — це перевірено e2e-тестами (28 тестів,
   матриця allowed/forbidden для двох користувачів з різними групами).

## Tools

| Tool | Опис |
|---|---|
| `whoami` | Ідентичність користувача + його Wiki.js групи і permissions (діагностика доступу) |
| `search_wiki` | Повнотекстовий пошук; результати фільтруються правами користувача |
| `get_page` | Сторінка за id або path (метадані + повний markdown) |
| `list_pages` | Список видимих користувачу сторінок (фільтр за префіксом шляху) |
| `create_page` | Створення сторінки (markdown) |
| `update_page` | Оновлення: read-merge-write, незмінені поля зберігаються |
| `delete_page` | Видалення (destructive, Wiki.js перевіряє `delete:pages`) |

---

# Інтеграція з вашим Wiki.js: покрокова інструкція

Потрібно: Wiki.js **2.5.x** (перевірено на 2.5.303) з доступом до його
файлової системи/Docker-конфігурації; хост для MCP-сервера з публічним
HTTPS; адмін-доступ до Google Cloud Console вашого Workspace.

## Крок 1. Встановіть auth-модуль у Wiki.js

**Docker:** додайте volume у сервіс wiki і перезапустіть контейнер:

```yaml
services:
  wiki:
    image: ghcr.io/requarks/wiki:2.5.303
    volumes:
      - /opt/wikijs-mcp/wikijs-auth-module:/wiki/server/modules/authentication/mcpdelegation:ro
```

(вміст `packages/wikijs-auth-module/` цього репозиторію → у
`/opt/wikijs-mcp/wikijs-auth-module`; назва директорії призначення мусить
бути саме `mcpdelegation`)

**Bare metal:** скопіюйте `packages/wikijs-auth-module/` у
`<wiki>/server/modules/authentication/mcpdelegation/` і перезапустіть Wiki.js.

У лозі Wiki.js після налаштування (крок 3) з'явиться:
`Authentication Strategy MCP Delegation: [ OK ]`.

## Крок 2. Згенеруйте ключі для assertions

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out mcp-assertion-key.pem
openssl pkey -in mcp-assertion-key.pem -pubout -out mcp-assertion-key.pub.pem
```

Приватний ключ (`mcp-assertion-key.pem`) — **тільки** на хості MCP-сервера.
Публічний — у Wiki.js на наступному кроці.

## Крок 3. Налаштуйте стратегію у Wiki.js Admin

Administration → **Auth** → Add Strategy → **MCP Delegation**:

- **Assertion Public Key (PEM)** — вміст `mcp-assertion-key.pub.pem`;
- **Expected Audience / Issuer** — залиште дефолти
  (`urn:wikijs:mcp-delegation` / `urn:wikijs-mcp-google-auth`);
- **User Lookup Provider Priority** — порядок провайдерів для пошуку
  користувача за email. Якщо ваші люди заходять у wiki через Google/OIDC —
  поставте той провайдер першим (приймаються і ключі модулів: `google`,
  `oidc`, `local`);
- (опційно) **Self-registration** + domain whitelist + auto-enroll групи —
  щоб нові користувачі Workspace створювались автоматично при першому
  зверненні через MCP;
- Save.

Ключ інстансу стратегії видно у списку (для MCP-сервера це
`WIKIJS_STRATEGY_KEY`; якщо створювали вручну через UI — Wiki.js згенерує
uuid, скопіюйте його).

> Акаунти з увімкненим TFA через делегацію працювати не будуть — MCP
> поверне зрозумілу помилку.

## Крок 4. Створіть Google OAuth client

Google Cloud Console → APIs & Services → Credentials → **Create credentials
→ OAuth client ID**:

- Application type: **Web application**;
- Authorized redirect URI: `https://mcp.company.com/oauth/google/callback`
  (ваш `PUBLIC_URL` + `/oauth/google/callback`);
- OAuth consent screen: тип **Internal** (тільки ваш Workspace).

Збережіть Client ID і Client Secret.

## Крок 5. Розгорніть MCP-сервер

```bash
cd deploy
cp .env.example .env        # заповніть значення
mkdir -p keys && cp /шлях/до/mcp-assertion-key.pem keys/
chmod 644 keys/mcp-assertion-key.pem   # контейнер біжить як non-root node (uid 1000)
docker compose -f docker-compose.prod.yml up -d
```

> Контейнер працює під non-root користувачем `node` — змонтований файл ключа
> має бути ним читабельним (`chmod 644`); сам приватний ключ лишається під
> захистом прав хостової директорії `keys/`.

Змінні `.env`:

| Змінна | Значення |
|---|---|
| `MCP_IMAGE` | Тегований image (release workflow публікує `ghcr.io/<owner>/wikijs-mcp-server:vX.Y.Z` на git-тег, або зберіть локально: `docker build -f packages/mcp-server/Dockerfile -t wikijs-mcp-server:local .`) |
| `PUBLIC_URL` | Публічний HTTPS URL MCP-сервера |
| `WIKIJS_URL` | URL вашого Wiki.js (бажано внутрішній) |
| `WIKIJS_STRATEGY_KEY` | Ключ інстансу стратегії з кроку 3 (`mcpdelegation`, якщо так назвали) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | З кроку 4 |
| `GOOGLE_ALLOWED_DOMAIN` | Ваш Workspace-домен, напр. `company.com` — акаунти поза ним відсікаються |

Поставте reverse proxy з TLS перед портом 8000. Мінімальний nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.company.com;
  # ssl_certificate ...; ssl_certificate_key ...;
  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Host $host;
    proxy_buffering off;          # streamable HTTP
  }
}
```

Перевірка: `curl https://mcp.company.com/healthz` → `{"ok":true}`;
`curl https://mcp.company.com/.well-known/oauth-authorization-server` →
метадані OAuth.

## Крок 6. Підключіть клієнтів

**claude.ai (Team/Enterprise):** Settings → Connectors → **Add custom
connector** → URL: `https://mcp.company.com/mcp`. При першому використанні
клієнт пройде OAuth: реєстрація клієнта → Google-логін → готово.

**Claude Desktop:** Settings → Connectors → Add custom connector з тим самим
URL (або через `mcp-remote` для старих версій).

**MCP Inspector (діагностика):**
`npx @modelcontextprotocol/inspector` → Transport: Streamable HTTP →
URL `https://mcp.company.com/mcp` → Open Auth → пройдіть флоу.

## Крок 7. Перевірте

У LLM-чаті:

1. «Хто я у wiki?» → tool `whoami` має показати ваш email, групи і
   permissions з Wiki.js.
2. Попросіть знайти/відкрити сторінку, доступну вам → ок.
3. Попросіть сторінку, до якої у вас немає прав → зрозуміла відмова
   («Wiki.js denied this operation…»), і вона ж **відсутня** у результатах
   пошуку/списках.

---

## Локальна розробка

```bash
npm ci
npm run stand:up      # Wiki.js 2.5.303 + Postgres (docker)
npm run stand:seed    # фіналізація + групи/користувачі/сторінки + стратегія + dev-ключі
npm test              # юніт-тести (auth-модуль + OAuth provider)
npm run build && npm run e2e   # 28 e2e: делегація, OAuth, tools — на живому стенді
npm run stand:down
```

Тестовий стенд: `admin@example.com/admin1234!`, `john@example.com`
(Engineering, без доступу до `/management/*`), `kate@example.com`
(Management). CI ганяє юніт + повний e2e на кожен push/PR у `dev`/`main`.

Запуск MCP-сервера проти стенда вручну:

```bash
PUBLIC_URL=http://localhost:8000 \
WIKIJS_URL=http://127.0.0.1:3000 \
MCP_ASSERTION_PRIVATE_KEY_FILE=deploy/keys/mcp-assertion-key.pem \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_ALLOWED_DOMAIN=example.com \
npm run dev -w @wikijs-mcp/server
```

## Безпека: що варто знати

- **Assertion**: RS256, TTL 60 с, unique `jti`, захист від replay; приватний
  ключ лише на MCP-сервері. Компрометація ключа = можливість входу від імені
  будь-якого користувача wiki — тримайте його як root-секрет і ротуйте
  (нова пара + оновити публічний ключ у стратегії).
- **Google-ідентичність**: канонічний ідентифікатор — `iss`+`sub`; email —
  lookup. `hd`-домен верифікується у підписаному id_token, а не з параметрів.
- **Confused-deputy захист**: перед видачею authorization code користувач
  проходить екран згоди per-client (можна вимкнути `requireConsent` лише для
  довіреного first-party-сценарію). Це не дає атакуючому, що зареєстрував
  свій OAuth-клієнт через DCR, тихо отримати токен жертви.
- **Rate limit Wiki.js**: `authentication.login` — 5 викликів/хв з одного
  IP, а всі делегаційні логіни йдуть з IP MCP-сервера. Брокер кешує JWT
  (стандартно 30 хв) і чекає-повторює на ліміті, тож у звичайній роботі це
  непомітно; при масовому onboarding можливі затримки до хвилини.
- **Ревокація**: стандартний OAuth `/revoke` (за токеном); деактивація
  користувача у Wiki.js обриває делегацію при найближчому оновленні JWT
  (≤30 хв); видалення `SESSION_STORE_FILE` + рестарт MCP-сервера скидає всі
  сесії разом.
- **Аудит**: кожен виклик tool логується структуровано (хто, який tool,
  ok/denied) без контенту сторінок.
- **MCP endpoint**: bearer-only, 120 запитів/хв на токен, security headers,
  OAuth-ендпоінти захищені вбудованим rate limiting SDK.

## Обмеження та плани

- RAG/semantic search — **окремий майбутній сервіс**. Точка підключення
  готова: `search_wiki` працює через інтерфейс `SearchBackend`
  (`src/search/` — v1 = нативний пошук Wiki.js; RAG-сервіс отримає Wiki.js
  JWT користувача і збереже ACL-модель). Див. `docs/rag-integration.md`.
- Один інстанс MCP-сервера (FileStore + in-memory replay-кеш). Для HA
  потрібен спільний стор (Redis) — інтерфейс `KVStore` вже виділений.
- Wiki.js 3.x має інший auth-механізм — модуль розрахований на 2.5.x.

## Ліцензія

Apache-2.0

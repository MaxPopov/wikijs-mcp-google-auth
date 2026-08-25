# План реалізації: MCP-шар з Google-авторизацією поверх Wiki.js

> Статус: затверджений скоуп, план перед стартом реалізації.
> Основа: технічний blueprint «Wiki.js 2.5.303 → Google/OIDC → MCP → RAG з native ACL»
> (розділи про RAG/Vectra/pgvector/embeddings — **поза скоупом цього репозиторію**).

## 1. Скоуп

**Що робимо тут:**

- Віддалений (remote, multi-user) MCP-сервер зі Streamable HTTP транспортом,
  до якого користувачі підключаються з claude.ai / Claude Desktop / інших MCP-клієнтів.
- Авторизація користувача через корпоративний Google Workspace (OAuth/OIDC).
- Обмін Google identity на **нативний Wiki.js JWT** через custom authentication
  module у Wiki.js (флоу з `WIKI.models.users.refreshToken()`, за прецедентом
  Wiki.js Discussion #4665).
- MCP tools для роботи з Wiki.js: пошук, читання, створення, редагування,
  видалення сторінок — усе через Wiki.js GraphQL API **від імені користувача**.
- Авторизація рішень «можна/не можна» повністю на боці Wiki.js
  (Groups / Permissions / Page Rules). MCP не дублює ACL.

**Що НЕ робимо тут:**

- RAG / semantic search / embeddings / vector DB — це окремий майбутній
  сервер-сервіс. Тут лише закладаємо точку підключення (див. §6.4).
- Жодних global API keys Wiki.js, жодної власної системи users/groups/permissions
  у MCP (явні заборони з blueprint, §18).

**Ключовий принцип:** Wiki.js — єдиний source of truth для authorization.
Google відповідає за identity, MCP — за протокол і оркестрацію.

## 2. Цільова архітектура

```
        MCP client (claude.ai / Claude Desktop / інші)
                          │
              MCP Streamable HTTP + OAuth 2.1
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │            MCP Server               │
        │                                     │
        │  ┌───────────────────────────────┐  │
        │  │ OAuth wrapper (AS для клієнтів│  │◄──── Google OAuth/OIDC
        │  │ + relying party до Google)    │  │      (id_token: iss, sub,
        │  └───────────────────────────────┘  │       email, hd)
        │  ┌───────────────────────────────┐  │
        │  │ Wiki.js Token Broker          │  │
        │  │ (assertion → Wiki.js JWT,     │  │
        │  │  кеш + оновлення)             │  │
        │  └───────────────────────────────┘  │
        │  ┌───────────────────────────────┐  │
        │  │ MCP tools (search / get /     │  │
        │  │ create / update / delete)     │  │
        │  └───────────────────────────────┘  │
        └──────────────────┬──────────────────┘
                           │
          1) POST GraphQL authentication.login
             (strategy = mcp-delegation, signed assertion)
          2) GraphQL queries/mutations
             Authorization: Bearer <native Wiki.js JWT>
                           │
                           ▼
        ┌─────────────────────────────────────┐
        │              Wiki.js 2.5.303        │
        │                                     │
        │  Custom auth module «mcp-delegation»│
        │   verify assertion → user lookup →  │
        │   refreshToken() → native JWT       │
        │                                     │
        │  GraphQL API + Groups / Permissions │
        │  / Page Rules → allow / 403         │
        └─────────────────────────────────────┘
```

Кожен запит до Wiki.js виконується з JWT конкретного користувача, тому Wiki.js
бачить саме John, а не «MCP», і застосовує його Page Rules самостійно.

## 3. Ключові технічні рішення

### 3.1 Транспорт і стек

- **TypeScript + `@modelcontextprotocol/sdk`**, транспорт **Streamable HTTP**.
  Stdio не робимо навіть як проміжний етап — цільовий сценарій корпоративний
  multi-user, а SDK дозволяє тримати tools незалежними від транспорту.
- Node.js обрано ще й тому, що Wiki.js — Node: auth-модуль і сервер живуть
  в одній екосистемі, спільні типи/утиліти в монорепо.

### 3.2 OAuth для MCP-клієнтів (найскладніша частина)

MCP Authorization spec вимагає від remote-сервера поводитись як OAuth 2.1
resource server, а клієнти (зокрема claude.ai) очікують **Dynamic Client
Registration**. Google DCR не підтримує, тому MCP-сервер реалізує
**OAuth wrapper**: для клієнтів він — authorization server, для Google — один
зареєстрований OAuth-клієнт.

Ендпоінти MCP-сервера:

- `/.well-known/oauth-protected-resource` і `/.well-known/oauth-authorization-server` — metadata;
- `/register` — DCR для MCP-клієнтів (зберігаємо їхні redirect_uri у себе);
- `/authorize` — приймає запит клієнта (з PKCE), редіректить на Google
  з **нашим** redirect_uri;
- `/callback` — приймає code від Google, обмінює на id_token, валідує
  (`iss`, `aud`, підпис, `hd` = корпоративний домен), створює сесію,
  редіректить назад на redirect_uri клієнта з нашим кодом;
- `/token` — видає **власні** access/refresh токени MCP-сервера (opaque,
  прив'язані до сесії).

Google-токени назовні не віддаємо; канонічна identity — `iss + sub`,
email — додатковий lookup (як у blueprint §3).

У Phase 2 оцінюємо готові хелпери SDK (`mcpAuthRouter`,
`ProxyOAuthServerProvider`) проти власної реалізації wrapper-а; рішення
фіксуємо ADR-кою. Сесії/клієнти — спочатку SQLite (один інстанс), інтерфейс
стора виділяємо одразу, щоб пізніше замінити на Redis/Postgres.

### 3.3 Делегація: Google identity → нативний Wiki.js JWT

Механізм — custom authentication module для Wiki.js 2.5
(`server/modules/authentication/mcp-delegation/`), встановлюється
volume-mount-ом у Docker без форку core (доступ до інстансу є).

Ключова знахідка, на якій будуємо: у Wiki.js стратегії з `useForm: true`
логіняться через GraphQL mutation `authentication.login(strategy, username,
password)`, і відповідь **повертає JWT у JSON** (без cookie/redirect). Це дає
чистий server-to-server канал:

1. MCP-сервер формує короткоживучу **signed assertion** (JWT RS256, підпис
   приватним ключем MCP): `{ iss: "mcp-server", aud: "wikijs-mcp-delegation",
   sub: <google sub>, email, iat, exp: +60s, jti }`.
2. Викликає `authentication.login(strategy: "mcp-delegation",
   username: <email>, password: <assertion>)`.
3. Модуль (passport custom strategy): перевіряє підпис публічним ключем
   (ключ — у конфігу стратегії в admin UI, через props у `definition.yml`),
   перевіряє `exp`/`aud`, захист від replay по `jti`;
4. знаходить Wiki.js user за email (пріоритет провайдерів — конфігурований,
   див. відкрите питання §8.1); опційно auto-provision через штатні
   per-strategy налаштування Wiki.js (selfRegistration, domainWhitelist,
   autoEnrollGroups);
5. повертає user → штатний auth flow Wiki.js викликає
   `WIKI.models.users.refreshToken(user)` → **нативний Wiki.js JWT** (RS256,
   ключі Wiki.js) з user.id, email, permissions, groups.

Тобто ми не реалізуємо Wiki.js JWT самі — рівно як у прецеденті #4665.

### 3.4 Token Broker

Компонент MCP-сервера, що тримає відповідність
`MCP-сесія → Wiki.js JWT`:

- кеш JWT per-user у пам'яті;
- за ~2 хв до закінчення строку дії (дефолт Wiki.js — 30 хв) або на 401/expired —
  повторний виклик делегаційного логіну (він ідемпотентний і дешевий);
- при кожному виклику tool бере актуальний JWT і ставить
  `Authorization: Bearer <jwt>` на GraphQL-запит.

### 3.5 MCP tools (Phase 3)

| Tool | Wiki.js GraphQL | Примітка |
|---|---|---|
| `search_wiki(query)` | `pages.search` | нативний пошук Wiki.js; резолвер фільтрує результати за правами користувача — перевіряємо це явно в Phase 1 |
| `get_page(id \| path)` | `pages.single` / `pages.singleByPath` | повертає контент + метадані |
| `list_pages(...)` | `pages.list` | пагінація, фільтр по path/tags |
| `create_page(...)` | `pages.create` | |
| `update_page(...)` | `pages.update` | |
| `delete_page(id)` | `pages.delete` | |

Правила для всіх tools:

- жодних перевірок прав на боці MCP — операція виконується, Wiki.js вирішує;
- помилки авторизації Wiki.js (GraphQL `responseResult.succeeded=false`,
  коди типу `PageDeleteForbidden` тощо) мапляться в зрозумілі tool-помилки
  («у вас немає прав на редагування цієї сторінки»), без витоку внутрішніх
  деталей;
- `search_wiki` викликає інтерфейс `SearchBackend` (див. §6.4) — v1
  реалізація `WikijsNativeSearch`.

## 4. Структура репозиторію

```
wikijs-mcp-google-auth/
├── packages/
│   ├── mcp-server/                  # TS: MCP + OAuth wrapper + token broker + tools
│   │   ├── src/
│   │   │   ├── oauth/               # AS-ендпоінти, Google RP, стори клієнтів/сесій
│   │   │   ├── wikijs/              # GraphQL-клієнт, token broker, assertion signer
│   │   │   ├── tools/               # MCP tools
│   │   │   └── search/              # SearchBackend interface + native impl
│   │   └── test/
│   └── wikijs-auth-module/          # Wiki.js custom auth module
│       ├── definition.yml
│       ├── authentication.js
│       └── README.md                # встановлення (volume mount, admin UI)
├── deploy/
│   ├── docker-compose.dev.yml       # ІЗОЛЬОВАНИЙ тестовий стенд: Wiki.js 2.5.303
│   │                                #   + Postgres + MCP server (build із сорсів) + сід.
│   │                                #   Тільки для розробки і e2e/CI, бойової wiki не торкається.
│   ├── docker-compose.prod.yml      # Прод: ЛИШЕ контейнер MCP-сервера (тегований image),
│   │                                #   через env вказує на існуючий бойовий Wiki.js.
│   │                                #   Wiki.js у прод НЕ деплоїмо — він уже існує;
│   │                                #   auth-модуль ставиться на нього окремо (README модуля).
│   └── seed/                        # тестові users/groups/page rules (тільки для dev-стенду)
├── docs/
│   ├── adr/                         # архітектурні рішення
│   └── rag-integration.md           # контракт для майбутнього RAG-сервісу
└── IMPLEMENTATION_PLAN.md
```

## 5. Фази реалізації

### Phase 0 — Скеле і dev-середовище

- Монорепо (npm workspaces), TypeScript, лінт/тести, CI (build + tests).
- Гілки `dev` і `main` за схемою з §7.1.
- `docker-compose.dev.yml` — **ізольований тестовий стенд** (не має жодного
  стосунку до бойового Wiki.js): Wiki.js 2.5.303 + Postgres + скрипт-сід:
  два користувачі (John/Engineering, Kate/Management), групи, Page Rules,
  приватний розділ (`/management/*` недоступний Engineering). Призначення —
  дев-цикл і e2e: ACL-сценарії (forbidden read/update, delete,
  auto-provisioning) на бойовій wiki ганяти не можна.
- `docker-compose.prod.yml` — скелет прод-деплою: лише MCP-сервер,
  конфігурація через env (URL бойового Wiki.js, ключі, Google client);
  фіналізується у Phase 4.

**Готово, коли:** одна команда піднімає відтворюваний dev-стенд з тестовими ACL.

### Phase 1 — Делегація і нативний JWT (ядро всієї схеми)

- Реалізувати `wikijs-auth-module` (§3.3) + встановлення в dev-Wiki.js.
- Реалізувати в `mcp-server` лише assertion signer + делегаційний логін +
  GraphQL-клієнт (без MCP і без Google — CLI-скриптом).
- Перевірити матрицю з blueprint §19 нативними Wiki.js правами:

```
GET    /engineering/page  (John) → allowed
GET    /management/salary (John) → forbidden
UPDATE /engineering/page  (John) → allowed
UPDATE /management/salary (John) → forbidden
SEARCH "salary"           (John) → приватна сторінка ВІДСУТНЯ у результатах
SEARCH "salary"           (Kate) → сторінка присутня
```

- Перевірка replay-захисту і протермінованої assertion.

**Готово, коли:** матриця проходить повністю; окремо підтверджено, що
нативний `pages.search` фільтрує результати за правами (це передумова для
`search_wiki`; якщо ні — див. ризик §8.2).

### Phase 2 — MCP-сервер з Google OAuth

- Streamable HTTP MCP-сервер, OAuth wrapper (§3.2), сесійний стор.
- Інтеграція з Token Broker: після логіну сесія вміє отримувати Wiki.js JWT.
- Ручна перевірка: підключення з MCP Inspector та з Claude (custom connector),
  повний флоу Google-логіну, виклик тестового tool `whoami`
  (повертає Wiki.js user/groups з JWT — корисний і як діагностика).

**Готово, коли:** два різні користувачі одночасно підключені до одного
сервера і `whoami` кожному повертає його власні Wiki.js групи.

### Phase 3 — Tools

- Реалізувати tools з §3.5 + мапінг помилок + акуратні описи tools
  (щоб LLM правильно ними користувався: формат path, локалі, markdown editor).
- E2E-тести проти dev-середовища: матриця Phase 1, але вже через MCP tools
  від двох користувачів.

**Готово, коли:** e2e зелені; forbidden-кейси повертають зрозумілу помилку,
а не стек-трейс.

### Phase 4 — Hardening і деплой

- Ревокація: MCP logout → інвалідація сесії і кешованого JWT; обробка
  деактивації користувача у Wiki.js (JWT перестає оновлюватись).
- Аудит-лог: хто, який tool, яка сторінка, результат (без контенту).
- Rate limiting на OAuth-ендпоінти і tools; secure headers; secrets через env.
- Production deploy: фіналізований `docker-compose.prod.yml` (тегований
  image MCP-сервера з релізу `main`, див. §7.1), reverse proxy + HTTPS,
  інструкція встановлення auth-модуля на бойовий Wiki.js.
- `security-review` прогін по всьому коду перед релізом.

**Готово, коли:** сервер працює на публічному HTTPS, реальні користувачі
Workspace підключаються з claude.ai.

## 6. Безпека (звід)

1. **Assertion:** RS256, TTL 60 с, `aud`-перевірка, `jti` анти-replay,
   приватний ключ лише в MCP-сервері.
2. **Google id_token:** перевірка підпису, `iss`, `aud`, **`hd` (домен
   Workspace)** — чужі Google-акаунти відсікаються ще до делегації.
3. **Мережа:** делегаційний ендпоінт Wiki.js бажано доступний лише
   з внутрішньої мережі MCP-сервера.
4. **Токени клієнтам:** лише власні opaque-токени MCP; Google- і Wiki.js-токени
   ніколи не покидають сервер.
5. **Заборони blueprint §18 дотримані:** немає global API key, немає ACL у MCP.

### 6.4 Точка підключення майбутнього RAG

`search_wiki` працює через інтерфейс:

```ts
interface SearchBackend {
  search(query: string, ctx: { wikijsJwt: string }): Promise<SearchResult[]>
}
```

- v1: `WikijsNativeSearch` (GraphQL `pages.search`).
- майбутнє: `RagServiceSearch` — HTTP-виклик до окремого RAG-сервісу
  з **прокинутим Wiki.js JWT користувача**, щоб RAG-сервіс міг робити
  ACL-aware фільтрацію, лишаючи Wiki.js source of truth. Контракт
  зафіксуємо в `docs/rag-integration.md` під час Phase 3.

## 7. Порядок і залежності

Phase 1 — критичний шлях і головний ризик усієї схеми, тому він іде перед
OAuth-частиною: якщо делегація через auth-модуль з якоїсь причини не запрацює,
переглядати треба архітектуру, а не tools. Phase 2 і Phase 3 після цього
майже незалежні (tools можна розробляти проти JWT з Phase 1 CLI).

### 7.1 Git workflow і релізи

- **`dev`** — інтеграційна гілка. Робота ведеться у feature-гілках і
  зливається у `dev` через PR; CI (build + tests + e2e на dev-стенді)
  має бути зеленим перед мержем.
- **`main`** — тільки стабільні релізи. Реліз = мерж `dev` → `main` +
  semver-тег `vX.Y.Z`; тег запускає збірку Docker image MCP-сервера
  з відповідним тегом — саме цей image використовує
  `docker-compose.prod.yml`. У прод ніколи не деплоїмо «latest з dev»,
  лише тегований image з `main`.
- Версіонування semver: major — зміна контракту (tools, делегаційний
  протокол, формат assertion), minor — нова функціональність,
  patch — фікси.

## 8. Ризики та відкриті питання

1. **Матчінг користувача за email.** У Wiki.js email не є глобально унікальним
   між провайдерами (local vs google vs oidc). Рішення: у конфігу модуля —
   впорядкований список провайдерів для lookup; поведінку при кількох
   збігах (відмова vs пріоритет) зафіксуємо в Phase 1. Якщо у вашому
   інстансі всі користувачі під одним провайдером — тривіально.
2. **Фільтрація нативного пошуку за правами.** Приймаємо як гіпотезу, явно
   верифікуємо в Phase 1. Якщо обраний search engine Wiki.js не фільтрує
   результати за Page Rules — у v1 додаємо post-filter: для кожного результату
   пошуку перевірка доступності сторінки під JWT користувача (повільніше,
   але коректно).
3. **Оновлення груп.** Wiki.js JWT містить знімок permissions/groups на момент
   видачі; зміни прав підхоплюються при наступному оновленні токена (≤30 хв).
   Для форс-інвалідації — очистка кешу брокера.
4. **Сумісність claude.ai custom connectors.** Вимоги до remote MCP
   (HTTPS, DCR, PKCE) закриваються wrapper-ом §3.2, але перевіряємо саме
   з claude.ai на початку Phase 2, до добудови решти.
5. **Апгрейди Wiki.js.** Модуль використовує внутрішній контракт auth flow
   2.5.x (`useForm` + login mutation + `refreshToken()`). Пінимо версію
   2.5.303 у деплої; апгрейд Wiki.js = регресійний прогін матриці Phase 1.

## 9. Референси

- Wiki.js Discussion #4665 — server-to-server auth з `refreshToken()`
  (головний прецедент).
- Wiki.js Issue #2690 — custom JWT authentication module (passport-jwt).
- Wiki.js: `server/modules/authentication/*` (oidc, local — шаблони модуля),
  `server/core/auth.js`, `server/models/users.js` (`login()`, `refreshToken()`).
- MCP specification — Authorization (OAuth 2.1, PKCE, resource metadata).
- `@modelcontextprotocol/sdk` — Streamable HTTP, `mcpAuthRouter`,
  `ProxyOAuthServerProvider`.

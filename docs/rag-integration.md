# Контракт інтеграції майбутнього RAG-сервісу

RAG (semantic search) буде **окремим сервером-сервісом** — поза цим
репозиторієм. Тут зафіксовано контракт, за яким MCP-шар підключить його,
не змінюючи модель безпеки.

## Принцип

Wiki.js лишається єдиним authority для ACL. RAG-сервіс отримує від
MCP-сервера **нативний Wiki.js JWT кінцевого користувача** і зобов'язаний
виконувати retrieval у межах прав цього користувача (blueprint, §10:
hybrid — pre-filter у vector DB як кеш, Wiki.js як source of truth).

## Точка підключення в MCP-сервері

`search_wiki` викликає інтерфейс `SearchBackend`
(`packages/mcp-server/src/search/backend.ts`):

```ts
interface SearchBackend {
  search (query: string, ctx: { wikijsJwt: string, locale?: string }): Promise<SearchResponse>
}
```

- v1 (зараз): `WikijsNativeSearch` — нативний пошук Wiki.js, ACL-фільтрація
  на боці Wiki.js.
- v2 (RAG): `RagServiceSearch` — HTTP-виклик до RAG-сервісу.

## Пропонований HTTP-контракт RAG-сервісу

```
POST /search
Authorization: Bearer <нативний Wiki.js JWT користувача>
Content-Type: application/json

{ "query": "...", "locale": "en", "topK": 10 }
```

Відповідь:

```json
{
  "totalHits": 3,
  "results": [
    { "ref": "chunk-123", "title": "...", "description": "chunk excerpt ...",
      "path": "engineering/onboarding", "locale": "en", "score": 0.87 }
  ],
  "suggestions": []
}
```

`ref` — непрозорий ідентифікатор бекенда (chunk id тощо). Це **не** `pages.id`:
MCP не віддає його моделі й ніколи не підставляє в `get_page(id:)`. Сторінка
адресується парою `path` + `locale` — саме так само, як для нативного пошуку
Wiki.js, де `id` хіта береться з пошукового індексу, а не з таблиці `pages`
(див. `SearchResultItem` у `src/search/backend.ts`).

Вимоги до RAG-сервісу:

1. **Верифікація JWT**: перевірити підпис публічним ключем Wiki.js
   (RS256, `iss: urn:wiki.js`) і строк дії. Groups/permissions — у payload.
2. **ACL-aware retrieval**: pre-filter кандидатів за group-метаданими у
   vector index (кеш), а перед видачею — авторитетна перевірка через
   Wiki.js (виклик `pages.single` з JWT користувача або перевіркою page
   rules), щоб застарілий кеш не віддав заборонений chunk.
3. Жодних chunk-ів недоступних сторінок у відповіді — навіть у
   excerpt/description.
4. Індексація ведеться окремим службовим акаунтом, але **видача** — тільки
   в контексті JWT користувача.

## Що зробити у цьому репо при підключенні

1. Додати `RagServiceSearch implements SearchBackend` (HTTP-клієнт,
   passthrough JWT, мапінг помилок; fallback на `WikijsNativeSearch` при
   недоступності RAG — за конфігом).
2. Env: `SEARCH_BACKEND=native|rag`, `RAG_SERVICE_URL`.
3. e2e: матриця «john не бачить confidential chunks через RAG» на стенді.

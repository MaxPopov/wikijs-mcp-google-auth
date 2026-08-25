# Wiki.js auth module: MCP Delegation (`mcpdelegation`)

Custom authentication module для Wiki.js **2.5.x**. Приймає підписані
RS256-assertions від MCP-сервера через штатну GraphQL-мутацію
`authentication.login` і повертає **нативний Wiki.js JWT** для делегованого
користувача. Жодного форку Wiki.js core — модуль просто підкладається в
`server/modules/authentication/`.

## Як це працює

```
MCP server                                Wiki.js
----------                                -------
sign RS256 assertion
  {iss, aud, sub, email, jti, exp<=60s}
        │
        ▼
POST /graphql
mutation authentication.login(
  strategy: "mcpdelegation",
  username: <email>,
  password: <assertion>)
        │
        ▼                                 verify signature (public key)
                                          verify iss / aud / exp / maxAge
                                          reject replayed jti
                                          find user by email
                                            across providerPriority
                                          (optional) self-register
                                          refreshToken(user)
        ◀─────────────────────────────────  { jwt: <native Wiki.js JWT> }
```

## Встановлення

### Docker (типовий випадок)

Змонтуйте директорію модуля в контейнер Wiki.js і перезапустіть його:

```yaml
services:
  wiki:
    image: ghcr.io/requarks/wiki:2.5.303
    volumes:
      - ./wikijs-auth-module:/wiki/server/modules/authentication/mcpdelegation:ro
```

Назва директорії призначення **мусить** бути `mcpdelegation` (збігається з
`key` у `definition.yml`).

### Bare metal

Скопіюйте директорію в `<wiki>/server/modules/authentication/mcpdelegation/`
і перезапустіть Wiki.js.

## Налаштування (Admin UI)

1. Згенеруйте RSA-ключі для MCP-сервера (якщо ще нема):

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out mcp-assertion-key.pem
   openssl pkey -in mcp-assertion-key.pem -pubout -out mcp-assertion-key.pub.pem
   ```

2. Administration → Auth → **Add Strategy** → *MCP Delegation*.
3. Заповніть:
   - **Assertion Public Key (PEM)** — вміст `mcp-assertion-key.pub.pem`.
   - **Expected Audience / Expected Issuer** — залиште дефолти або узгодьте
     зі значеннями `MCP_ASSERTION_AUDIENCE` / `MCP_ASSERTION_ISSUER`
     MCP-сервера.
   - **User Lookup Provider Priority** — порядок провайдерів, серед яких
     шукати користувача за email. Приймає і ключі інстансів, і ключі модулів
     (`google`, `oidc`, `local`, `mcpdelegation`). Якщо ваші користувачі
     логіняться у wiki через Google — поставте ваш Google-провайдер першим.
4. (Опційно) **Self-registration** на цій стратегії — щоб користувачі
   Workspace, яких ще нема у wiki, створювались автоматично при першому
   зверненні через MCP (з доменним whitelist-ом і auto-enroll групами).
5. Save. Стратегія підхоплюється без рестарту.

> Ключ інстансу стратегії (він потрібен MCP-серверу як
> `WIKIJS_STRATEGY_KEY`) видно у списку Active Strategies. Якщо стратегію
> реєстрували сід-скриптом цього репозиторію — ключ буде `mcpdelegation`.

## Безпека

- Assertion живе ≤ 60 с, має unique `jti`; повторне використання
  відхиляється (in-memory replay-кеш).
- `maxTokenAge` відсікає навіть непротерміновані assertions, видані давно.
- Модуль відхиляє системні акаунти, забанених і неверифікованих
  користувачів.
- Приватний ключ існує ТІЛЬКИ на MCP-сервері; Wiki.js знає лише публічний.
- Обмежте мережевий доступ до Wiki.js `/graphql` з MCP-сервера внутрішньою
  мережею, якщо можливо.

## Обмеження

- Акаунти з увімкненим TFA не можуть використовуватись через делегацію
  (Wiki.js вимагатиме TFA-крок) — MCP-сервер поверне зрозумілу помилку.
- Replay-кеш локальний для інстансу; для HA-кластера Wiki.js потрібен
  спільний кеш (наразі поза скоупом).
- Wiki.js обмежує `authentication.login` до **5 викликів/хв з одного IP**.
  MCP-сервер кешує JWT і чекає-повторює на rate-limit, але майте це на
  увазі при масових підключеннях (див. README кореня про варіанти).

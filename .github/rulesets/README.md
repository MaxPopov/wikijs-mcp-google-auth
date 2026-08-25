# Rulesets

JSON-файли для імпорту: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**.

| Файл | Що робить |
|---|---|
| `main.json` | merge у `main` тільки через PR з 1 апрувом, merge-коміт, обов'язковий чек `pr-policy`; заборонені видалення та force-push |
| `dev.json` | merge у `dev` тільки через PR з 1 апрувом (squash або merge); заборонені видалення та force-push |
| `tags.json` | теги `v*` не можна видаляти й переміщати (створювати — можна, це робить `release.yml`) |

## Порядок імпорту

1. `dev.json` і `tags.json` — можна одразу.
2. Змерджити цю гілку в `dev`, щоб `.github/workflows/pr-policy.yml` опинився на `dev`.
3. Тільки після цього — `main.json`. Він вимагає статус-чек `pr-policy`; якщо ввімкнути його раніше, `main` заблокується намертво, бо чек ніколи не запуститься.

## Самоапрув

`bypass_actors` порожній — тобто мерджити можна лише PR, які відкрив хтось інший
(GitHub не дозволяє апрувити власний PR). Щоб мерджити ще й свої:
Ruleset → **Bypass list** → `Add bypass` → `Repository admin` → режим **Pull requests only**.
Прямий push у захищені гілки при цьому залишиться заборонений.

# LBK Deploy Translation

GitHub Action для деплою перекладів у [LBK Launcher](https://admin.lbklauncher.com) через
[публічне API](https://admin.lbklauncher.com/api-docs).

```yaml
- uses: Vadko/lbk-deploy-translation@v1
  with:
    api-token: ${{ secrets.LBK_API_TOKEN }}
    game-id:   ${{ vars.LBK_GAME_ID }}
    version:   '1.1'
    archive:   build/archive.zip
    status:    completed
    translation-progress: 100
```

## Налаштування

### 1. Створи API-токен

Зайди в [/settings](https://admin.lbklauncher.com/settings) → розділ **API токени** →
**Створити токен**. Токен формату `lbk_<43-char base64url>` показується один раз.

### 2. Збережи в repo

- **Secret**: `LBK_API_TOKEN` — сам токен (Settings → Secrets and variables → Actions → New secret).
- **Variable**: `LBK_GAME_ID` — UUID гри (Settings → Variables → New variable). Дізнатись:
  ```bash
  curl -s https://admin.lbklauncher.com/api/submit-via-token/games \
    -H "Authorization: Bearer $TOKEN" | jq '.games[] | {id, name}'
  ```

### 3. Workflow

```yaml
name: Deploy translation
on:
  push:
    branches: [main]
    paths: ['localization/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build archive
        run: |
          mkdir -p build
          (cd localization && zip -r ../build/archive.zip .)

      - uses: Vadko/lbk-deploy-translation@v1
        with:
          api-token: ${{ secrets.LBK_API_TOKEN }}
          game-id:   ${{ vars.LBK_GAME_ID }}
          version:   ${{ github.run_number }}.0
          archive:   build/archive.zip
          status:    completed
          translation-progress: 100
```

## Inputs

| Input | Required | Default | Опис |
|---|---|---|---|
| `api-token` | ✓ | — | Bearer token (`lbk_...`), 47 символів |
| `game-id` | ✓ | — | UUID гри |
| `version` | ✓ | — | Версія перекладу (вільний формат) |
| `base-url` |  | `https://admin.lbklauncher.com` | LBK API base URL |
| `archive` | ✓ | — | Шлях до основного `.zip` |
| `voice` |  | — | Озвучка `.zip` |
| `achievements` |  | — | Досягнення `.zip` |
| `epic` / `gog` / `xbox` |  | — | Варіанти для конкретних крамниць |
| `steam-linux` / `steam-mac` |  | — | Варіанти Steam для конкретних ОС |
| `status` |  | — | `completed` / `in-progress` / `tech-improvement` |
| `translation-progress` |  | — | 0–100 |
| `editing-progress` |  | — | 0–100 |

Основний `archive` обов'язковий. Інші kind'и (voice/achievements/для конкретних крамниць) — необов'язкові, додавай як потрібно.

## Outputs

| Output | Опис |
|---|---|
| `game-id` | UUID гри що оновлено (для зв'язки з наступними кроками) |

## Як це працює

Action виконує три кроки публічного API:

1. **`POST /api/submit-via-token/uploads`** — запитує підписаний URL для кожного `kind`
2. **`PUT` на кожен `signedUrl`** — паралельно передає файли по частинах, без буферизації всього архіву в пам'ять (безпечно для архівів до 10 ГБ)
3. **`PUT /api/submit-via-token/games/{gameId}`** — подача метаданих

Помилка на будь-якому кроці → `core.setFailed()` з повним описом від сервера.

## Розробка

```bash
pnpm install
pnpm lint   # tsc --noEmit
pnpm test   # vitest
pnpm build  # ncc → dist/index.js
```

## Ліцензія

MIT

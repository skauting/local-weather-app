Instrukce k spuštění lokální aplikace počasí

1) Nainstalovat závislosti
   npm install

2) Zkopírovat `.env.example` jako `.env` a doplnit:
   - OpenWeather API klíč
   - Supabase URL
   - Supabase publishable key
   - Supabase secret key
   - DeepSeek API klíč
   - ADMIN_EMAILS (čárkou oddělené e-maily, které se po přihlášení stanou adminy)

   Soubor `.env` je v `.gitignore` a nesmí se commitovat.

3) Spustit server
   - lokálně (firemní TLS / systémová CA): `npm run start:local`
   - běžně / na hostingu: `npm start`

4) Otevřít v prohlížeči
   http://localhost:3000

## Doporučený workflow: main vs. worktree

Pro jasné oddělení běhu aplikace používej:

- **main checkout** na portu `3000`
- **worktree** na portu `3001`

Prakticky:

1. V hlavním checkoutu spusť:
   - `npm run start:main`
   - nebo `npm run dev:main`
2. Ve worktree spusť:
   - `npm run start:worktree`
   - nebo `npm run dev:worktree`

Důležité: server vždy servíruje soubory z adresáře, ze kterého ho spustíš. Stejný skript tedy spusť:

- v `.../local-weather-app` pro hlavní verzi
- v `.../copilot-worktrees/local-weather-app/<nazev-worktree>` pro worktree verzi

Pokud testuješ registraci nebo potvrzovací e-maily i na worktree portu `3001`, přidej tuto URL také do Supabase **Redirect URLs**.

### Bash skripty v rootu repozitáře

Pro pohodlné spouštění z rootu repozitáře jsou k dispozici:

- `./run-main.sh` - spustí hlavní checkout na portu `3000` v restartovacím režimu
- `./run-worktree.sh` - spustí worktree na portu `3001` v restartovacím režimu

Pokud existuje více worktrees, `./run-worktree.sh` nabídne výběr. Případně lze zadat část názvu worktree:

- `./run-worktree.sh scaling-winner`

Pokud vybraný worktree nemá vlastní `.env`, `./run-worktree.sh` automaticky načte `.env` z hlavního checkoutu. Vlastní `.env` ve worktree má přednost.
Pokud worktree nemá vlastní `node_modules`, `./run-worktree.sh` automaticky vytvoří symlink na `node_modules` z hlavního checkoutu. Pokud `node_modules` neexistuje ani tam, je potřeba spustit `npm install` v hlavním checkoutu.

## Verzování

Aplikace používá **Semantic Versioning + build metadata**:

- `MAJOR.MINOR.PATCH` je release verze v `package.json`
- server a build skripty k ní přidávají metadata:
  - `+build.<cislo>` pro CI build
  - `+<short-sha>` pro commit-based build
  - `+local` pro lokální běh bez build identifikátoru

Pravidla:

- `PATCH` pro bugfix bez změny chování API
- `MINOR` pro nové funkce bez breaking changes
- `MAJOR` pro breaking changes

Příklady:

- `1.1.0`
- `1.1.0+build.42`
- `1.1.0+e790d4d`
- `1.1.0+local`

## Deploy na Render

Repozitář obsahuje Blueprint [`render.yaml`](render.yaml).

1. Na [Render](https://dashboard.render.com) vytvoř **Blueprint** z tohoto GitHub repa (nebo Web Service podle `render.yaml`).
2. Doplň Environment Variables (hodnoty ze svého `.env`):
   - `OPENWEATHER_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `ADMIN_EMAILS`
   - `APP_ORIGIN` = finální URL služby, např. `https://local-weather-app.onrender.com`
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_MODEL` = `deepseek-v4-pro`
3. V Supabase -> Authentication -> URL Configuration nastav:
   - **Site URL** = Render URL
   - **Redirect URLs** = stejná URL (případně s `/**`)

Poznámky:
- Hesla zpracovává Supabase Auth a nikdy se neukládají do tabulky `profiles`.
- Osobní údaje jsou v `public.profiles`, chráněné Row Level Security.
- Schéma databáze je v `supabase/migrations`.
- Endpoint serveru volá OpenWeather (current weather) a vrací jen potřebná pole pro UI.
- Chat používá DeepSeek jen pro pochopení dotazu a kontextu; samotnou odpověď skládá z živých dat z OpenWeatherMap podle nalezeného města.
- Free plan na Renderu po nečinnosti usíná; první request po spánku může trvat déle.

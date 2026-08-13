Instrukce k spu�ten� lok�ln� aplikace pocas�

1) Nainstalovat z�vislosti
   npm install

2) Zkop�rovat `.env.example` jako `.env` a doplnit:
   - OpenWeather API kl�c
   - Supabase URL
   - Supabase publishable key
   - Supabase secret key
   - DeepSeek API kl�c
   - ADMIN_EMAILS (c�rkou oddelen� e-maily, kter� se po prihl�en� stanou adminy)

   Soubor `.env` je v `.gitignore` a nesm� se commitovat.

3) Spustit server
   - lok�lne (firemn� TLS / syst�mov� CA): `npm run start:local`
   - be�ne / na hostingu: `npm start`

4) Otevr�t v prohl�eci
   http://localhost:3000

## Doporucen� workflow: main vs. worktree

Pro jasn� oddelen� behu aplikace pou��vej:

- **main checkout** na portu `3000`
- **worktree** na portu `3001`

Prakticky:

1. V hlavn�m checkoutu spust:
   - `npm run start:main`
   - nebo `npm run dev:main`
2. Ve worktree spust:
   - `npm run start:worktree`
   - nebo `npm run dev:worktree`

D�le�it�: server v�dy serv�ruje soubory z adres�re, ze kter�ho ho spust�. Stejn� skript tedy spus�:

- v `.../local-weather-app` pro hlavn� verzi
- v `.../copilot-worktrees/local-weather-app/<nazev-worktree>` pro worktree verzi

Pokud testuje� registraci nebo potvrzovac� e-maily i na worktree portu `3001`, pridat tuto URL tak� do Supabase **Redirect URLs**.

### Bash skripty v rootu repozit�re

Pro pohodln� spou�ten� z rootu repozit�re jsou k dispozici:

- `./run-main.sh` - spust� hlavn� checkout na portu `3000` v restartovac�m re�imu
- `./run-worktree.sh` - spust� worktree na portu `3001` v restartovac�m re�imu

Pokud existuje v�ce worktrees, `./run-worktree.sh` nab�dne v�ber. Pr�padne lze zadat cast n�zvu worktree:

- `./run-worktree.sh scaling-winner`

Pokud vybran� worktree nem� vlastn� `.env`, `./run-worktree.sh` automaticky na�te `.env` z hlavn�ho checkoutu. Vlastn� `.env` ve worktree m� prednost.
Pokud worktree nem� vlastn� `node_modules`, `./run-worktree.sh` automaticky vytvo�� symlink na `node_modules` z hlavn�ho checkoutu. Pokud `node_modules` neexistuje ani tam, je pot�eba spustit `npm install` v hlavn�m checkoutu.

## Verzov�n�

Aplikace pou��v� **Semantic Versioning + build metadata**:

- `MAJOR.MINOR.PATCH` je release verze v `package.json`
- server a build skripty k n� prid�vaj� metadata:
  - `+build.<cislo>` pro CI build
  - `+<short-sha>` pro commit-based build
  - `+local` pro lok�ln� b�h bez build identifik�toru

Pravidla:

- `PATCH` pro bugfix bez zmeny chov�n� API
- `MINOR` pro nov� funkce bez breaking changes
- `MAJOR` pro breaking changes

P��klady:

- `1.1.0`
- `1.1.0+build.42`
- `1.1.0+e790d4d`
- `1.1.0+local`

## Deploy na Render

Repozit�r obsahuje Blueprint [`render.yaml`](render.yaml).

1. Na [Render](https://dashboard.render.com) vytvor **Blueprint** z tohoto GitHub repa (nebo Web Service podle `render.yaml`).
2. Dopln Environment Variables (hodnoty ze sv�ho `.env`):
   - `OPENWEATHER_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `ADMIN_EMAILS`
   - `APP_ORIGIN` = fin�ln� URL slu�by, napr. `https://local-weather-app.onrender.com`
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_MODEL` = `deepseek-v4-pro`
3. V Supabase ? Authentication ? URL Configuration nastav:
   - **Site URL** = Render URL
   - **Redirect URLs** = stejn� URL (pr�padne s `/**`)

Pozn�mky:
- Hesla zpracov�v� Supabase Auth a nikdy se neukl�daj� do tabulky `profiles`.
- Osobn� �daje jsou v `public.profiles`, chr�nen� Row Level Security.
- Sch�ma datab�ze je v `supabase/migrations`.
- Endpoint serveru vol� OpenWeather (current weather) a vrac� jen potrebn� pole pro UI.
- Chat pou��v� DeepSeek jen pro pochopen� dotazu a kontextu; samotn� odpov�� skl�d� z �iv�ch dat z OpenWeatherMap podle nalezen�ho m�sta.
- Free plan na Renderu po necinnosti us�n�; prvn� request po sp�nku mu�e trvat d�le.

Instrukce k spuštení lokální aplikace pocasí

1) Nainstalovat závislosti
   npm install

2) Zkopírovat `.env.example` jako `.env` a doplnit:
   - OpenWeather API klíc
   - Supabase URL
   - Supabase publishable key
   - Supabase secret key
   - DeepSeek API klíc
   - ADMIN_EMAILS (cárkou oddelené e-maily, které se po prihlášení stanou adminy)

   Soubor `.env` je v `.gitignore` a nesmí se commitovat.

3) Spustit server
   - lokálne (firemní TLS / systémové CA): `npm run start:local`
   - bežne / na hostingu: `npm start`

4) Otevrít v prohlížeci
   http://localhost:3000

## Deploy na Render

Repozitár obsahuje Blueprint [`render.yaml`](render.yaml).

1. Na [Render](https://dashboard.render.com) vytvor **Blueprint** z tohoto GitHub repa (nebo Web Service podle `render.yaml`).
2. Dopln Environment Variables (hodnoty ze svého `.env`):
   - `OPENWEATHER_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SECRET_KEY`
   - `ADMIN_EMAILS`
   - `APP_ORIGIN` = finální URL služby, napr. `https://local-weather-app.onrender.com`
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_MODEL` = `deepseek-v4-pro`
3. V Supabase ? Authentication ? URL Configuration nastav:
   - **Site URL** = Render URL
   - **Redirect URLs** = stejná URL (prípadne s `/**`)

Poznámky:
- Hesla zpracovává Supabase Auth a nikdy se neukládají do tabulky `profiles`.
- Osobní údaje jsou v `public.profiles`, chránené Row Level Security.
- Schéma databáze je v `supabase/migrations`.
- Endpoint serveru volá OpenWeather (current weather) a vrací jen potrebná pole pro UI.
- Free plan na Renderu po necinnosti usíná; první request po spánku muže trvat déle.

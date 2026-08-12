Instrukce k spuštění lokální aplikace počasí

1) Nainstalovat závislosti
   npm install

2) Zkopírovat `.env.example` jako `.env` a doplnit:
   - OpenWeather API klíč
   - Supabase URL
   - Supabase publishable key
   - Supabase secret key
   - ADMIN_EMAILS (čárkou oddělené e-maily, které se po přihlášení stanou adminy)

   Soubor `.env` je v `.gitignore` a nesmí se commitovat.

3) Spustit server
   - lokálně (firemní TLS / systémové CA): `npm run start:local`
   - běžně / na hostingu: `npm start`

4) Otevřít v prohlížeči
   http://localhost:3000

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
3. V Supabase → Authentication → URL Configuration nastav:
   - **Site URL** = Render URL
   - **Redirect URLs** = stejná URL (případně s `/**`)

Poznámky:
- Hesla zpracovává Supabase Auth a nikdy se neukládají do tabulky `profiles`.
- Osobní údaje jsou v `public.profiles`, chráněné Row Level Security.
- Schéma databáze je v `supabase/migrations`.
- Endpoint serveru volá OpenWeather (current weather) a vrací jen potřebná pole pro UI.
- Free plan na Renderu po nečinnosti usíná; první request po spánku může trvat déle.

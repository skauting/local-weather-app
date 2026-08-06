Instrukce k spuštění lokální aplikace počasí

1) Nainstalovat závislosti
   npm install

2) Zkopírovat `.env.example` jako `.env` a doplnit:
   - OpenWeather API klíč
   - Supabase URL
   - Supabase publishable key
   - Supabase secret key

   Soubor `.env` je v `.gitignore` a nesmí se commitovat.

3) Spustit server
   npm start

4) Otevřít v prohlížeči
   http://localhost:3000

Poznámky:
- Hesla zpracovává Supabase Auth a nikdy se neukládají do tabulky `profiles`.
- Osobní údaje jsou v `public.profiles`, chráněné Row Level Security.
- Schéma databáze je v `supabase/migrations`.
- Endpoint serveru volá OpenWeather (current weather) a vrací jen potřebná pole pro UI.

Instrukce k spuštění lokální aplikace počasí

1) Nainstalovat závislosti
   npm install

2) Nastavit OpenWeather API klíč (Windows PowerShell):
   $env:OPENWEATHER_API_KEY = "<vas-api-klic>"

   (nebo pro cmd.exe: set OPENWEATHER_API_KEY=<vas-api-klic>)

3) Spustit server
   npm start

4) Otevřít v prohlížeči
   http://localhost:3000

Poznámky:
- API klíč je doporučeno uložit jako environment variable, aby nebyl ve zdrojovém kódu.
- Endpoint serveru volá OpenWeather (current weather) a vrací jen potřebná pole pro UI.

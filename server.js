const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;

if (!API_KEY) {
  console.warn('Varování: OPENWEATHER_API_KEY není nastaven. Použijte: set OPENWEATHER_API_KEY=... (cmd) nebo $env:OPENWEATHER_API_KEY = "..." (PowerShell)');
}

app.use(express.static(path.join(__dirname, 'public')));

// Helper to normalize
function norm(s){ return (s||'').toString().trim().toLowerCase(); }

// Geocoding suggestion endpoint with smarter ranking and Prague fallback
app.get('/api/suggest', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const url = 'http://api.openweathermap.org/geo/1.0/direct';
    const resp = await axios.get(url, { params: { q, limit: 12, appid: API_KEY } });
    const items = resp.data || [];

    const qn = norm(q);
    // Build enriched items
    let list = items.map(item => ({
      name: item.name,
      local_names: item.local_names || {},
      state: item.state,
      country: item.country,
      lat: item.lat,
      lon: item.lon,
      population: item.population || 0
    }));

    // Build friendly display name and scoring
    list = list.map(it => {
      // friendly display
      let displayName = it.name;
      try {
        const locals = Object.values(it.local_names || {}).map(v => (v||'').toString());
        const csLocal = it.local_names && (it.local_names.cs || it.local_names['cs']);
        if (it.country === 'CZ') {
          if (locals.some(v => /praha/i.test(v))) displayName = 'Praha';
          else if (csLocal) displayName = csLocal;
          else displayName = it.name;
        } else if (csLocal) {
          displayName = csLocal;
        }
      } catch (e) {
        displayName = it.name;
      }
      it.display = `${displayName}${it.state ? ', ' + it.state : ''}${it.country ? ', ' + it.country : ''}`;

      // scoring
      let score = 0;
      if (norm(it.name) === qn) score += 120;
      const localValues = Object.values(it.local_names || {}).map(v => norm(v));
      if (localValues.includes(qn)) score += 120;
      if (localValues.some(v => v.includes(qn))) score += 60;
      if (it.country === 'CZ') score += 80;
      if (qn === 'praha' && (norm(it.name) === 'prague')) score += 50;
      score += Math.min(it.population || 0, 1000000) / 10000;
      it._score = score;
      return it;
    });

    // sort by score desc
    list.sort((a,b) => (b._score || 0) - (a._score || 0));

    // Deduplicate by rounded lat/lon (merge identical locations) to avoid duplicate names
    const seen = new Map();
    for (const it of list) {
      const key = `${(it.lat||0).toFixed(4)}|${(it.lon||0).toFixed(4)}`;
      if (!seen.has(key)) seen.set(key, it);
    }
    let deduped = Array.from(seen.values());

    // Ensure Prague CZ is first when user typed Praha/Prague
    if ((qn === 'praha' || qn === 'prague')) {
      const hasCZ = deduped.some(i => i.country === 'CZ');
      if (!hasCZ) {
        deduped.unshift({ name: 'Praha', state: '', country: 'CZ', lat: 50.0755381, lon: 14.4378005, display: 'Praha, CZ', population: 1300000, source: 'fallback' });
      } else {
        // move the first CZ item to the top
        const idx = deduped.findIndex(i => i.country === 'CZ');
        if (idx > 0) {
          const [cz] = deduped.splice(idx,1);
          deduped.unshift(cz);
        }
      }
    }

    res.json(deduped.slice(0,8));
  } catch (err) {
    console.error('Suggest error', err.response?.data || err.message || err);
    res.status(500).json([]);
  }
});

// Weather endpoint: accept city or lat+lon. Use free endpoints (current + forecast + air)
app.get('/api/weather', async (req, res) => {
  const city = req.query.city;
  const latQ = req.query.lat;
  const lonQ = req.query.lon;

  if (!city && !(latQ && lonQ)) return res.status(400).json({ error: 'Město nebo souřadnice jsou povinné' });

  try {
    let lat, lon, name, country;

    if (latQ && lonQ) {
      lat = parseFloat(latQ); lon = parseFloat(lonQ);
      // try reverse geocode to get name/country
      try {
        const revUrl = 'http://api.openweathermap.org/geo/1.0/reverse';
        const revResp = await axios.get(revUrl, { params: { lat, lon, limit: 1, appid: API_KEY } });
        const place = revResp.data && revResp.data[0];
        if (place) { name = place.name; country = place.country; }
      } catch (e) { /* ignore reverse errors */ }
      // fallback name from query if provided
      if (!name && city) name = city;
    } else {
      // geocode by city string
      const geoUrl = 'http://api.openweathermap.org/geo/1.0/direct';
      const geoResp = await axios.get(geoUrl, { params: { q: city, limit: 1, appid: API_KEY } });
      const place = geoResp.data && geoResp.data[0];
      if (!place) return res.status(404).json({ error: 'Město nebylo nalezeno' });
      lat = place.lat; lon = place.lon; name = place.name; country = place.country;
    }

    // 2) Current weather
    const curUrl = 'https://api.openweathermap.org/data/2.5/weather';
    const curResp = await axios.get(curUrl, { params: { lat, lon, units: 'metric', appid: API_KEY } });

    // 3) Forecast 5 day / 3 hour
    const fUrl = 'https://api.openweathermap.org/data/2.5/forecast';
    const fResp = await axios.get(fUrl, { params: { lat, lon, units: 'metric', appid: API_KEY } });

    // 4) Air pollution (if available)
    let air = null;
    try {
      const aUrl = 'http://api.openweathermap.org/data/2.5/air_pollution';
      const aResp = await axios.get(aUrl, { params: { lat, lon, appid: API_KEY } });
      air = aResp.data;
    } catch (e) {
      // ignore air pollution errors
    }

    res.json({ location: { name, country, lat, lon }, current: curResp.data, forecast: fResp.data, air });
  } catch (err) {
    console.error('Weather error', err.response?.data || err.message || err);
    const msg = err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));

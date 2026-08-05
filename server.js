const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;
const FREE_LIMIT = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

if (!API_KEY) {
  console.warn('Varování: OPENWEATHER_API_KEY není nastaven. Použijte: set OPENWEATHER_API_KEY=... (cmd) nebo $env:OPENWEATHER_API_KEY = "..." (PowerShell)');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory sessions. A restart clears them; a real deployment needs a store.
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(sid);
  }
}, 60 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getSession(req, res) {
  let sid = parseCookies(req)['wa_sid'];
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, { count: 0, user: null, lastSeen: Date.now() });
    res.setHeader('Set-Cookie', `wa_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
  }
  const session = sessions.get(sid);
  session.lastSeen = Date.now();
  return session;
}

function usagePayload(session) {
  return {
    count: session.count,
    limit: FREE_LIMIT,
    remaining: session.user ? null : Math.max(0, FREE_LIMIT - session.count),
    user: session.user
  };
}

app.get('/api/usage', (req, res) => {
  res.json(usagePayload(getSession(req, res)));
});

app.post('/api/usage/reset', (req, res) => {
  const session = getSession(req, res);
  session.count = 0;
  res.json(usagePayload(session));
});

// Mock auth: no password check, only enough state to lift the free limit.
app.post('/api/auth/login', (req, res) => {
  const session = getSession(req, res);
  const email = (req.body?.email || '').toString().trim() || 'user@example.com';
  const name = (req.body?.name || '').toString().trim() || email.split('@')[0];
  session.user = { name, email, plan: req.body?.plan || null };
  session.count = 0;
  res.json(usagePayload(session));
});

app.post('/api/auth/plan', (req, res) => {
  const session = getSession(req, res);
  if (!session.user) return res.status(401).json({ error: 'Nejste přihlášeni' });
  session.user.plan = (req.body?.plan || 'basic').toString();
  res.json(usagePayload(session));
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req, res);
  session.user = null;
  res.json(usagePayload(session));
});

// Helper to normalize
function norm(s){ return (s||'').toString().trim().toLowerCase(); }

// Geocoding suggestion endpoint with smarter ranking and Prague fallback
app.get('/api/suggest', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const url = 'https://api.openweathermap.org/geo/1.0/direct';
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
      it.shortName = displayName;
      // skip the region when it just repeats the city name ("Praha, Prague, CZ")
      const state = it.state && norm(it.state) !== norm(displayName) && norm(it.state) !== norm(it.name) ? it.state : '';
      it.display = `${displayName}${state ? ', ' + state : ''}${it.country ? ', ' + it.country : ''}`;

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

  const session = getSession(req, res);
  if (!session.user && session.count >= FREE_LIMIT) {
    return res.status(429).json({
      error: `Bez registrace je možné provést pouze ${FREE_LIMIT} dotazů.`,
      code: 'FREE_LIMIT_REACHED',
      usage: usagePayload(session)
    });
  }

  const preferredName = (req.query.name || '').toString().trim();

  try {
    let lat, lon, name, country;

    if (latQ && lonQ) {
      lat = parseFloat(latQ); lon = parseFloat(lonQ);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ error: 'Neplatné souřadnice' });
      }
      // try reverse geocode to get name/country
      try {
        const revUrl = 'https://api.openweathermap.org/geo/1.0/reverse';
        const revResp = await axios.get(revUrl, { params: { lat, lon, limit: 1, appid: API_KEY } });
        const place = revResp.data && revResp.data[0];
        if (place) { name = place.name; country = place.country; }
      } catch (e) { /* ignore reverse errors */ }
      // the label the user picked wins over the reverse-geocoded English name
      if (preferredName) name = preferredName;
      if (!name && city) name = city;
    } else {
      // geocode by city string
      const geoUrl = 'https://api.openweathermap.org/geo/1.0/direct';
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
      const aUrl = 'https://api.openweathermap.org/data/2.5/air_pollution';
      const aResp = await axios.get(aUrl, { params: { lat, lon, appid: API_KEY } });
      air = aResp.data;
    } catch (e) {
      // ignore air pollution errors
    }

    if (!session.user) session.count += 1;

    res.json({
      location: { name, country, lat, lon },
      current: curResp.data,
      forecast: fResp.data,
      air,
      usage: usagePayload(session)
    });
  } catch (err) {
    console.error('Weather error', err.response?.data || err.message || err);
    const msg = err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));

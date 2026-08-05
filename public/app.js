const form = document.getElementById('form');
const cityInput = document.getElementById('city');
const suggestionsEl = document.getElementById('suggestions');
const resultEl = document.getElementById('result');
const errorEl = document.getElementById('error');
const rawEl = document.getElementById('raw');
const toggleRaw = document.getElementById('toggleRaw');

let latestRaw = null;
let suggestions = [];
let selectedIndex = -1;
let selectedLat = null;
let selectedLon = null;

function debounce(fn, wait = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

async function fetchSuggest(q) {
  if (!q) return showSuggestions([]);
  try {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    // dedupe by display (case-insensitive) keeping first (server already scores)
    const map = new Map();
    for (const it of list) {
      const key = (it.display || it.name || '').toString().toLowerCase();
      if (!map.has(key)) map.set(key, it);
    }
    suggestions = Array.from(map.values());
    showSuggestions(suggestions);
  } catch (e) {
    showSuggestions([]);
  }
}

const suggest = debounce((q) => fetchSuggest(q), 200);

function showSuggestions(list) {
  selectedIndex = -1;
  suggestionsEl.innerHTML = '';
  if (!list || list.length === 0) { suggestionsEl.classList.add('hidden'); return; }
  for (let i=0;i<list.length;i++) {
    const it = list[i];
    const li = document.createElement('li');
    li.textContent = it.display || it.name;
    li.tabIndex = 0;
    li.setAttribute('role','option');
    li.dataset.lat = it.lat;
    li.dataset.lon = it.lon;
    li.dataset.index = i;
    li.addEventListener('click', () => chooseSuggestion(i));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseSuggestion(i); });
    suggestionsEl.appendChild(li);
  }
  suggestionsEl.classList.remove('hidden');
}

function chooseSuggestion(i) {
  const it = suggestions[i];
  if (!it) return;
  cityInput.value = it.display || it.name;
  selectedLat = it.lat; selectedLon = it.lon;
  suggestionsEl.classList.add('hidden');
}

cityInput.addEventListener('input', (e) => {
  selectedLat = selectedLon = null; // reset selected coords on free input
  suggest(e.target.value);
});

cityInput.addEventListener('keydown', (e) => {
  const visible = !suggestionsEl.classList.contains('hidden');
  const items = suggestionsEl.querySelectorAll('li');
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault(); selectedIndex = Math.min(selectedIndex+1, items.length-1); updateHighlight(items);
  } else if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault(); selectedIndex = Math.max(selectedIndex-1, 0); updateHighlight(items);
  } else if (e.key === 'Enter') {
    if (visible && selectedIndex >=0 && items[selectedIndex]) {
      e.preventDefault(); chooseSuggestion(selectedIndex);
    }
  } else if (e.key === 'Escape') {
    suggestionsEl.classList.add('hidden');
  }
});

function updateHighlight(items){
  items.forEach((li,idx)=> li.setAttribute('aria-selected', (idx===selectedIndex).toString()));
  if (items[selectedIndex]) items[selectedIndex].scrollIntoView({block:'nearest'});
}

// click outside to close
document.addEventListener('click', (e)=>{
  if (!document.querySelector('.autocomplete').contains(e.target)) {
    suggestionsEl.classList.add('hidden');
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const city = cityInput.value.trim();
  if (!city) return;

  resultEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  rawEl.classList.add('hidden');
  resultEl.innerHTML = '<div class="loading">Načítám…</div>';
  resultEl.classList.remove('hidden');

  try {
    let url;
    if (selectedLat && selectedLon) {
      url = `/api/weather?lat=${encodeURIComponent(selectedLat)}&lon=${encodeURIComponent(selectedLon)}&name=${encodeURIComponent(city)}`;
    } else {
      // try to match one suggestion exactly
      const match = suggestions.find(s => (s.display || s.name).toLowerCase() === city.toLowerCase());
      if (match) url = `/api/weather?lat=${encodeURIComponent(match.lat)}&lon=${encodeURIComponent(match.lon)}&name=${encodeURIComponent(city)}`;
      else url = `/api/weather?city=${encodeURIComponent(city)}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(()=>({ error: 'Chyba serveru' }));
      throw new Error(err.error || 'Chyba při dotazu');
    }
    const resp = await res.json();
    latestRaw = resp;
    render(resp);
  } catch (err) {
    resultEl.classList.add('hidden');
    errorEl.textContent = err.message || 'Neznámá chyba';
    errorEl.classList.remove('hidden');
  }
});

function fmtTime(dt, tzOffset) {
  if (!dt) return '-';
  const d = new Date((dt + (tzOffset || 0)) * 1000);
  return d.toLocaleString();
}

function render(resp) {
  const { location, current, forecast, air } = resp;

  const cur = current || {};
  // timezone offset: prefer current response, fallback to forecast city
  const tzOffset = (cur.timezone != null) ? cur.timezone : ((forecast && forecast.city && forecast.city.timezone) || 0);

  // friendly values
  const tempVal = (cur.main && cur.main.temp != null) ? Math.round(cur.main.temp) + '°C' : (cur.temp != null ? Math.round(cur.temp) + '°C' : '-');
  const feelsVal = (cur.main && cur.main.feels_like != null) ? Math.round(cur.main.feels_like) + '°C' : null;
  const humidityVal = cur.main?.humidity != null ? cur.main.humidity + '%' : '-';
  const windVal = (cur.wind && (cur.wind.speed != null)) ? (cur.wind.speed + ' m/s') : '-';
  const desc = (cur.weather && cur.weather[0] && cur.weather[0].description) || '';
  const icon = (cur.weather && cur.weather[0] && cur.weather[0].icon) || '01d';

  // header
  const headerHtml = `
    <div class="row">
      <div>
        <h2>${location.name}${location.country ? ', ' + location.country : ''}</h2>
        <p class="big">${tempVal}</p>
        <p class="desc">${desc}</p>
        <div class="meta">${feelsVal ? `Cítí se jako ${feelsVal} • ` : ''}Vlhkost ${humidityVal} • Vítr ${windVal}</div>
      </div>
      <div class="icon">
        <img src="https://openweathermap.org/img/wn/${icon}@2x.png" alt="ikonka" />
      </div>
    </div>
  `;

  // details
  const detailsHtml = `
    <div class="details">
      <div>Stav oblačnosti: ${cur.clouds?.all ?? '-'}%</div>
      <div>Tlak: ${cur.main?.pressure ?? '-'} hPa</div>
      <div>Viditelnost: ${cur.visibility != null ? cur.visibility + ' m' : '-'}</div>
      <div>Rosný bod: ${cur.main?.dew_point != null ? Math.round(cur.main.dew_point) + '°C' : '-'}</div>
      <div>Sunrise: ${fmtTime(cur.sys?.sunrise, tzOffset)}</div>
      <div>Sunset: ${fmtTime(cur.sys?.sunset, tzOffset)}</div>
    </div>
  `;

  // hourly
  const tz = tzOffset || 0;
  const hours = (forecast && forecast.list || []).slice(0, 12).map(h => `
    <div class="hour">
      <div class="hour-time">${new Date((h.dt + tz) * 1000).toLocaleString([], {hour: '2-digit', minute:'2-digit', day:'2-digit', month:'2-digit'})}</div>
      <div class="hour-temp">${Math.round(h.main.temp)}°C</div>
      <div class="hour-pop">${Math.round((h.pop || 0) * 100)}%</div>
    </div>
  `).join('');

  // daily
  const dailyMap = {};
  (forecast && forecast.list || []).forEach(item => {
    const date = new Date((item.dt + tz) * 1000).toLocaleDateString();
    if (!dailyMap[date]) dailyMap[date] = { temps: [], pops: [], desc: item.weather?.[0]?.description || '', dt: item.dt };
    dailyMap[date].temps.push(item.main.temp);
    dailyMap[date].pops.push(item.pop || 0);
  });
  const days = Object.keys(dailyMap).slice(0, 7).map(dk => {
    const v = dailyMap[dk];
    const min = Math.min(...v.temps);
    const max = Math.max(...v.temps);
    const pop = Math.round((v.pops.reduce((a,b)=>a+b,0)/v.pops.length)*100);
    return `
      <div class="day">
        <div class="day-date">${dk}</div>
        <div class="day-desc">${v.desc}</div>
        <div class="day-temp">${Math.round(min)}° / ${Math.round(max)}°C</div>
        <div class="day-pop">${pop}%</div>
      </div>
    `;
  }).join('');

  // air
  const airSection = (() => {
    if (!air || !air.list || !air.list.length) return '';
    const a = air.list[0];
    const aqiMap = {1: 'Good', 2: 'Fair', 3: 'Moderate', 4: 'Poor', 5: 'Very Poor'};
    const aqi = a.main?.aqi;
    const comp = a.components || {};
    return `
      <div class="air-box">
        <div><strong>Kvalita ovzduší:</strong> ${aqi ? (aqiMap[aqi] || aqi) + ' (AQI ' + aqi + ')' : '-'}</div>
        <div class="air-items">PM2.5: ${comp.pm2_5 ?? '-'} µg/m³ • PM10: ${comp.pm10 ?? '-'} µg/m³ • O₃: ${comp.o3 ?? '-'} µg/m³ • NO₂: ${comp.no2 ?? '-'} µg/m³ • CO: ${comp.co ?? '-'}</div>
      </div>
    `;
  })();

  resultEl.innerHTML = `
    ${headerHtml}
    ${detailsHtml}
    <h3>Hodinová předpověď (12×3h)</h3>
    <div class="hours">${hours}</div>
    <h3>Denní přehled (z 5d/3h dat)</h3>
    <div class="days">${days}</div>
    ${airSection}
  `;
}

toggleRaw.addEventListener('click', () => {
  if (!latestRaw) return;
  if (rawEl.classList.contains('hidden')) {
    rawEl.textContent = JSON.stringify(latestRaw, null, 2);
    rawEl.classList.remove('hidden');
    toggleRaw.textContent = 'Skrýt surová data';
  } else {
    rawEl.classList.add('hidden');
    toggleRaw.textContent = 'Zobrazit surová data';
  }
});

cityInput.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') { cityInput.value = ''; cityInput.blur(); }
});

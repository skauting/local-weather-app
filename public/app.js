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
let selectedName = null;

// Auth / usage state mirrors the server session; the server stays authoritative.
let freeUsage = 0;
let freeLimit = 5;
let currentUser = null;

function applyUsage(usage) {
  if (!usage) return;
  if (typeof usage.count === 'number') freeUsage = usage.count;
  if (typeof usage.limit === 'number') freeLimit = usage.limit;
  currentUser = usage.user || null;
  updateUsageUI();
  updateMenuUI();
}

async function api(path, options) {
  const requestOptions = options || {};
  const method = (requestOptions.method || 'GET').toUpperCase();
  const headers = new Headers(requestOptions.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('X-Requested-With', 'weather-app');
  }
  const res = await fetch(path, { credentials: 'same-origin', ...requestOptions, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Chyba serveru'), { data, status: res.status });
  return data;
}

async function loadUsage() {
  try { applyUsage(await api('/api/usage')); } catch (e) { /* keep defaults */ }
}

function updateUsageUI(){
  document.getElementById('usageCount').textContent = freeUsage;
  document.getElementById('usageLimit').textContent = freeLimit;
  document.getElementById('usage').classList.toggle('hidden', Boolean(currentUser));
  document.getElementById('resetBtn').classList.toggle('hidden', Boolean(currentUser));

  const creditsBadge = document.getElementById('creditsBadge');
  const creditsCount = document.getElementById('creditsCount');
  if (currentUser) {
    creditsCount.textContent = currentUser.credits ?? 0;
    creditsBadge.classList.remove('hidden');
  } else {
    creditsBadge.classList.add('hidden');
  }
}

function updateMenuUI(){
  const logoutBtn = document.getElementById('logoutBtn');
  const menuBtn = document.getElementById('menuBtn');
  const openLogin = document.getElementById('openLogin');
  const openRegister = document.getElementById('openRegister');
  const adminLink = document.getElementById('adminLink');

  if (currentUser && currentUser.name) {
    menuBtn.textContent = currentUser.name + ' ▾';
    logoutBtn.classList.remove('hidden');
    openLogin.classList.add('hidden');
    openRegister.classList.add('hidden');
    adminLink.classList.toggle('hidden', currentUser.role !== 'admin');
  } else {
    menuBtn.textContent = 'Přihlásit / Registrovat ▾';
    logoutBtn.classList.add('hidden');
    openLogin.classList.remove('hidden');
    openRegister.classList.remove('hidden');
    adminLink.classList.add('hidden');
  }
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function debounce(fn, wait = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

let suggestController = null;

async function fetchSuggest(q) {
  suggestController?.abort();
  if (!q || q.trim().length < 2) return showSuggestions([]);
  const controller = new AbortController();
  suggestController = controller;
  try {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Našeptávání není momentálně dostupné.');
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
    if (e.name !== 'AbortError') showSuggestions([]);
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
  selectedName = it.shortName || it.name;
  suggestionsEl.classList.add('hidden');
}

cityInput.addEventListener('input', (e) => {
  selectedLat = selectedLon = selectedName = null; // reset selection on free input
  suggest(e.target.value);
});

// Hook into auth UI
const menuBtn = document.getElementById('menuBtn');
const menuDrop = document.getElementById('menuDrop');
const openLogin = document.getElementById('openLogin');
const openRegister = document.getElementById('openRegister');
const logoutBtn = document.getElementById('logoutBtn');
const authModal = document.getElementById('authModal');
const closeAuth = document.getElementById('closeAuth');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const authMessage = document.getElementById('authMessage');

menuBtn.addEventListener('click', ()=>{ const expanded = menuBtn.getAttribute('aria-expanded') === 'true'; menuBtn.setAttribute('aria-expanded', String(!expanded)); menuDrop.classList.toggle('hidden'); });
openLogin.addEventListener('click', ()=>{ openAuth('login'); });
openRegister.addEventListener('click', ()=>{ openAuth('register'); });
logoutBtn.addEventListener('click', async ()=>{
  try { applyUsage(await api('/api/auth/logout', { method: 'POST' })); alert('Odhlášeno'); }
  catch (err) { alert(err.message); }
});
closeAuth.addEventListener('click', ()=>{ closeAuthModal(); });

let lastFocusedBeforeModal = null;

function closeAuthModal(){
  authModal.classList.add('hidden');
  loginForm.classList.add('hidden');
  registerForm.classList.add('hidden');
  lastFocusedBeforeModal?.focus();
  lastFocusedBeforeModal = null;
}

function setAuthMessage(message, tone = '') {
  authMessage.textContent = message;
  authMessage.classList.toggle('error-message', tone === 'error');
  authMessage.classList.toggle('success-message', tone === 'success');
}

function openAuth(kind){
  lastFocusedBeforeModal = document.activeElement;
  authModal.classList.remove('hidden');
  menuDrop.classList.add('hidden');
  menuBtn.setAttribute('aria-expanded', 'false');
  loginForm.classList.add('hidden'); registerForm.classList.add('hidden');
  setAuthMessage('Bez registrace můžete provést 5 dotazů. Po registraci získáte 5 kreditů na další hledání.');
  if (kind === 'login'){ loginForm.classList.remove('hidden'); }
  else if (kind === 'register'){ registerForm.classList.remove('hidden'); }
  authModal.querySelector('.auth-form:not(.hidden) input, .auth-form:not(.hidden) select')?.focus();
}

authModal.addEventListener('click', (e)=>{ if (e.target === authModal) closeAuthModal(); });

document.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape' || authModal.classList.contains('hidden')) return;
  closeAuthModal();
});

// Keep keyboard focus inside the dialog while it is open.
authModal.addEventListener('keydown', (e)=>{
  if (e.key !== 'Tab') return;
  const focusable = Array.from(authModal.querySelectorAll('button, input, select')).filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

loginForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const submit = document.getElementById('doLogin');
  submit.disabled = true;
  setAuthMessage('Přihlašuji…');
  try {
    applyUsage(await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }));
    closeAuthModal();
  } catch (err) {
    setAuthMessage(err.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

registerForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const payload = {
    firstName: document.getElementById('regFirstName').value.trim(),
    lastName: document.getElementById('regLastName').value.trim(),
    email: document.getElementById('regEmail').value.trim(),
    phone: document.getElementById('regPhone').value.trim(),
    countryCode: document.getElementById('regCountry').value,
    password: document.getElementById('regPassword').value
  };
  const submit = document.getElementById('doRegister');
  submit.disabled = true;
  setAuthMessage('Vytvářím účet…');
  try {
    const response = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    applyUsage(response);
    registerForm.reset();
    if (response.confirmationRequired) {
      registerForm.classList.add('hidden');
      loginForm.classList.remove('hidden');
      setAuthMessage(response.message, 'success');
      document.getElementById('loginEmail').value = payload.email;
    } else {
      closeAuthModal();
    }
  } catch (err) {
    setAuthMessage(err.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

function populateCountries() {
  const select = document.getElementById('regCountry');
  const codes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');
  const names = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['cs'], { type: 'region' })
    : null;

  const options = codes
    .map(code => ({ code, name: names?.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  for (const { code, name } of options) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    select.appendChild(option);
  }

  try {
    const browserRegion = new Intl.Locale(navigator.language).region;
    if (browserRegion && codes.includes(browserRegion)) select.value = browserRegion;
    else if (navigator.language.toLowerCase().startsWith('cs')) select.value = 'CZ';
  } catch (e) { /* keep the placeholder */ }
}

// initialize UI
populateCountries();
updateUsageUI(); updateMenuUI(); loadUsage();

// Reset button handler (clear usage)
const resetBtn = document.getElementById('resetBtn');
if (resetBtn) {
  resetBtn.addEventListener('click', async ()=>{
    if (!confirm('Opravdu chcete resetovat počet pokusů na 0?')) return;
    try {
      applyUsage(await api('/api/usage/reset', { method: 'POST' }));
      alert(`Počet pokusů byl resetován. Máte opět ${freeLimit} volných dotazů.`);
    } catch (err) { alert(err.message); }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const city = cityInput.value.trim();
  if (!city) return;

  errorEl.classList.add('hidden');
  rawEl.classList.add('hidden');
  resultEl.innerHTML = '<div class="loading">Načítám…</div>';
  resultEl.classList.remove('hidden');

  try {
    let url;
    const place = (selectedLat && selectedLon)
      ? { lat: selectedLat, lon: selectedLon, shortName: selectedName }
      : suggestions.find(s => (s.display || s.name).toLowerCase() === city.toLowerCase());

    if (place) {
      const label = place.shortName || place.name || city;
      url = `/api/weather?lat=${encodeURIComponent(place.lat)}&lon=${encodeURIComponent(place.lon)}&name=${encodeURIComponent(label)}`;
    } else {
      url = `/api/weather?city=${encodeURIComponent(city)}`;
    }

    const resp = await api(url);
    applyUsage(resp.usage);
    latestRaw = resp;
    render(resp);
  } catch (err) {
    applyUsage(err.data?.usage);
    resultEl.classList.add('hidden');
    if (err.data?.code === 'FREE_LIMIT_REACHED') {
      setAuthMessage(err.message, 'error');
      openAuth('register');
      return;
    }
    if (err.data?.code === 'INSUFFICIENT_CREDITS') {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
      return;
    }
    errorEl.textContent = err.message || 'Neznámá chyba';
    errorEl.classList.remove('hidden');
  }
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
    // first Escape closes the suggestions, a second one clears the input
    if (visible) {
      suggestionsEl.classList.add('hidden');
    } else {
      cityInput.value = '';
      selectedLat = selectedLon = selectedName = null;
    }
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

// Shifting the UNIX timestamp by the location's offset only gives the right
// wall-clock time if it is then formatted in UTC — otherwise the browser
// timezone gets applied on top of it.
function localDate(dt, tzOffset) {
  return new Date((dt + (tzOffset || 0)) * 1000);
}

function fmtTime(dt, tzOffset) {
  if (!dt) return '-';
  return localDate(dt, tzOffset).toLocaleTimeString('cs-CZ', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
  });
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
        <h2>${escapeHtml(location.name)}${location.country ? ', ' + escapeHtml(location.country) : ''}</h2>
        <p class="big">${tempVal}</p>
        <p class="desc">${escapeHtml(desc)}</p>
        <div class="meta">${feelsVal ? `Cítí se jako ${feelsVal} • ` : ''}Vlhkost ${humidityVal} • Vítr ${windVal}</div>
      </div>
      <div class="icon">
        <img src="https://openweathermap.org/img/wn/${encodeURIComponent(icon)}@2x.png" alt="${escapeHtml(desc)}" />
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
      <div class="hour-time">${localDate(h.dt, tz).toLocaleString('cs-CZ', {hour: '2-digit', minute:'2-digit', day:'2-digit', month:'2-digit', timeZone: 'UTC'})}</div>
      <div class="hour-temp">${Math.round(h.main.temp)}°C</div>
      <div class="hour-pop">${Math.round((h.pop || 0) * 100)}%</div>
    </div>
  `).join('');

  // daily
  const dailyMap = {};
  (forecast && forecast.list || []).forEach(item => {
    const date = localDate(item.dt, tz).toLocaleDateString('cs-CZ', { timeZone: 'UTC' });
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
        <div class="day-date">${escapeHtml(dk)}</div>
        <div class="day-desc">${escapeHtml(v.desc)}</div>
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
        <div><strong>Kvalita ovzduší:</strong> ${aqi ? escapeHtml((aqiMap[aqi] || aqi) + ' (AQI ' + aqi + ')') : '-'}</div>
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
const form = document.getElementById('form');
const cityInput = document.getElementById('city');
const suggestionsEl = document.getElementById('suggestions');
const resultEl = document.getElementById('result');
const errorEl = document.getElementById('error');
const rawEl = document.getElementById('raw');
const toggleRaw = document.getElementById('toggleRaw');
const chatToggle = document.getElementById('chatToggle');
const chatPanel = document.getElementById('chatPanel');
const chatClose = document.getElementById('chatClose');
const chatNew = document.getElementById('chatNew');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatCounter = document.getElementById('chatCounter');

let latestRaw = null;
let suggestions = [];
let selectedIndex = -1;
let selectedLat = null;
let selectedLon = null;
let selectedName = null;
let chatBusy = false;
const CHAT_MAX_MESSAGES = 10;
const CHAT_PROGRESS_NOTICE_MS = 15000;
const CHAT_REQUEST_TIMEOUT_MS = 130000;
const RAW_TOGGLE_SHOW_TEXT = 'Zobrazit surová data';
const RAW_TOGGLE_HIDE_TEXT = 'Skrýt surová data';
const WEATHER_LOADING_TEXT = 'Načítám…';
const UNKNOWN_ERROR_TEXT = 'Neznámá chyba';

// Auth / usage state mirrors the server session; the server stays authoritative.
let freeUsage = 0;
let freeLimit = 5;
let currentUser = null;
let chatHistory = [];
let activeConversationMessageCount = 0;
let activeConversationMaxMessages = CHAT_MAX_MESSAGES;

function applyUsage(usage) {
  if (!usage) return;
  const previousUserId = currentUser?.id || null;
  if (typeof usage.count === 'number') freeUsage = usage.count;
  if (typeof usage.limit === 'number') freeLimit = usage.limit;
  currentUser = usage.user || null;
  const nextUserId = currentUser?.id || null;
  if (nextUserId !== previousUserId) {
    if (!nextUserId) {
      chatHistory = [];
      setChatStatus('');
      setChatEmpty('Pro chat se přihlaste.');
    } else {
      loadChatHistory();
    }
  }
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

async function refreshAuthState() {
  try {
    applyUsage(await api('/api/usage'));
  } catch (e) {
    currentUser = null;
    updateMenuUI();
  }
  return Boolean(currentUser);
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

function userInitials(user) {
  const a = (user.firstName || '').trim().charAt(0);
  const b = (user.lastName || '').trim().charAt(0);
  const text = `${a}${b}`.toUpperCase();
  return text || (user.email || '?').charAt(0).toUpperCase();
}

function updateHeaderAvatar() {
  const avatarLink = document.getElementById('avatarLink');
  const headerAvatar = document.getElementById('headerAvatar');
  if (!avatarLink || !headerAvatar) return;

  if (!currentUser) {
    avatarLink.classList.add('hidden');
    headerAvatar.classList.remove('has-image');
    headerAvatar.textContent = '?';
    return;
  }

  avatarLink.classList.remove('hidden');
  if (currentUser.avatarUrl) {
    headerAvatar.innerHTML = `<img src="${escapeHtml(currentUser.avatarUrl)}" alt="">`;
    headerAvatar.classList.add('has-image');
  } else {
    headerAvatar.textContent = userInitials(currentUser);
    headerAvatar.classList.remove('has-image');
  }
}

function updateMenuUI(){
  const logoutBtn = document.getElementById('logoutBtn');
  const menuBtn = document.getElementById('menuBtn');
  const openLogin = document.getElementById('openLogin');
  const openRegister = document.getElementById('openRegister');
  const adminLink = document.getElementById('adminLink');
  const isLoggedIn = Boolean(currentUser);
  const isAdmin = currentUser?.role === 'admin';

  if (isLoggedIn) {
    menuBtn.textContent = `${currentUser.name} ▾`;
    logoutBtn.classList.remove('hidden');
    openLogin.classList.add('hidden');
    openRegister.classList.add('hidden');
    adminLink.classList.toggle('hidden', !isAdmin);
  } else {
    menuBtn.textContent = 'Účet ▾';
    logoutBtn.classList.add('hidden');
    openLogin.classList.remove('hidden');
    openRegister.classList.remove('hidden');
    adminLink.classList.add('hidden');
  }
  updateHeaderAvatar();
  updateChatAvailability();
}

async function loadAppVersion() {
  const versionEl = document.getElementById('appVersion');
  if (!versionEl) return;
  try {
    const data = await api('/api/version');
    const parts = [data.version || 'dev'];
    if (data.branch) parts.push(data.branch);
    if (data.commit) parts.push(data.commit);
    versionEl.textContent = parts.join(' • ');
  } catch (err) {
    versionEl.textContent = 'dev';
  }
}

function updateChatAvailability() {
  if (!chatToggle || !chatPanel) return;
  const enabled = Boolean(currentUser);
  chatToggle.classList.toggle('hidden', !enabled);
  chatToggle.disabled = !enabled;
  if (!enabled) {
    chatPanel.classList.add('hidden');
    chatToggle.setAttribute('aria-expanded', 'false');
  }
  if (chatInput) chatInput.disabled = !enabled || chatBusy;
  if (chatSend) chatSend.disabled = !enabled || chatBusy;
  if (chatNew) chatNew.disabled = !enabled || chatBusy;
  if (!enabled) {
    if (chatInput) chatInput.value = '';
    activeConversationMessageCount = 0;
    activeConversationMaxMessages = CHAT_MAX_MESSAGES;
    setChatCounter(0, activeConversationMaxMessages);
    setChatStatus('');
    setChatEmpty('Pro chat se přihlaste.');
  }
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function setChatEmpty(message) {
  if (!chatMessages) return;
  chatMessages.innerHTML = `<div class="chat-empty">${escapeHtml(message)}</div>`;
}

function setChatStatus(message) {
  const statusEl = document.getElementById('chatStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
}

function setChatCounter(count = 0, max = CHAT_MAX_MESSAGES) {
  if (!chatCounter) return;
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : CHAT_MAX_MESSAGES;
  chatCounter.textContent = `${safeCount}/${safeMax}`;
}

function resetRawOutput() {
  if (rawEl) {
    rawEl.classList.add('hidden');
    rawEl.textContent = '';
  }
  if (toggleRaw) toggleRaw.textContent = RAW_TOGGLE_SHOW_TEXT;
}

function renderLoadingState(message = WEATHER_LOADING_TEXT) {
  if (!resultEl) return;
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = message;
  resultEl.replaceChildren(loading);
  resultEl.classList.remove('hidden');
}

function showWeatherError(message) {
  if (!errorEl) return;
  resultEl.classList.add('hidden');
  errorEl.textContent = message || UNKNOWN_ERROR_TEXT;
  errorEl.classList.remove('hidden');
}

function renderChatHistory() {
  if (!chatMessages) return;
  if (!chatHistory.length) {
    setChatEmpty('Chat je připravený.');
    return;
  }
  chatMessages.innerHTML = '';
  for (const item of chatHistory) {
    appendChat(item.role, item.text);
  }
}

function appendChat(role, text) {
  if (!chatMessages) return;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function focusChatInput() {
  if (!chatInput) return;
  setTimeout(() => {
    if (!currentUser) return;
    chatInput.disabled = false;
    chatInput.focus();
  }, 0);
}

async function loadChatHistory() {
  if (!currentUser) return;
  try {
    const data = await api('/api/chat/history');
    const history = Array.isArray(data.messages) ? data.messages : [];
    const maxMessages = Number.parseInt(data.maxMessages, 10);
    activeConversationMaxMessages = Number.isFinite(maxMessages) && maxMessages > 0
      ? maxMessages
      : CHAT_MAX_MESSAGES;
    chatHistory = history.map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      text: String(item.text || '')
    }));
    const messageCount = Number.parseInt(data.messageCount, 10);
    activeConversationMessageCount = Number.isFinite(messageCount)
      ? Math.max(0, messageCount)
      : history.length;
    setChatCounter(activeConversationMessageCount, activeConversationMaxMessages);
    if (chatPanel && !chatPanel.classList.contains('hidden')) {
      renderChatHistory();
    }
  } catch (err) {
    chatHistory = [];
    activeConversationMessageCount = 0;
    setChatCounter(0, activeConversationMaxMessages);
    if (chatPanel && !chatPanel.classList.contains('hidden')) {
      setChatEmpty(err.message || 'Historii chatu se nepodařilo načíst.');
    }
  }
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
const authMessage = document.getElementById('authMessage');
const authFormHost = document.getElementById('authFormHost');
const loginFormTemplate = document.getElementById('loginFormTemplate');
const registerFormTemplate = document.getElementById('registerFormTemplate');

function getLoginForm() {
  return authFormHost.querySelector('#loginForm');
}

function getRegisterForm() {
  return authFormHost.querySelector('#registerForm');
}

function hideAuthForms() {
  authFormHost.replaceChildren();
}

function renderAuthForm(kind) {
  const template = kind === 'register' ? registerFormTemplate : loginFormTemplate;
  if (!template) return null;
  const fragment = template.content.cloneNode(true);
  authFormHost.replaceChildren(fragment);
  const renderedForm = kind === 'register' ? getRegisterForm() : getLoginForm();
  if (kind === 'register') populateCountries(renderedForm?.querySelector('#regCountry'));
  return renderedForm;
}

menuBtn.addEventListener('click', ()=>{ const expanded = menuBtn.getAttribute('aria-expanded') === 'true'; menuBtn.setAttribute('aria-expanded', String(!expanded)); menuDrop.classList.toggle('hidden'); });
openLogin.addEventListener('click', ()=>{ openAuth('login'); });
openRegister.addEventListener('click', ()=>{ openAuth('register'); });
logoutBtn.addEventListener('click', async ()=>{
  try { applyUsage(await api('/api/auth/logout', { method: 'POST' })); alert('Odhlášeno'); }
  catch (err) { alert(err.message); }
});
closeAuth.addEventListener('click', ()=>{ closeAuthModal(); });

if (chatToggle && chatPanel) {
  chatToggle.addEventListener('click', async () => {
    const authenticated = await refreshAuthState();
    if (!authenticated) {
      openAuth('login');
      return;
    }
    const opening = chatPanel.classList.contains('hidden');
    if (opening) {
      chatPanel.classList.remove('hidden');
      chatToggle.setAttribute('aria-expanded', 'true');
      setChatStatus('Načítám historii…');
      await loadChatHistory();
      renderChatHistory();
      setChatStatus('');
      focusChatInput();
    } else {
      chatPanel.classList.add('hidden');
      chatToggle.setAttribute('aria-expanded', 'false');
      setChatStatus('');
    }
  });
}
if (chatClose && chatPanel) {
  chatClose.addEventListener('click', () => {
    chatPanel.classList.add('hidden');
    chatToggle.setAttribute('aria-expanded', 'false');
    setChatStatus('');
  });
}
if (chatNew) {
  chatNew.addEventListener('click', async () => {
    const authenticated = await refreshAuthState();
    if (!authenticated) {
      openAuth('login');
      return;
    }
    if (chatBusy) return;
    chatBusy = true;
    if (chatSend) chatSend.disabled = true;
    if (chatInput) chatInput.disabled = true;
    chatNew.disabled = true;
    setChatStatus('Zakládám nový chat…');
    try {
      const data = await api('/api/chat/new', { method: 'POST' });
      const maxMessages = Number.parseInt(data.maxMessages, 10);
      activeConversationMaxMessages = Number.isFinite(maxMessages) && maxMessages > 0
        ? maxMessages
        : CHAT_MAX_MESSAGES;
      activeConversationMessageCount = 0;
      chatHistory = [{
        role: 'system',
        text: `Začala nová konverzace (limit ${activeConversationMaxMessages} zpráv).`
      }];
      setChatCounter(activeConversationMessageCount, activeConversationMaxMessages);
      renderChatHistory();
      setChatStatus('');
      focusChatInput();
    } catch (err) {
      chatHistory.push({ role: 'system', text: err.message || 'Nový chat se nepodařilo vytvořit.' });
      renderChatHistory();
      setChatStatus('Chyba při vytváření chatu.');
    } finally {
      chatBusy = false;
      if (chatSend) chatSend.disabled = false;
      if (chatInput) chatInput.disabled = false;
      chatNew.disabled = false;
      if (chatPanel && !chatPanel.classList.contains('hidden')) {
        focusChatInput();
      }
    }
  });
}
if (chatForm && chatInput && chatMessages) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const authenticated = await refreshAuthState();
    if (!authenticated) {
      openAuth('login');
      return;
    }
    const message = chatInput.value.trim();
    if (!message || chatBusy) return;
    chatBusy = true;
    chatSend.disabled = true;
    chatInput.disabled = true;
    if (chatNew) chatNew.disabled = true;
    chatHistory.push({ role: 'user', text: message });
    chatInput.value = '';
    renderChatHistory();
    setChatStatus('Načítám odpověď…');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS);
    const slowNoticeId = setTimeout(() => {
      if (chatBusy) {
        setChatStatus('Odpověď trvá déle než obvykle…');
      }
    }, CHAT_PROGRESS_NOTICE_MS);
    try {
      const data = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal
      });
      const maxMessages = Number.parseInt(data.maxMessages, 10);
      activeConversationMaxMessages = Number.isFinite(maxMessages) && maxMessages > 0
        ? maxMessages
        : CHAT_MAX_MESSAGES;
      const savedMessages = Array.isArray(data.messages) ? data.messages : null;
      if (savedMessages) {
        chatHistory = savedMessages.map((item) => ({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          text: String(item.text || '')
        }));
      } else {
        chatHistory.push({ role: 'assistant', text: data.message || '...' });
      }
      const messageCount = Number.parseInt(data.messageCount, 10);
      activeConversationMessageCount = Number.isFinite(messageCount)
        ? Math.max(0, messageCount)
        : chatHistory.filter(item => item.role === 'user' || item.role === 'assistant').length;
      if (data.rotated) {
        chatHistory.unshift({
          role: 'system',
          text: `Začala nová konverzace (limit ${activeConversationMaxMessages} zpráv).`
        });
      }
      setChatCounter(activeConversationMessageCount, activeConversationMaxMessages);
      renderChatHistory();
      setChatStatus('');
      focusChatInput();
    } catch (err) {
      const errorMessage = err.name === 'AbortError'
        ? 'Chat momentálně neodpovídá. Zkuste to prosím znovu.'
        : err.message;
      chatHistory.push({ role: 'system', text: errorMessage });
      renderChatHistory();
      setChatStatus('Chyba při odeslání.');
      focusChatInput();
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(slowNoticeId);
      chatBusy = false;
      chatSend.disabled = false;
      chatInput.disabled = false;
      if (chatNew) chatNew.disabled = false;
      if (chatPanel && !chatPanel.classList.contains('hidden')) {
        focusChatInput();
      }
    }
  });
  chatInput.addEventListener('input', () => {
    if (chatInput.value.indexOf('\n') !== -1) {
      chatInput.value = chatInput.value.replace(/\n/g, '');
    }
  });
}

document.addEventListener('click', (e) => {
  if (!chatPanel || !chatToggle) return;
  if (chatPanel.classList.contains('hidden')) return;
  if (chatPanel.contains(e.target) || chatToggle.contains(e.target)) return;
  chatPanel.classList.add('hidden');
  chatToggle.setAttribute('aria-expanded', 'false');
});

let lastFocusedBeforeModal = null;

function closeAuthModal(){
  authModal.classList.add('hidden');
  hideAuthForms();
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
  hideAuthForms();
  setAuthMessage('Bez registrace můžete provést 5 dotazů. Po registraci získáte 5 kreditů na další hledání.');
  const visibleForm = renderAuthForm(kind);
  visibleForm?.querySelector('input, select')?.focus();
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

authModal.addEventListener('submit', async (e)=>{
  const submittedForm = e.target.closest('form');
  if (!submittedForm) return;
  e.preventDefault();

  if (submittedForm.id === 'loginForm') {
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
    return;
  }

  if (submittedForm.id !== 'registerForm') return;

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
    getRegisterForm()?.reset();
    if (response.confirmationRequired) {
      const loginForm = renderAuthForm('login');
      setAuthMessage(response.message, 'success');
      const loginEmail = loginForm?.querySelector('#loginEmail');
      if (loginEmail) loginEmail.value = payload.email;
      loginForm?.querySelector('input, select')?.focus();
    } else {
      closeAuthModal();
    }
  } catch (err) {
    setAuthMessage(err.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

function populateCountries(select = document.getElementById('regCountry')) {
  if (!select) return;
  select.innerHTML = '<option value="">Vyberte zemi</option>';
  const options = getCountryList();
  const codes = options.map(item => item.code);

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
updateUsageUI(); updateMenuUI(); loadUsage();
loadAppVersion();

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
  resetRawOutput();
  renderLoadingState();

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
      showWeatherError(err.message);
      return;
    }
    showWeatherError(err.message || UNKNOWN_ERROR_TEXT);
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
// wall-clock time if it is then formatted in UTC - otherwise the browser
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
    <div>Východ slunce: ${fmtTime(cur.sys?.sunrise, tzOffset)}</div>
    <div>Západ slunce: ${fmtTime(cur.sys?.sunset, tzOffset)}</div>
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
    const aqiMap = {1: 'Dobrá', 2: 'Uspokojivá', 3: 'Střední', 4: 'Špatná', 5: 'Velmi špatná'};
    const aqi = a.main?.aqi;
    const comp = a.components || {};
    return `
      <div class="air-box">
        <div><strong>Kvalita ovzduší:</strong> ${aqi ? escapeHtml((aqiMap[aqi] || aqi) + ' (AQI ' + aqi + ')') : '-'}</div>
        <div class="air-items">PM2.5: ${comp.pm2_5 ?? '-'} µg/m³ • PM10: ${comp.pm10 ?? '-'} µg/m³ • O3: ${comp.o3 ?? '-'} µg/m³ • NO2: ${comp.no2 ?? '-'} µg/m³ • CO: ${comp.co ?? '-'}</div>
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
    toggleRaw.textContent = RAW_TOGGLE_HIDE_TEXT;
  } else {
    rawEl.classList.add('hidden');
    toggleRaw.textContent = RAW_TOGGLE_SHOW_TEXT;
  }
});

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
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
chatStatusEl = document.getElementById('chatStatus');
const appVersion = document.getElementById('appVersion');

let latestRaw = null;
let suggestions = [];
let selectedIndex = -1;
let selectedLat = null;
let selectedLon = null;
let selectedName = null;
let chatBusy = false;
let chatHistory = [];
let versionCache = '...';
let chatStatusEl = null;

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
  const profileLink = document.getElementById('profileLink');

  if (currentUser && currentUser.name) {
    menuBtn.textContent = currentUser.name + ' ?';
    logoutBtn.classList.remove('hidden');
    openLogin.classList.add('hidden');
    openRegister.classList.add('hidden');
    const isAdmin = currentUser.role === 'admin';
    adminLink.classList.toggle('hidden', !isAdmin);
    profileLink.classList.toggle('hidden', isAdmin);
  } else {
    menuBtn.textContent = 'Prihl�sit / Registrovat ?';
    logoutBtn.classList.add('hidden');
    openLogin.classList.remove('hidden');
    openRegister.classList.remove('hidden');
    adminLink.classList.add('hidden');
    profileLink.classList.add('hidden');
  }
  updateHeaderAvatar();
  updateChatAvailability();
}

async function loadAppVersion() {
  if (!appVersion) return;
  try {
    const data = await api('/api/version');
    versionCache = data.version || 'dev';
  } catch (err) {
    versionCache = 'dev';
  }
  appVersion.textContent = versionCache;
}

function updateChatAvailability() {
  if (!chatToggle || !chatPanel) return;
  chatToggle.classList.remove('hidden');
  chatPanel.classList.add('hidden');
  chatToggle.setAttribute('aria-expanded', 'false');
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
  if (!chatStatusEl) return;
  chatStatusEl.textContent = message;
}

function renderChatHistory() {
  if (!chatMessages) return;
  if (!chatHistory.length) {
    setChatEmpty('Chat je pripraven�.');
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
    chatInput.focus();
  }, 0);
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
    if (!res.ok) throw new Error('Na�ept�v�n� nen� moment�lne dostupn�.');
    const list = await res.json();
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
  selectedLat = selectedLon = selectedName = null;
  suggest(e.target.value);
});

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
  try { applyUsage(await api('/api/auth/logout', { method: 'POST' })); alert('Odhl�eno'); }
  catch (err) { alert(err.message); }
});
closeAuth.addEventListener('click', ()=>{ closeAuthModal(); });

if (chatToggle && chatPanel) {
  chatToggle.addEventListener('click', () => {
    const opening = chatPanel.classList.contains('hidden');
    if (opening) {
      chatPanel.classList.remove('hidden');
      chatToggle.setAttribute('aria-expanded', 'true');
      renderChatHistory();
      focusChatInput();
    } else {
      chatPanel.classList.add('hidden');
      chatToggle.setAttribute('aria-expanded', 'false');
    }
  });
}
if (chatClose && chatPanel) {
  chatClose.addEventListener('click', () => {
    chatPanel.classList.add('hidden');
    chatToggle.setAttribute('aria-expanded', 'false');
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
    const message = chatInput.value.trim();
    if (!message || chatBusy) return;
    chatBusy = true;
    chatSend.disabled = true;
    chatInput.disabled = true;
    chatHistory.push({ role: 'user', text: message });
    chatInput.value = '';
    setChatStatus('Načítám odpověď…');
    try {
      const data = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      chatHistory.push({ role: 'assistant', text: data.message || '...' });
      renderChatHistory();
      setChatStatus('');
    } catch (err) {
      chatHistory.push({ role: 'system', text: err.message });
      renderChatHistory();
      setChatStatus('Chyba při odeslání.');
    } finally {
      chatBusy = false;
      chatSend.disabled = false;
      chatInput.disabled = false;
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
  setAuthMessage('Bez registrace mu�ete prov�st 5 dotazu. Po registraci z�sk�te 5 kreditu na dal�� hled�n�.');
  if (kind === 'login'){ loginForm.classList.remove('hidden'); }
  else if (kind === 'register'){ registerForm.classList.remove('hidden'); }
  authModal.querySelector('.auth-form:not(.hidden) input, .auth-form:not(.hidden) select')?.focus();
}

authModal.addEventListener('click', (e)=>{ if (e.target === authModal) closeAuthModal(); });

document.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape' || authModal.classList.contains('hidden')) return;
  closeAuthModal();
});

authModal.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape' && !authModal.classList.contains('hidden')) {
    closeAuthModal();
  }
});

populateCountries();
updateUsageUI(); updateMenuUI(); loadUsage();
loadAppVersion();

// Reset button handler (clear usage)
const resetBtn = document.getElementById('resetBtn');
if (resetBtn) {
  resetBtn.addEventListener('click', async ()=>{
    try { applyUsage(await api('/api/usage/reset', { method: 'POST' })); alert('Po?et pokus? resetov?n'); }
    catch (err) { alert(err.message); }
  });
}

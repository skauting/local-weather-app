const profileGate = document.getElementById('profileGate');
const profilePanel = document.getElementById('profilePanel');
const profileError = document.getElementById('profileError');
const profileMessage = document.getElementById('profileMessage');
const avatarPreview = document.getElementById('avatarPreview');
const avatarInput = document.getElementById('avatarInput');
const bioInput = document.getElementById('bio');
const bioCount = document.getElementById('bioCount');
const adminNavLink = document.getElementById('adminNavLink');
const countrySearch = document.getElementById('countrySearch');
const countryCodeInput = document.getElementById('countryCode');
const countryList = document.getElementById('countryList');

const countries = getCountryList();
let currentUser = null;
let countrySelectedIndex = -1;

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

function showError(message) {
  profileError.textContent = message || '';
  profileError.classList.toggle('hidden', !message);
}

function showMessage(message) {
  profileMessage.textContent = message || '';
  profileMessage.classList.toggle('hidden', !message);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initials(user) {
  const a = (user.firstName || '').trim().charAt(0);
  const b = (user.lastName || '').trim().charAt(0);
  const text = `${a}${b}`.toUpperCase();
  return text || (user.email || '?').charAt(0).toUpperCase();
}

function renderAvatar(user) {
  if (user.avatarUrl) {
    avatarPreview.innerHTML = `<img src="${escapeHtml(user.avatarUrl)}" alt="">`;
    avatarPreview.classList.add('has-image');
  } else {
    avatarPreview.textContent = initials(user);
    avatarPreview.classList.remove('has-image');
  }
}

function updateBioCount() {
  bioCount.textContent = `(${bioInput.value.length}/500)`;
}

function setCountry(code) {
  const match = countries.find(item => item.code === code);
  if (!match) {
    countryCodeInput.value = '';
    countrySearch.value = '';
    return;
  }
  countryCodeInput.value = match.code;
  countrySearch.value = match.name;
  hideCountryList();
}

function filteredCountries() {
  const q = countrySearch.value.trim().toLowerCase();
  if (!q) return countries.slice(0, 12);
  return countries
    .filter(item => item.name.toLowerCase().includes(q) || item.code.toLowerCase().includes(q))
    .slice(0, 12);
}

function hideCountryList() {
  countryList.classList.add('hidden');
  countrySelectedIndex = -1;
}

function renderCountryList(items) {
  if (!items.length) {
    countryList.innerHTML = '<li class="muted" role="presentation">Žádná shoda</li>';
    countryList.classList.remove('hidden');
    countrySelectedIndex = -1;
    return;
  }

  countryList.innerHTML = items.map((item, index) => (
    `<li role="option" data-code="${escapeHtml(item.code)}" aria-selected="${index === countrySelectedIndex}">${escapeHtml(item.name)}</li>`
  )).join('');
  countryList.classList.remove('hidden');
}

function syncCountryFromTypedValue() {
  const typed = countrySearch.value.trim().toLowerCase();
  const exact = countries.find(item => item.name.toLowerCase() === typed || item.code.toLowerCase() === typed);
  if (exact) {
    setCountry(exact.code);
    return true;
  }
  if (countryCodeInput.value) {
    const selected = countries.find(item => item.code === countryCodeInput.value);
    if (selected && selected.name.toLowerCase() === typed) return true;
  }
  countryCodeInput.value = '';
  return false;
}

function fillForm(user) {
  currentUser = user;
  document.getElementById('firstName').value = user.firstName || '';
  document.getElementById('lastName').value = user.lastName || '';
  document.getElementById('email').value = user.email || '';
  document.getElementById('phone').value = user.phone || '';
  document.getElementById('creditsCount').textContent = user.credits ?? 0;
  document.getElementById('rolePill').textContent = user.role || 'user';
  document.getElementById('rolePill').classList.toggle('role-admin', user.role === 'admin');
  bioInput.value = user.bio || '';
  updateBioCount();
  setCountry(user.countryCode || '');
  renderAvatar(user);
  adminNavLink.classList.toggle('hidden', user.role !== 'admin');
}

async function loadProfile() {
  showError('');
  showMessage('');
  try {
    const data = await api('/api/profile');
    fillForm(data.user);
    profileGate.classList.add('hidden');
    profilePanel.classList.remove('hidden');
  } catch (e) {
    profileGate.innerHTML = `<p class="meta">${escapeHtml(e.message || 'Nejste přihlášeni.')}</p>
      <p><a class="menu-link" href="/">Zpět na počasí</a></p>`;
  }
}

document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  showMessage('');

  if (!syncCountryFromTypedValue() || !countryCodeInput.value) {
    showError('Vyberte zemi ze seznamu.');
    countrySearch.focus();
    return;
  }

  const saveBtn = document.getElementById('saveProfile');
  saveBtn.disabled = true;
  try {
    const data = await api('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: document.getElementById('firstName').value,
        lastName: document.getElementById('lastName').value,
        phone: document.getElementById('phone').value,
        countryCode: countryCodeInput.value,
        bio: bioInput.value
      })
    });
    fillForm(data.user);
    showMessage('Profil byl uložen.');
  } catch (err) {
    showError(err.message || 'Uložení selhalo.');
  } finally {
    saveBtn.disabled = false;
  }
});

bioInput.addEventListener('input', updateBioCount);

countrySearch.addEventListener('focus', () => {
  renderCountryList(filteredCountries());
});

countrySearch.addEventListener('input', () => {
  countryCodeInput.value = '';
  const items = filteredCountries();
  countrySelectedIndex = items.length ? 0 : -1;
  renderCountryList(items);
});

countrySearch.addEventListener('keydown', (e) => {
  const items = filteredCountries();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) return;
    countrySelectedIndex = Math.min(items.length - 1, countrySelectedIndex + 1);
    renderCountryList(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    countrySelectedIndex = Math.max(0, countrySelectedIndex - 1);
    renderCountryList(items);
  } else if (e.key === 'Enter') {
    if (!countryList.classList.contains('hidden') && countrySelectedIndex >= 0 && items[countrySelectedIndex]) {
      e.preventDefault();
      setCountry(items[countrySelectedIndex].code);
    }
  } else if (e.key === 'Escape') {
    hideCountryList();
  }
});

countryList.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-code]');
  if (!li) return;
  e.preventDefault();
  setCountry(li.getAttribute('data-code'));
});

countrySearch.addEventListener('blur', () => {
  setTimeout(() => {
    syncCountryFromTypedValue();
    hideCountryList();
  }, 120);
});

avatarInput.addEventListener('change', async () => {
  const file = avatarInput.files && avatarInput.files[0];
  avatarInput.value = '';
  if (!file) return;
  showError('');
  showMessage('');

  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const data = await api('/api/profile/avatar', {
      method: 'POST',
      body: formData
    });
    fillForm(data.user);
    showMessage('Avatar byl aktualizován.');
  } catch (err) {
    showError(err.message || 'Nahrání avatara selhalo.');
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  window.location.href = '/';
});

loadProfile();

const adminGate = document.getElementById('adminGate');
const adminPanel = document.getElementById('adminPanel');
const adminError = document.getElementById('adminError');
const adminMessage = document.getElementById('adminMessage');
const usersBody = document.getElementById('usersBody');
const searchesBody = document.getElementById('searchesBody');
const adminName = document.getElementById('adminName');
const refreshAll = document.getElementById('refreshAll');
const logoutBtn = document.getElementById('logoutBtn');

let currentAdminId = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDateTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('cs-CZ', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    return String(value);
  }
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

function showError(message) {
  adminError.textContent = message;
  adminError.classList.remove('hidden');
  adminMessage.classList.add('hidden');
}

function showMessage(message) {
  adminMessage.textContent = message;
  adminMessage.classList.remove('hidden');
  adminError.classList.add('hidden');
}

function clearFeedback() {
  adminError.classList.add('hidden');
  adminMessage.classList.add('hidden');
}

function renderUsers(users) {
  usersBody.innerHTML = '';
  if (!users.length) {
    usersBody.innerHTML = '<tr><td colspan="6" class="meta">Zatím nejsou žádní registrovaní uživatelé.</td></tr>';
    return;
  }

  for (const user of users) {
    const blocked = Boolean(user.isBlocked);
    const canToggle = user.id !== currentAdminId;
    const tr = document.createElement('tr');
    tr.className = blocked ? 'row-blocked' : '';
    tr.innerHTML = `
      <td>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><strong class="credits-cell">${escapeHtml(user.credits)}</strong></td>
      <td>
        <span class="status-pill ${blocked ? 'status-blocked' : 'status-active'}">
          ${blocked ? 'Zablokovaný' : 'Aktivní'}
        </span>
      </td>
      <td>
        <form class="topup-form" data-user-id="${escapeHtml(user.id)}">
          <input type="number" name="amount" min="1" max="100000" value="5" required aria-label="Počet kreditů" />
          <button type="submit">Dobít</button>
        </form>
      </td>
      <td>
        ${canToggle ? `
          <button
            type="button"
            class="block-btn ${blocked ? 'unmute' : 'mute'}"
            data-user-id="${escapeHtml(user.id)}"
            data-blocked="${blocked ? 'false' : 'true'}"
          >${blocked ? 'Aktivovat' : 'Zablokovat'}</button>
        ` : '<span class="meta">—</span>'}
      </td>
    `;
    usersBody.appendChild(tr);
  }
}

function renderSearches(searches) {
  searchesBody.innerHTML = '';
  if (!searches.length) {
    searchesBody.innerHTML = '<tr><td colspan="3" class="meta">Zatím žádná vyhledávání.</td></tr>';
    return;
  }

  for (const item of searches) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div>${escapeHtml(item.userName || '—')}</div>
        <div class="meta">${escapeHtml(item.userEmail || '')}</div>
      </td>
      <td>${escapeHtml(item.city)}</td>
      <td>${escapeHtml(formatDateTime(item.searchedAt))}</td>
    `;
    searchesBody.appendChild(tr);
  }
}

async function loadUsers() {
  const data = await api('/api/admin/users');
  renderUsers(data.users || []);
}

async function loadSearches() {
  const data = await api('/api/admin/searches?limit=50');
  renderSearches(data.searches || []);
}

async function refreshData(showToast) {
  clearFeedback();
  await Promise.all([loadUsers(), loadSearches()]);
  if (showToast) showMessage('Data byla obnovena.');
}

async function bootstrap() {
  try {
    const usage = await api('/api/usage');
    const user = usage.user;
    if (!user) {
      adminGate.innerHTML = '<p class="meta">Pro administraci se musíte <a href="/">přihlásit</a> jako administrátor.</p>';
      return;
    }
    if (user.role !== 'admin') {
      adminGate.innerHTML = '<p class="meta">Tato stránka je dostupná pouze administrátorům.</p>';
      return;
    }

    currentAdminId = user.id;
    adminName.textContent = user.name || user.email;
    adminGate.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    await refreshData(false);
  } catch (err) {
    adminGate.innerHTML = `<p class="meta">${escapeHtml(err.message)}</p>`;
  }
}

usersBody.addEventListener('submit', async (e) => {
  const form = e.target.closest('.topup-form');
  if (!form) return;
  e.preventDefault();
  const userId = form.dataset.userId;
  const amount = Number.parseInt(new FormData(form).get('amount'), 10);
  const button = form.querySelector('button');
  button.disabled = true;
  clearFeedback();
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(userId)}/credits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    showMessage(result.message || 'Kredity byly dobity.');
    await refreshData(false);
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

usersBody.addEventListener('click', async (e) => {
  const button = e.target.closest('.block-btn');
  if (!button) return;
  const userId = button.dataset.userId;
  const blocked = button.dataset.blocked === 'true';
  const action = blocked ? 'zablokovat' : 'aktivovat';
  if (!confirm(`Opravdu chcete uživatele ${action}?`)) return;
  button.disabled = true;
  clearFeedback();
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(userId)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked })
    });
    showMessage(result.message || 'Stav účtu byl změněn.');
    await refreshData(false);
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

refreshAll.addEventListener('click', async () => {
  refreshAll.disabled = true;
  try {
    await refreshData(true);
  } catch (err) {
    showError(err.message);
  } finally {
    refreshAll.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
  }
});

bootstrap();

const adminGate = document.getElementById('adminGate');
const adminPanel = document.getElementById('adminPanel');
const adminError = document.getElementById('adminError');
const adminMessage = document.getElementById('adminMessage');
const usersBody = document.getElementById('usersBody');
const adminName = document.getElementById('adminName');
const refreshUsers = document.getElementById('refreshUsers');
const logoutBtn = document.getElementById('logoutBtn');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
    usersBody.innerHTML = '<tr><td colspan="5" class="meta">Zatím nejsou žádní registrovaní uživatelé.</td></tr>';
    return;
  }

  for (const user of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><span class="role-pill role-${escapeHtml(user.role)}">${escapeHtml(user.role)}</span></td>
      <td><strong class="credits-cell">${escapeHtml(user.credits)}</strong></td>
      <td>
        <form class="topup-form" data-user-id="${escapeHtml(user.id)}">
          <input type="number" name="amount" min="1" max="100000" value="5" required aria-label="Počet kreditů" />
          <button type="submit">Dobít</button>
        </form>
      </td>
    `;
    usersBody.appendChild(tr);
  }
}

async function loadUsers() {
  clearFeedback();
  const data = await api('/api/admin/users');
  renderUsers(data.users || []);
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

    adminName.textContent = user.name || user.email;
    adminGate.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    await loadUsers();
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
    await loadUsers();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
});

refreshUsers.addEventListener('click', async () => {
  refreshUsers.disabled = true;
  try {
    await loadUsers();
    showMessage('Seznam byl obnoven.');
  } catch (err) {
    showError(err.message);
  } finally {
    refreshUsers.disabled = false;
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

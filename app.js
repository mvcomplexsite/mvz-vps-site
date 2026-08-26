(() => {
  'use strict';

  const cfg = window.MVZ_CONFIG || {};
  const API = String(cfg.API_BASE || '').replace(/\/$/, '');
  const BOT_USERNAME = cfg.BOT_USERNAME || 'mvzapretbot';
  const SESSION_KEY = 'mvz_site_session_v1';
  const SUPPORT_SID_KEY = 'mvz_site_support_sid_v1';

  const state = {
    session: localStorage.getItem(SESSION_KEY) || '',
    me: null,
    telegramMode: 'login',
    supportSince: 0,
    supportTimer: null,
    paymentTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const landingView = $('landingView');
  const dashboardView = $('dashboardView');
  const authError = $('authError');
  const logoutBtn = $('logoutBtn');
  const toast = $('toast');

  function showToast(message, ms = 3200) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function setAuthError(message = '') {
    authError.textContent = message;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function formatDate(value) {
    if (!value) return '—';
    const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).format(d);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
    if (state.session) headers.set('Authorization', `Bearer ${state.session}`);
    const response = await fetch(`${API}${path}`, { ...options, headers });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (response.status === 401 && state.session) {
      localStorage.removeItem(SESSION_KEY);
      state.session = '';
      state.me = null;
      showLoggedOut();
    }
    if (!response.ok) {
      const code = data?.error || `http_${response.status}`;
      const error = new Error(data?.message || code);
      error.code = code;
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function saveSession(token) {
    state.session = token || '';
    if (state.session) localStorage.setItem(SESSION_KEY, state.session);
    else localStorage.removeItem(SESSION_KEY);
  }

  function showLoggedOut() {
    landingView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    state.me = null;
    renderTelegramWidget('login');
  }

  function showLoggedIn() {
    landingView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
  }

  function renderTelegramWidget(mode) {
    state.telegramMode = mode;
    const target = mode === 'link' ? $('telegramLinkButton') : $('telegramLoginButton');
    if (!target) return;
    target.replaceChildren();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '12');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-request-access', 'write');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    target.appendChild(script);
  }

  window.onTelegramAuth = async (telegramUser) => {
    try {
      setAuthError('');
      if (state.telegramMode === 'link' && state.session) {
        const data = await api('/site-api/account/link-telegram', {
          method: 'POST', body: JSON.stringify({ telegram: telegramUser })
        });
        showToast(data?.merged ? 'Telegram подключён, данные объединены' : 'Telegram подключён');
        await loadDashboard();
      } else {
        const data = await api('/site-api/auth/telegram', {
          method: 'POST', body: JSON.stringify({ telegram: telegramUser })
        });
        saveSession(data.session);
        await loadDashboard();
        showToast('Вход через Telegram выполнен');
      }
    } catch (error) {
      const msg = humanError(error);
      if (state.telegramMode === 'login') setAuthError(msg);
      else showToast(msg, 5000);
    }
  };

  function humanError(error) {
    const map = {
      bad_email: 'Проверь email.',
      weak_password: 'Пароль должен быть не короче 8 символов.',
      email_exists: 'Аккаунт с таким email уже существует.',
      bad_credentials: 'Неверный email или пароль.',
      invalid_telegram_auth: 'Не удалось подтвердить вход через Telegram.',
      telegram_auth_expired: 'Авторизация Telegram устарела. Попробуй ещё раз.',
      payment_create_failed: 'Не удалось создать оплату. Попробуй позже.',
      session_required: 'Нужно войти в аккаунт.',
      users_telegram_id_not_nullable: 'Текущая схема базы не разрешает web-пользователей без Telegram. Нужна миграция users.telegram_id.',
      merge_failed: 'Не удалось безопасно объединить аккаунты. Данные не удалены — напиши в поддержку.'
    };
    return error?.data?.message || map[error?.code] || error?.message || 'Произошла ошибка.';
  }

  async function loadDashboard() {
    if (!state.session) return showLoggedOut();
    try {
      const data = await api('/site-api/me');
      state.me = data;
      showLoggedIn();
      renderDashboard(data);
      handlePaymentReturn();
    } catch (error) {
      if (error.status !== 401) showToast(humanError(error), 5000);
    }
  }

  function renderDashboard(data) {
    const account = data.account || {};
    const sub = data.subscription || {};
    const devices = data.devices || {};
    const tg = account.telegram || null;

    $('welcomeTitle').textContent = account.email || (tg?.username ? `@${tg.username}` : 'MVZ аккаунт');
    $('accountSubtitle').textContent = account.email && tg?.username
      ? `${account.email} • @${tg.username}`
      : (account.email || (tg ? `Telegram ID ${tg.id}` : 'Web-аккаунт'));

    const active = !!sub.active;
    $('subscriptionStatus').textContent = active ? 'Подписка активна' : 'Подписка не активна';
    $('subscriptionBadge').textContent = active ? 'АКТИВНА' : 'НЕ АКТИВНА';
    $('subscriptionBadge').classList.toggle('off', !active);
    $('subscriptionEnds').textContent = active ? `Доступ до ${formatDate(sub.endsAt)}` : 'Выбери тариф ниже. После оплаты ссылка появится здесь.';
    $('subscriptionActions').classList.toggle('hidden', !active || !sub.url);
    $('subscriptionLinkBox').classList.toggle('hidden', !active || !sub.url);
    $('subscriptionLink').textContent = sub.url || '';
    $('openV2RayBtn').href = sub.connectUrl || '#';

    if (tg?.id) {
      $('telegramState').textContent = tg.username ? `@${tg.username}` : `Telegram ${tg.id}`;
      $('telegramDescription').textContent = 'Telegram связан с этим же внутренним аккаунтом MVZ. Покупки, срок и устройства общие.';
      $('telegramLinkButton').classList.add('hidden');
      $('telegramUnlinkedHint').classList.remove('hidden');
    } else {
      $('telegramState').textContent = 'Не подключён';
      $('telegramDescription').textContent = 'Привяжи Telegram в любой момент. Если там уже был MVZ-профиль, сервер объединит данные и не выдаст повторный пробный период после web-покупки.';
      $('telegramLinkButton').classList.remove('hidden');
      $('telegramUnlinkedHint').classList.add('hidden');
      renderTelegramWidget('link');
    }

    $('deviceCount').textContent = `${devices.used || 0} / ${devices.limit || 3}`;
    renderDevices(devices.items || []);
    renderPlans(data.plans || []);
  }

  function renderDevices(items) {
    const root = $('devicesList');
    if (!items.length) {
      root.innerHTML = '<div class="empty-state">Пока устройств нет. После покупки добавь подписочную ссылку в VPN-клиент — устройство появится автоматически.</div>';
      return;
    }
    root.innerHTML = items.map((device) => {
      const active = device.status === 'active';
      const meta = [device.os, device.model, device.client, device.lastSeen ? `последний запрос: ${formatDate(device.lastSeen)}` : null].filter(Boolean);
      return `<div class="device-row">
        <div><div class="device-title">${escapeHtml(device.name || 'Устройство')}</div><div class="device-meta">${meta.map(x => `<span>${escapeHtml(x)}</span>`).join('<span>•</span>')}</div></div>
        <div class="device-actions">
          ${active ? `<button class="ghost" data-device-action="revoke" data-device-id="${Number(device.id)}">Отключить</button>` : `<button class="secondary" data-device-action="restore" data-device-id="${Number(device.id)}">Вернуть</button>`}
        </div>
      </div>`;
    }).join('');
  }

  function renderPlans(plans) {
    const root = $('plansGrid');
    root.innerHTML = plans.map((plan, index) => `<div class="plan ${index === 1 ? 'featured' : ''}">
      ${index === 1 ? '<span class="tag">ПОПУЛЯРНЫЙ</span>' : ''}
      <strong>${escapeHtml(plan.days)} дней</strong>
      <div class="price">${escapeHtml(plan.amount)} ₽</div>
      <div class="per">${plan.days ? Math.round((Number(plan.amount) / Number(plan.days)) * 100) / 100 : ''} ₽ / день</div>
      <button class="${index === 1 ? 'primary' : 'secondary'}" data-plan-code="${escapeHtml(plan.code)}">Купить</button>
    </div>`).join('');
  }

  async function startPayment(planCode) {
    try {
      const button = document.querySelector(`[data-plan-code="${CSS.escape(planCode)}"]`);
      if (button) { button.disabled = true; button.textContent = 'Создаём оплату…'; }
      const data = await api('/site-api/payment/create', { method: 'POST', body: JSON.stringify({ planCode }) });
      sessionStorage.setItem('mvz_pending_tx', data.transactionId || '');
      window.location.href = data.paymentUrl;
    } catch (error) {
      showToast(humanError(error), 5000);
      renderDashboard(state.me || {});
    }
  }

  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    const paymentState = params.get('payment');
    const tx = params.get('tx') || sessionStorage.getItem('mvz_pending_tx');
    if (!paymentState || !tx || !state.session) return;

    if (paymentState === 'failed') {
      showToast('Оплата не завершена.', 5000);
      cleanupPaymentQuery();
      return;
    }

    showToast('Проверяем оплату…', 5000);
    clearInterval(state.paymentTimer);
    let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const data = await api(`/site-api/payment/status?id=${encodeURIComponent(tx)}`);
        if (data.status === 'completed') {
          clearInterval(state.paymentTimer);
          sessionStorage.removeItem('mvz_pending_tx');
          cleanupPaymentQuery();
          showToast(`Готово: начислено ${data.days || ''} дней`, 5000);
          await loadDashboard();
          return;
        }
        if (['failed', 'canceled', 'cancelled', 'chargebacked', 'manual_review'].includes(String(data.status || '').toLowerCase())) {
          clearInterval(state.paymentTimer);
          cleanupPaymentQuery();
          showToast('Платёж требует проверки или не завершён.', 6000);
          return;
        }
      } catch (_) {}
      if (attempts >= 20) {
        clearInterval(state.paymentTimer);
        showToast('Платёж ещё обрабатывается. Статус можно обновить позже.', 6000);
      }
    };
    await check();
    state.paymentTimer = setInterval(check, 3000);
  }

  function cleanupPaymentQuery() {
    const url = new URL(location.href);
    url.searchParams.delete('payment');
    url.searchParams.delete('tx');
    history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }

  function getSupportSid() {
    let sid = localStorage.getItem(SUPPORT_SID_KEY);
    if (!sid || !/^[a-f0-9-]{30,64}$/i.test(sid)) {
      sid = crypto.randomUUID();
      localStorage.setItem(SUPPORT_SID_KEY, sid);
    }
    return sid;
  }

  async function loadSupportMessages() {
    try {
      const sid = getSupportSid();
      const data = await fetch(`${API}/site-api/support/messages?sid=${encodeURIComponent(sid)}&since=${state.supportSince}`).then(r => r.json());
      if (!data?.ok || !Array.isArray(data.messages)) return;
      const root = $('supportMessages');
      for (const message of data.messages) {
        state.supportSince = Math.max(state.supportSince, Number(message.id || 0));
        const div = document.createElement('div');
        div.className = `bubble ${message.author === 'support' ? 'support' : 'user'}`;
        div.innerHTML = `${escapeHtml(message.text)}<small>${escapeHtml(formatDate(message.created_at))}</small>`;
        root.appendChild(div);
      }
      if (data.messages.length) root.scrollTop = root.scrollHeight;
    } catch (_) {}
  }

  function openSupport() {
    const drawer = $('supportDrawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    state.supportSince = 0;
    $('supportMessages').replaceChildren();
    loadSupportMessages();
    clearInterval(state.supportTimer);
    state.supportTimer = setInterval(loadSupportMessages, Number(cfg.SUPPORT_POLL_MS || 3500));
  }

  function closeSupport() {
    $('supportDrawer').classList.remove('open');
    $('supportDrawer').setAttribute('aria-hidden', 'true');
    clearInterval(state.supportTimer);
  }

  document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('active', x === button));
    $('loginForm').classList.toggle('hidden', button.dataset.tab !== 'login');
    $('registerForm').classList.toggle('hidden', button.dataset.tab !== 'register');
    setAuthError('');
  }));

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault(); setAuthError('');
    try {
      const data = await api('/site-api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('loginEmail').value, password: $('loginPassword').value }) });
      saveSession(data.session); await loadDashboard(); showToast('Добро пожаловать');
    } catch (error) { setAuthError(humanError(error)); }
  });

  $('registerForm').addEventListener('submit', async (event) => {
    event.preventDefault(); setAuthError('');
    const password = $('registerPassword').value;
    if (password !== $('registerPassword2').value) return setAuthError('Пароли не совпадают.');
    try {
      const data = await api('/site-api/auth/register', { method: 'POST', body: JSON.stringify({ email: $('registerEmail').value, password }) });
      saveSession(data.session); await loadDashboard(); showToast('Аккаунт создан');
    } catch (error) { setAuthError(humanError(error)); }
  });

  logoutBtn.addEventListener('click', async () => {
    try { if (state.session) await api('/site-api/auth/logout', { method: 'POST' }); } catch (_) {}
    saveSession(''); showLoggedOut(); showToast('Вы вышли');
  });

  $('refreshDashboardBtn').addEventListener('click', loadDashboard);
  $('copySubscriptionBtn').addEventListener('click', async () => {
    const url = state.me?.subscription?.url;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    showToast('Ссылка скопирована');
  });
  $('rotateSubscriptionBtn').addEventListener('click', async () => {
    if (!confirm('Обновить личную ссылку? Старая останется рабочей ещё 15 минут.')) return;
    try { await api('/site-api/subscription/rotate', { method: 'POST' }); await loadDashboard(); showToast('Ссылка обновлена'); }
    catch (error) { showToast(humanError(error), 5000); }
  });

  $('plansGrid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-plan-code]');
    if (button) startPayment(button.dataset.planCode);
  });

  $('devicesList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-device-action]');
    if (!button) return;
    const deviceId = Number(button.dataset.deviceId || 0);
    const action = button.dataset.deviceAction;
    if (action === 'revoke' && !confirm('Отключить это устройство? Остальные устройства не изменятся.')) return;
    try {
      await api(`/site-api/devices/${action}`, { method: 'POST', body: JSON.stringify({ deviceId }) });
      await loadDashboard();
      showToast(action === 'revoke' ? 'Устройство отключено' : 'Устройство восстановлено');
    } catch (error) { showToast(humanError(error), 5000); }
  });

  $('supportTopBtn').addEventListener('click', openSupport);
  $('closeSupportBtn').addEventListener('click', closeSupport);
  $('supportDrawer').addEventListener('click', (event) => { if (event.target === $('supportDrawer')) closeSupport(); });
  $('supportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('supportInput');
    const text = input.value.trim();
    if (!text) return;
    const sid = getSupportSid();
    const source = state.me?.account?.id ? `website-account:${state.me.account.id}` : 'website-guest';
    try {
      const res = await fetch(`${API}/site-api/support/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, text, origin: source }) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'support_failed');
      input.value = '';
      await loadSupportMessages();
    } catch (_) { showToast('Не удалось отправить сообщение в поддержку.', 5000); }
  });

  if (state.session) loadDashboard(); else showLoggedOut();
})();

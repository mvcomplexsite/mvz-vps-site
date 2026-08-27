(() => {
  'use strict';

  const cfg = window.MVZ_CONFIG || {};
  const API = String(cfg.API_BASE || '').replace(/\/$/, '');
  const BOT_USERNAME = cfg.BOT_USERNAME || 'mvzapretbot';
  const SESSION_KEY = 'mvz_site_session_v1';
  const SUPPORT_SID_KEY = 'mvz_site_support_sid_v1';
  const SUPPORT_LAST_ACTIVE_KEY = 'mvz_site_support_last_active_v1';
  const SUPPORT_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function storageGet(key) {
    try { return localStorage.getItem(key) || sessionStorage.getItem(key) || ''; } catch (_) {
      try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; }
    }
  }

  function storageSet(key, value) {
    try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (_) {}
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (_) {}
  }

  const state = {
    session: storageGet(SESSION_KEY),
    me: null,
    supportSince: 0,
    supportTimer: null,
    supportLoading: false,
    supportSeen: new Set(),
    supportPendingId: '',
    supportPendingText: '',
    paymentTimer: null,
    paymentCreating: false,
    selectedPlan: null,
    dashboardLoading: false,
    telegramRenderSeq: 0
  };

  const $ = (id) => document.getElementById(id);
  const landingView = $('landingView');
  const dashboardView = $('dashboardView');
  const authError = $('authError');
  const logoutBtn = $('logoutBtn');
  const toast = $('toast');

  function showToast(message, ms = 3300) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function setAuthError(message = '') { authError.textContent = message; }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
    })[char]);
  }

  function formatDate(value, withTime = false) {
    if (!value) return '—';
    const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat('ru-RU', withTime
      ? { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }
      : { day:'2-digit', month:'long', year:'numeric' }).format(d);
  }

  function daysLeft(value) {
    if (!value) return 0;
    const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
    const ts = Date.parse(normalized);
    return Number.isFinite(ts) ? Math.max(0, Math.ceil((ts - Date.now()) / 86400000)) : 0;
  }

  async function api(path, options = {}) {
    const { timeoutMs = 18000, ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers || {});
    if (!headers.has('Content-Type') && fetchOptions.body) headers.set('Content-Type', 'application/json');
    if (state.session) headers.set('Authorization', `Bearer ${state.session}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 18000));
    let response;
    try {
      response = await fetch(`${API}${path}`, { ...fetchOptions, headers, signal: fetchOptions.signal || controller.signal });
    } catch (cause) {
      const code = cause?.name === 'AbortError' ? 'request_timeout' : 'network_error';
      throw Object.assign(new Error(code), { code, cause });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const code = data?.error || `http_${response.status}`;
      const error = Object.assign(new Error(data?.message || code), { code, status: response.status, data });
      throw error;
    }
    return data;
  }

  function saveSession(token) {
    state.session = token || '';
    storageSet(SESSION_KEY, state.session);
  }

  function showLoggedOut() {
    landingView.classList.remove('hidden'); dashboardView.classList.add('hidden'); logoutBtn.classList.add('hidden'); state.me = null;
    setupLazyTelegramLogin();
  }

  function showLoggedIn() {
    landingView.classList.add('hidden'); dashboardView.classList.remove('hidden'); logoutBtn.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderTelegramWidget(mode, attempt = 0) {
    const target = mode === 'link' ? $('telegramLinkButton') : $('telegramLoginButton');
    if (!target || target.classList.contains('hidden')) return;
    const seq = ++state.telegramRenderSeq;
    target.replaceChildren();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '12');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-onauth', mode === 'link' ? 'onTelegramAuthLink(user)' : 'onTelegramAuthLogin(user)');
    target.appendChild(script);

    if (mode === 'link' && attempt < 2) {
      setTimeout(() => {
        if (seq !== state.telegramRenderSeq || target.classList.contains('hidden')) return;
        if (!target.querySelector('iframe')) renderTelegramWidget(mode, attempt + 1);
      }, 900 + attempt * 900);
    }
  }

  let telegramLoginObserver = null;
  function setupLazyTelegramLogin() {
    const target = $('telegramLoginButton');
    if (!target || target.dataset.widgetReady === '1') return;
    const load = () => {
      if (target.dataset.widgetReady === '1' || state.session) return;
      target.dataset.widgetReady = '1';
      renderTelegramWidget('login');
    };
    if ('IntersectionObserver' in window) {
      telegramLoginObserver?.disconnect();
      telegramLoginObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { telegramLoginObserver.disconnect(); load(); }
      }, { rootMargin: '250px' });
      telegramLoginObserver.observe($('auth'));
    } else {
      setTimeout(load, 800);
    }
  }

  async function handleTelegramAuth(telegramUser, mode) {
    try {
      setAuthError('');
      showToast(mode === 'link' ? 'Подключаем Telegram…' : 'Входим через Telegram…', 6000);
      if (mode === 'link' && state.session) {
        const data = await api('/site-api/account/link-telegram', { method:'POST', body:JSON.stringify({ telegram: telegramUser }), timeoutMs: 20000 });
        showToast(data?.merged ? 'Telegram подключён — данные объединены' : 'Telegram подключён');
        await loadDashboard();
      } else {
        const data = await api('/site-api/auth/telegram', { method:'POST', body:JSON.stringify({ telegram: telegramUser }), timeoutMs: 20000 });
        saveSession(data.session); await loadDashboard(); showToast('Вход через Telegram выполнен');
      }
    } catch (error) {
      const msg = humanError(error);
      if (mode === 'login') setAuthError(msg); else showToast(msg, 5200);
    }
  }

  window.onTelegramAuthLogin = (telegramUser) => handleTelegramAuth(telegramUser, 'login');
  window.onTelegramAuthLink = (telegramUser) => handleTelegramAuth(telegramUser, 'link');

  function humanError(error) {
    const map = {
      bad_email:'Проверь email.', weak_password:'Пароль должен быть от 8 до 128 символов.', email_exists:'Этот email уже используется.',
      bad_credentials:'Неверный email или пароль.', invalid_telegram_auth:'Не удалось подтвердить вход через Telegram.', telegram_auth_expired:'Авторизация Telegram устарела. Попробуй ещё раз.',
      payment_create_failed:'Не удалось создать оплату. Попробуй позже.', session_required:'Нужно войти в аккаунт.', users_telegram_id_not_nullable:'В базе нужно разрешить web-пользователей без Telegram.',
      merge_failed:'Не удалось безопасно объединить аккаунты. Напиши в поддержку — данные не удалены.', current_password_required:'Для изменения существующего пароля нужен текущий пароль.',
      bad_current_password:'Текущий пароль неверный.', subscription_inactive:'Сначала активируй подписку.', device_limit:'Достигнут лимит устройств.',
      network_error:'Нет связи с сервером. Сессия сохранена — попробуй ещё раз.', request_timeout:'Сервер отвечает дольше обычного. Сессия сохранена — повтори попытку.'
    };
    return error?.data?.message || map[error?.code] || error?.message || 'Произошла ошибка.';
  }

  async function checkWorkerStatus() {
    const dot = $('workerDot'); const text = $('workerStatus');
    try {
      const response = await fetch(`${API}/site-api/status`, { cache:'no-store' });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error('offline');
      dot.className = 'dot online'; text.textContent = 'Система MVZ VPS работает';
    } catch (_) {
      dot.className = 'dot offline'; text.textContent = 'Worker временно недоступен';
    }
  }

  async function loadDashboard() {
    if (!state.session) return showLoggedOut();
    if (state.dashboardLoading) return;
    state.dashboardLoading = true;
    let lastError = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const data = await api('/site-api/me', { timeoutMs: 15000 });
          state.me = data; showLoggedIn(); renderDashboard(data); await handlePaymentReturn();
          return;
        } catch (error) {
          lastError = error;
          const retryable = error?.status === 401 || error?.code === 'network_error' || error?.code === 'request_timeout' || Number(error?.status || 0) >= 500;
          if (!retryable || attempt >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 450 + attempt * 650));
        }
      }

      if (lastError?.status === 401) {
        saveSession('');
        showLoggedOut();
        setAuthError('Сессия закончилась. Войди снова.');
      } else if (lastError) {
        showToast(humanError(lastError), 6000);
      }
    } finally {
      state.dashboardLoading = false;
    }
  }

  function renderDashboard(data) {
    const account = data.account || {}; const sub = data.subscription || {}; const devices = data.devices || {}; const tg = account.telegram || null;
    $('welcomeTitle').textContent = account.email || (tg?.username ? `@${tg.username}` : 'Аккаунт MVZ VPS');
    $('accountSubtitle').textContent = account.email && tg?.username ? `${account.email} • @${tg.username}` : (account.email || (tg ? `Telegram ${tg.id}` : 'Web-аккаунт'));

    const active = !!sub.active;
    $('subscriptionStatus').textContent = active ? 'Подписка активна' : 'Подписка не активна';
    $('subscriptionBadge').textContent = active ? 'АКТИВНА' : 'НЕ АКТИВНА'; $('subscriptionBadge').classList.toggle('off', !active);
    $('subscriptionEnds').textContent = active ? `Доступ до ${formatDate(sub.endsAt)} • осталось примерно ${daysLeft(sub.endsAt)} дн.` : 'Выбери тариф ниже. После оплаты ссылка появится здесь автоматически.';
    $('subscriptionActions').classList.toggle('hidden', !active || !sub.url); $('subscriptionLinkBox').classList.toggle('hidden', !active || !sub.url);
    $('subscriptionLink').textContent = sub.url || ''; $('openV2RayBtn').href = sub.connectUrl || '#';
    $('summarySubscription').textContent = active ? `${daysLeft(sub.endsAt)} дн.` : 'Не активна'; $('summarySubscriptionSub').textContent = active ? `до ${formatDate(sub.endsAt)}` : 'нужна покупка';

    if (tg?.id) {
      $('telegramState').textContent = tg.username ? `@${tg.username}` : `Telegram ${tg.id}`;
      $('telegramDescription').textContent = 'Telegram связан с этим же аккаунтом MVZ VPS. Срок, покупки и устройства общие.';
      $('telegramLinkButton').classList.add('hidden'); $('telegramUnlinkedHint').classList.remove('hidden'); $('summaryTelegram').textContent = tg.username ? `@${tg.username}` : 'Подключён';
    } else {
      $('telegramState').textContent = 'Не подключён';
      $('telegramDescription').textContent = 'Можно привязать Telegram позже. Если там уже есть профиль MVZ VPS, сервер объединит данные и не создаст второй оплаченный аккаунт.';
      $('telegramLinkButton').classList.remove('hidden'); $('telegramUnlinkedHint').classList.add('hidden'); $('summaryTelegram').textContent = 'Не подключён';
      requestAnimationFrame(() => renderTelegramWidget('link'));
    }

    $('deviceCount').textContent = `${devices.used || 0} / ${devices.limit || 3}`; $('summaryDevices').textContent = `${devices.used || 0} / ${devices.limit || 3}`;
    renderDevices(devices.items || []); renderPlans(data.plans || []);

    const credentialsReady = !!account.email && !!account.hasPassword;
    $('credentialsCard').classList.toggle('hidden', credentialsReady);
    $('credentialsReadyCard').classList.toggle('hidden', !credentialsReady);
    if (credentialsReady) $('credentialsEmailReady').textContent = account.email;
    else if (account.email) $('credentialsEmail').value = account.email;
  }

  function renderDevices(items) {
    const root = $('devicesList');
    if (!items.length) {
      root.innerHTML = '<div class="empty-state">Пока устройств нет. После покупки добавь подписочную ссылку в совместимый клиент и обнови подписку — устройство появится автоматически.</div>'; return;
    }
    root.innerHTML = items.map((device) => {
      const active = device.status === 'active';
      const meta = [device.os, device.model, device.client, device.lastSeen ? `последний запрос: ${formatDate(device.lastSeen, true)}` : null].filter(Boolean);
      return `<div class="device-row"><div><div class="device-title">${escapeHtml(device.name || 'Устройство')}</div><div class="device-meta">${meta.map(x => `<span>${escapeHtml(x)}</span>`).join('<span>•</span>')}</div></div><div class="device-actions">${active ? `<button class="ghost" data-device-action="revoke" data-device-id="${Number(device.id)}">Отключить</button>` : `<button class="secondary" data-device-action="restore" data-device-id="${Number(device.id)}">Вернуть</button>`}</div></div>`;
    }).join('');
  }

  function renderPlans(plans) {
    $('plansGrid').innerHTML = plans.map((plan, index) => `<div class="plan ${index === 1 ? 'featured' : ''}">${index === 1 ? '<span class="tag">ПОПУЛЯРНЫЙ</span>' : ''}<strong>${escapeHtml(plan.days)} дней</strong><div class="price">${escapeHtml(plan.amount)} ₽</div><div class="per">${plan.days ? Math.round((Number(plan.amount) / Number(plan.days)) * 100) / 100 : ''} ₽ / день</div><button class="${index === 1 ? 'primary' : 'secondary'}" data-plan-code="${escapeHtml(plan.code)}">Купить</button></div>`).join('');
  }

  async function startPayment(planCode) {
    if (state.paymentCreating) return;
    state.paymentCreating = true;
    const buttons = [...document.querySelectorAll('[data-plan-code], [data-public-plan]')];
    buttons.forEach((button) => { button.disabled = true; });
    const selected = document.querySelector(`[data-plan-code="${CSS.escape(planCode)}"]`);
    const oldText = selected?.textContent || '';
    if (selected) selected.textContent = 'Создаём оплату…';
    showToast('Подготавливаем страницу оплаты…', 8000);
    try {
      const data = await api('/site-api/payment/create', { method:'POST', body:JSON.stringify({ planCode }), timeoutMs: 25000 });
      sessionStorage.setItem('mvz_pending_tx', data.transactionId || '');
      window.location.assign(data.paymentUrl);
    } catch (error) {
      showToast(humanError(error), 6000);
      if (selected && oldText) selected.textContent = oldText;
      buttons.forEach((button) => { button.disabled = false; });
      state.paymentCreating = false;
    }
  }

  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search); const paymentState = params.get('payment'); const tx = params.get('tx') || sessionStorage.getItem('mvz_pending_tx');
    if (!paymentState || !tx || !state.session) return;
    if (paymentState === 'failed') { showToast('Оплата не завершена.', 5000); cleanupPaymentQuery(); return; }
    showToast('Проверяем оплату…', 5000); clearInterval(state.paymentTimer); let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const data = await api(`/site-api/payment/status?id=${encodeURIComponent(tx)}`);
        if (data.status === 'completed') { clearInterval(state.paymentTimer); sessionStorage.removeItem('mvz_pending_tx'); cleanupPaymentQuery(); showToast(`Готово: начислено ${data.days || ''} дней`, 5000); await loadDashboard(); return; }
        if (['failed','canceled','cancelled','chargebacked','manual_review'].includes(String(data.status || '').toLowerCase())) { clearInterval(state.paymentTimer); cleanupPaymentQuery(); showToast('Платёж не завершён или требует проверки.', 6000); return; }
      } catch (_) {}
      if (attempts >= 20) { clearInterval(state.paymentTimer); showToast('Платёж ещё обрабатывается. Нажми «Обновить» через минуту.', 6000); }
    };
    await check(); if (attempts < 20) state.paymentTimer = setInterval(check, 3000);
  }

  function cleanupPaymentQuery() {
    const url = new URL(location.href); url.searchParams.delete('payment'); url.searchParams.delete('tx'); history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  function getSupportSid() {
    let sid = storageGet(SUPPORT_SID_KEY);
    const lastActive = Number(storageGet(SUPPORT_LAST_ACTIVE_KEY) || 0);
    if (lastActive && Date.now() - lastActive > SUPPORT_HISTORY_TTL_MS) sid = '';
    if (!sid || !/^[a-f0-9-]{30,64}$/i.test(sid)) {
      sid = crypto.randomUUID();
      storageSet(SUPPORT_SID_KEY, sid);
      state.supportSince = 0;
      state.supportSeen.clear();
    }
    storageSet(SUPPORT_LAST_ACTIVE_KEY, String(Date.now()));
    return sid;
  }

  async function loadSupportMessages() {
    if (state.supportLoading) return;
    state.supportLoading = true;
    try {
      const sid = getSupportSid();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let response;
      try {
        response = await fetch(`${API}/site-api/support/messages?sid=${encodeURIComponent(sid)}&since=${state.supportSince}`, { cache:'no-store', signal:controller.signal });
      } finally { clearTimeout(timer); }
      const data = await response.json();
      if (!response.ok || !data?.ok || !Array.isArray(data.messages)) return;
      const root = $('supportMessages');
      if (state.supportSince === 0) { root.replaceChildren(); state.supportSeen.clear(); }
      const fragment = document.createDocumentFragment();
      for (const message of data.messages) {
        const id = Number(message.id || 0);
        if (!id || state.supportSeen.has(id)) continue;
        state.supportSeen.add(id);
        state.supportSince = Math.max(state.supportSince, id);
        const div = document.createElement('div'); div.className = `bubble ${message.author === 'support' ? 'support' : 'user'}`;
        div.dataset.messageId = String(id);
        div.innerHTML = `${escapeHtml(message.text)}<small>${escapeHtml(formatDate(message.created_at, true))}</small>`;
        fragment.appendChild(div);
      }
      root.appendChild(fragment);
      if (!root.children.length) root.innerHTML = '<div class="support-welcome">Опиши проблему. История хранится до 30 дней, показываем последние сообщения.</div>';
      if (data.messages.length) root.scrollTop = root.scrollHeight;
    } catch (_) {
      // Поддержка не должна тормозить остальной сайт при временной проблеме сети.
    } finally {
      state.supportLoading = false;
    }
  }

  function openSupport() {
    const drawer = $('supportDrawer');
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    state.supportSince = 0; state.supportSeen.clear(); $('supportMessages').replaceChildren();
    loadSupportMessages();
    clearInterval(state.supportTimer);
    state.supportTimer = setInterval(loadSupportMessages, Math.max(4500, Number(cfg.SUPPORT_POLL_MS || 5000)));
  }
  function closeSupport() { $('supportDrawer').classList.remove('open'); $('supportDrawer').setAttribute('aria-hidden','true'); clearInterval(state.supportTimer); state.supportTimer = null; }

  function openAuthForPlan(planCode) {
    state.selectedPlan = planCode;
    const registerTab = document.querySelector('.auth-tab[data-tab="register"]'); if (registerTab) registerTab.click();
    $('auth').scrollIntoView({ behavior:'smooth', block:'start' }); showToast('Войди или зарегистрируйся — выбранный тариф будет доступен в кабинете.', 4800);
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return Promise.resolve();
  }

  document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(x => x.classList.toggle('active', x === button)); $('loginForm').classList.toggle('hidden', button.dataset.tab !== 'login'); $('registerForm').classList.toggle('hidden', button.dataset.tab !== 'register'); setAuthError('');
  }));

  $('loginForm').addEventListener('submit', async (event) => { event.preventDefault(); setAuthError(''); try { const data = await api('/site-api/auth/login', { method:'POST', body:JSON.stringify({ email:$('loginEmail').value, password:$('loginPassword').value }) }); saveSession(data.session); await loadDashboard(); showToast('Добро пожаловать'); } catch (error) { setAuthError(humanError(error)); } });
  $('registerForm').addEventListener('submit', async (event) => { event.preventDefault(); setAuthError(''); const password = $('registerPassword').value; if (password !== $('registerPassword2').value) return setAuthError('Пароли не совпадают.'); try { const data = await api('/site-api/auth/register', { method:'POST', body:JSON.stringify({ email:$('registerEmail').value, password }) }); saveSession(data.session); await loadDashboard(); showToast('Аккаунт создан — выбери тариф'); } catch (error) { setAuthError(humanError(error)); } });
  $('credentialsForm').addEventListener('submit', async (event) => { event.preventDefault(); const email=$('credentialsEmail').value.trim(); const password=$('credentialsPassword').value; if (password !== $('credentialsPassword2').value) return showToast('Пароли не совпадают.', 4500); try { await api('/site-api/account/credentials', { method:'POST', body:JSON.stringify({ email, password }) }); $('credentialsPassword').value=''; $('credentialsPassword2').value=''; await loadDashboard(); showToast('Резервный вход настроен'); } catch (error) { showToast(humanError(error), 5200); } });

  logoutBtn.addEventListener('click', async () => { try { if (state.session) await api('/site-api/auth/logout', { method:'POST' }); } catch (_) {} saveSession(''); showLoggedOut(); showToast('Вы вышли'); });
  $('refreshDashboardBtn').addEventListener('click', loadDashboard);
  $('copySubscriptionBtn').addEventListener('click', async () => { const url = state.me?.subscription?.url; if (!url) return; await copyText(url); showToast('Ссылка скопирована'); });
  $('rotateSubscriptionBtn').addEventListener('click', async () => { if (!confirm('Обновить личную ссылку? Старая останется рабочей ещё 15 минут.')) return; try { await api('/site-api/subscription/rotate', { method:'POST' }); await loadDashboard(); showToast('Ссылка обновлена'); } catch (error) { showToast(humanError(error), 5000); } });
  $('plansGrid').addEventListener('click', (event) => { const button = event.target.closest('[data-plan-code]'); if (button) startPayment(button.dataset.planCode); });
  document.querySelectorAll('[data-public-plan]').forEach((button) => button.addEventListener('click', () => state.session ? startPayment(button.dataset.publicPlan) : openAuthForPlan(button.dataset.publicPlan)));
  $('devicesList').addEventListener('click', async (event) => { const button = event.target.closest('[data-device-action]'); if (!button) return; const deviceId=Number(button.dataset.deviceId||0); const action=button.dataset.deviceAction; if (action === 'revoke' && !confirm('Отключить это устройство? Остальные устройства не изменятся.')) return; try { await api(`/site-api/devices/${action}`, { method:'POST', body:JSON.stringify({ deviceId }) }); await loadDashboard(); showToast(action === 'revoke' ? 'Устройство отключено' : 'Устройство восстановлено'); } catch (error) { showToast(humanError(error), 5000); } });

  ['supportTopBtn','supportDashboardBtn','supportFooterBtn'].forEach((id) => $(id)?.addEventListener('click', openSupport));
  $('closeSupportBtn').addEventListener('click', closeSupport); $('supportDrawer').addEventListener('click', (event) => { if (event.target === $('supportDrawer')) closeSupport(); });
  $('supportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('supportInput'); const text = input.value.trim(); if (!text) return;
    const sid = getSupportSid();
    const source = state.me?.account?.id ? `website-account:${state.me.account.id}` : 'website-guest';
    const submit = event.submitter; if (submit) submit.disabled = true;
    if (!state.supportPendingId || state.supportPendingText !== text) {
      state.supportPendingId = crypto.randomUUID(); state.supportPendingText = text;
    }
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(`${API}/site-api/support/message`, { method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal, body:JSON.stringify({ sid, text, origin:source, clientMessageId:state.supportPendingId }) });
      } finally { clearTimeout(timer); }
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'support_failed');
      input.value = ''; state.supportPendingId = ''; state.supportPendingText = ''; storageSet(SUPPORT_LAST_ACTIVE_KEY, String(Date.now()));
      setTimeout(loadSupportMessages, 80);
      showToast('Сообщение отправлено в поддержку');
    } catch (_) {
      showToast('Не удалось отправить сообщение. Повтори — дубля не будет.', 5500);
    } finally { if (submit) submit.disabled = false; }
  });

  const guide = $('guideDialog');
  $('openGuideBtn').addEventListener('click', () => guide.showModal()); $('dashboardGuideBtn')?.addEventListener('click', () => guide.showModal()); $('closeGuideBtn').addEventListener('click', () => guide.close()); $('guideSupportBtn').addEventListener('click', () => { guide.close(); openSupport(); }); $('supportConnectBtn')?.addEventListener('click', openSupport);
  $('menuButton').addEventListener('click', () => document.querySelector('.nav-links').classList.toggle('open'));
  document.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => document.querySelector('.nav-links').classList.remove('open')));

  if (state.session) {
    loadDashboard();
  } else {
    showLoggedOut();
    setTimeout(checkWorkerStatus, 250);
  }
})();

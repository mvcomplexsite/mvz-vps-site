/*
 * MVZ Website API v1
 * ВСТАВИТЬ В ТОТ ЖЕ Cloudflare Worker, где находится текущий код бота,
 * перед `export default { ... }`.
 *
 * Модуль специально использует существующие функции/константы бота:
 * preparePaymentSchema, prepareTrialAccessSchema, prepareSubscriptionLinkSchema,
 * prepareSubscriptionDeviceSchema, ensureBaseSubscriptionRow, ensureUserRefCode,
 * getUserRow, findUserIdByTelegramId, upsertUser, getEffectiveSubscriptionAccess,
 * buildClientSubUrl, buildV2RayTunOpenUrl, getSubscriptionDeviceLimit,
 * getSubscriptionDeviceUserPolicy, getUserSubscriptionDevices,
 * revokeSubscriptionDevice, restoreSubscriptionDevice, rotateUserSubscriptionLink,
 * getPaymentPlanByCode, PAYMENT_PLANS, plategaApi, upsertPaymentCheck,
 * getPaymentCheckByDonationId, finalizeConfirmedPlategaPayment, getWorkerBaseUrl,
 * normalizeUsername, parseSqlDateToTs, formatTsToSql, SITE_URL, BOT_USERNAME.
 */

const SITE_ACCOUNT_SESSION_DAYS = 30;
const SITE_PASSWORD_ITERATIONS = 120000;
const SITE_TELEGRAM_AUTH_MAX_AGE_SEC = 10 * 60;
const SITE_ACCOUNT_MAX_EMAIL_LEN = 190;

function siteApiCorsHeaders(origin) {
  const allowedOrigin = SITE_SUPPORT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

function siteApiJson(data, status = 200, origin = SITE_SUPPORT_ORIGIN) {
  return new Response(JSON.stringify(data), { status, headers: siteApiCorsHeaders(origin) });
}

function siteApiError(error, status = 400, message = null, origin = SITE_SUPPORT_ORIGIN, extra = {}) {
  return siteApiJson({ ok: false, error, ...(message ? { message } : {}), ...extra }, status, origin);
}

async function siteReadJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}

function siteNormalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, SITE_ACCOUNT_MAX_EMAIL_LEN);
}

function siteValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function siteValidPassword(password) {
  const value = String(password || '');
  return value.length >= 8 && value.length <= 128;
}

function siteBytesToBase64Url(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function siteBase64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function siteBytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function siteSha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || ''))));
}

async function siteSha256Hex(value) {
  return siteBytesToHex(await siteSha256Bytes(value));
}

function siteRandomToken(bytes = 32) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return siteBytesToBase64Url(raw);
}

async function siteHashPassword(password, saltBase64Url = null, iterations = SITE_PASSWORD_ITERATIONS) {
  const salt = saltBase64Url ? siteBase64UrlToBytes(saltBase64Url) : (() => {
    const raw = new Uint8Array(16); crypto.getRandomValues(raw); return raw;
  })();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password || '')), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256
  );
  return { hash: siteBytesToBase64Url(new Uint8Array(bits)), salt: siteBytesToBase64Url(salt), iterations };
}

function siteConstantTimeTextEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function prepareSiteAccountSchema(env) {
  await prepareTrialAccessSchema(env);
  await prepareSubscriptionLinkSchema(env);
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      password_iterations INTEGER DEFAULT ${SITE_PASSWORD_ITERATIONS},
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_site_sessions_account ON site_sessions(account_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_site_sessions_expires ON site_sessions(expires_at)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_account_merge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_user_id INTEGER NOT NULL,
      telegram_user_id INTEGER NOT NULL,
      telegram_id TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    )
  `).run();
  try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN merged_into_user_id INTEGER`).run(); } catch (_) {}
  try { await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_merged_into ON users(merged_into_user_id)`).run(); } catch (_) {}
}

async function siteGetAccountById(accountId, env) {
  await prepareSiteAccountSchema(env);
  return await env.DB.prepare(`SELECT * FROM site_accounts WHERE id = ? AND status = 'active' LIMIT 1`).bind(Number(accountId)).first();
}

async function siteGetAccountByEmail(email, env) {
  await prepareSiteAccountSchema(env);
  return await env.DB.prepare(`SELECT * FROM site_accounts WHERE email = ? AND status = 'active' LIMIT 1`).bind(siteNormalizeEmail(email)).first();
}

async function siteGetAccountByUserId(userId, env) {
  await prepareSiteAccountSchema(env);
  return await env.DB.prepare(`SELECT * FROM site_accounts WHERE user_id = ? AND status = 'active' LIMIT 1`).bind(Number(userId)).first();
}

async function siteCreateSession(accountId, env) {
  await prepareSiteAccountSchema(env);
  const token = siteRandomToken(32);
  const tokenHash = await siteSha256Hex(token);
  const expiresAt = formatTsToSql(Date.now() + SITE_ACCOUNT_SESSION_DAYS * 24 * 60 * 60 * 1000);
  await env.DB.prepare(`
    INSERT INTO site_sessions (token_hash, account_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(tokenHash, Number(accountId), expiresAt).run();
  await env.DB.prepare(`UPDATE site_accounts SET last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(Number(accountId)).run();
  return { token, expiresAt };
}

function siteBearerToken(request) {
  const raw = String(request.headers.get('Authorization') || '').trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function siteRequireSession(request, env) {
  const token = siteBearerToken(request);
  if (!token) return null;
  const tokenHash = await siteSha256Hex(token);
  await prepareSiteAccountSchema(env);
  const row = await env.DB.prepare(`
    SELECT s.token_hash, s.account_id, s.expires_at, a.*
    FROM site_sessions s
    JOIN site_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?
      AND a.status = 'active'
      AND datetime(s.expires_at) > datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();
  if (!row?.account_id) return null;
  await env.DB.prepare(`UPDATE site_sessions SET last_seen_at = datetime('now') WHERE token_hash = ?`).bind(tokenHash).run();
  return { tokenHash, account: row };
}

async function siteDeleteSession(request, env) {
  const token = siteBearerToken(request);
  if (!token) return;
  await prepareSiteAccountSchema(env);
  await env.DB.prepare(`DELETE FROM site_sessions WHERE token_hash = ?`).bind(await siteSha256Hex(token)).run();
}

async function siteCreateBaseUser(env) {
  await prepareSiteAccountSchema(env);
  const now = new Date().toISOString();
  try {
    const row = await env.DB.prepare(`
      INSERT INTO users (
        telegram_id, username, first_name, first_seen_at, last_seen_at,
        free_access_activated, new_user_trial_granted, april_2026_migration_bonus_granted
      ) VALUES (NULL, NULL, 'MVZ Web', ?, ?, 0, 0, 0)
      RETURNING id
    `).bind(now, now).first();
    if (!row?.id) throw new Error('site user insert returned no id');
    await ensureBaseSubscriptionRow(row.id, env);
    await ensureUserRefCode(row.id, env);
    await getCurrentUserSubToken(row.id, env);
    return Number(row.id);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (/not null.*telegram_id|telegram_id.*not null/i.test(message)) {
      const e = new Error('users_telegram_id_not_nullable'); e.code = 'users_telegram_id_not_nullable'; throw e;
    }
    throw error;
  }
}

async function siteRegister(request, env, origin) {
  const body = await siteReadJson(request);
  if (!body) return siteApiError('bad_json', 400, null, origin);
  const email = siteNormalizeEmail(body.email);
  const password = String(body.password || '');
  if (!siteValidEmail(email)) return siteApiError('bad_email', 400, null, origin);
  if (!siteValidPassword(password)) return siteApiError('weak_password', 400, null, origin);
  if (await siteGetAccountByEmail(email, env)) return siteApiError('email_exists', 409, null, origin);

  let userId;
  try { userId = await siteCreateBaseUser(env); }
  catch (error) {
    if (error?.code === 'users_telegram_id_not_nullable') return siteApiError(error.code, 500, null, origin);
    console.error('site registration base user failed', error?.stack || error?.message || String(error));
    return siteApiError('registration_failed', 500, null, origin);
  }

  const passwordData = await siteHashPassword(password);
  try {
    const account = await env.DB.prepare(`
      INSERT INTO site_accounts (user_id, email, password_hash, password_salt, password_iterations)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `).bind(userId, email, passwordData.hash, passwordData.salt, passwordData.iterations).first();
    const session = await siteCreateSession(account.id, env);
    return siteApiJson({ ok: true, session: session.token, expiresAt: session.expiresAt }, 201, origin);
  } catch (error) {
    console.error('site registration account failed', error?.stack || error?.message || String(error));
    return siteApiError('registration_failed', 500, null, origin);
  }
}

async function siteLogin(request, env, origin) {
  const body = await siteReadJson(request);
  if (!body) return siteApiError('bad_json', 400, null, origin);
  const account = await siteGetAccountByEmail(body.email, env);
  if (!account?.id || !account.password_hash || !account.password_salt) return siteApiError('bad_credentials', 401, null, origin);
  const passwordData = await siteHashPassword(String(body.password || ''), account.password_salt, Number(account.password_iterations || SITE_PASSWORD_ITERATIONS));
  if (!siteConstantTimeTextEqual(passwordData.hash, account.password_hash)) return siteApiError('bad_credentials', 401, null, origin);
  const session = await siteCreateSession(account.id, env);
  return siteApiJson({ ok: true, session: session.token, expiresAt: session.expiresAt }, 200, origin);
}

async function siteVerifyTelegramWidgetAuth(raw, env) {
  const data = raw && typeof raw === 'object' ? { ...raw } : null;
  if (!data?.id || !data?.hash || !data?.auth_date || !env.BOT_TOKEN) return { ok: false, reason: 'invalid_telegram_auth' };
  const authDate = Number(data.auth_date || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(nowSec - authDate) > SITE_TELEGRAM_AUTH_MAX_AGE_SEC) return { ok: false, reason: 'telegram_auth_expired' };

  const receivedHash = String(data.hash || '').toLowerCase();
  delete data.hash;
  const checkString = Object.keys(data)
    .filter((key) => data[key] !== undefined && data[key] !== null)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('\n');
  const secretKey = await siteSha256Bytes(String(env.BOT_TOKEN));
  const hmacKey = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(checkString));
  const calculatedHash = siteBytesToHex(new Uint8Array(signature));
  if (!siteConstantTimeTextEqual(calculatedHash, receivedHash)) return { ok: false, reason: 'invalid_telegram_auth' };
  return {
    ok: true,
    user: {
      id: String(data.id),
      username: normalizeUsername(data.username || ''),
      first_name: String(data.first_name || '').slice(0, 128),
      last_name: String(data.last_name || '').slice(0, 128),
      photo_url: String(data.photo_url || '').slice(0, 500)
    }
  };
}

async function siteEnsureAccountForTelegramUser(tg, env) {
  let userId = await findUserIdByTelegramId(tg.id, env);
  if (!userId) {
    userId = await upsertUser({ id: tg.id, username: tg.username || null, first_name: tg.first_name || null }, env);
    await ensureBaseSubscriptionRow(userId, env);
    await ensureUserRefCode(userId, env);
  } else {
    await env.DB.prepare(`
      UPDATE users SET username = ?, first_name = ?, last_seen_at = ? WHERE id = ?
    `).bind(tg.username || null, tg.first_name || null, new Date().toISOString(), userId).run();
  }
  await prepareSiteAccountSchema(env);
  let account = await siteGetAccountByUserId(userId, env);
  if (!account?.id) {
    account = await env.DB.prepare(`
      INSERT INTO site_accounts (user_id, email, password_hash, password_salt)
      VALUES (?, NULL, NULL, NULL)
      RETURNING *
    `).bind(userId).first();
  }
  return account;
}

async function siteTelegramLogin(request, env, origin) {
  const body = await siteReadJson(request);
  const verified = await siteVerifyTelegramWidgetAuth(body?.telegram, env);
  if (!verified.ok) return siteApiError(verified.reason, 401, null, origin);
  const account = await siteEnsureAccountForTelegramUser(verified.user, env);
  const session = await siteCreateSession(account.id, env);
  return siteApiJson({ ok: true, session: session.token, expiresAt: session.expiresAt }, 200, origin);
}

async function siteUserHasWebsitePurchase(userId, env) {
  await preparePaymentSchema(env);
  const row = await env.DB.prepare(`
    SELECT id FROM payment_checks
    WHERE user_id = ? AND status = 'completed'
      AND (message LIKE '%"source":"website"%' OR raw_payload LIKE '%"source":"website"%')
    LIMIT 1
  `).bind(Number(userId)).first();
  return !!row?.id;
}

async function markSitePaidUserAsNonTrial(userId, env) {
  await prepareTrialAccessSchema(env);
  await env.DB.prepare(`
    UPDATE users
    SET free_access_activated = 1,
        new_user_trial_granted = 1
    WHERE id = ?
  `).bind(Number(userId)).run();
}

async function siteTransferTelegramUserIntoSiteUser(siteUserId, telegramUserId, tg, env) {
  siteUserId = Number(siteUserId); telegramUserId = Number(telegramUserId);
  if (!siteUserId || !telegramUserId || siteUserId === telegramUserId) return { merged: false, userId: siteUserId || telegramUserId };

  await prepareSiteAccountSchema(env);
  await preparePaymentSchema(env);
  await prepareSubscriptionDeviceSchema(env);
  await prepareSubscriptionEventsSchema(env);
  await prepareAffiliateSchema(env);

  const siteUser = await getUserRow(siteUserId, env);
  const tgUser = await getUserRow(telegramUserId, env);
  if (!siteUser || !tgUser) throw new Error('merge_user_missing');

  const log = await env.DB.prepare(`
    INSERT INTO site_account_merge_log (site_user_id, telegram_user_id, telegram_id, status)
    VALUES (?, ?, ?, 'started') RETURNING id
  `).bind(siteUserId, telegramUserId, String(tg.id)).first();
  const logId = Number(log?.id || 0);

  try {
    // Сроки не перетираем: переносим оставшееся время Telegram-профиля поверх web-профиля.
    const siteAccess = await getEffectiveSubscriptionAccess(siteUserId, env);
    const tgAccess = await getEffectiveSubscriptionAccess(telegramUserId, env);
    const now = Date.now();
    const siteRemaining = Math.max(0, Number(siteAccess?.endsTs || 0) - now);
    const tgRemaining = Math.max(0, Number(tgAccess?.endsTs || 0) - now);
    const combinedEndsAt = siteRemaining + tgRemaining > 0 ? formatTsToSql(now + siteRemaining + tgRemaining) : null;
    const siteSub = await getOrCreateUserSubscriptionCompat(siteUserId, env);
    if (combinedEndsAt && siteSub?.id) {
      await env.DB.prepare(`UPDATE subscriptions SET plan_code = 'paid', status = 'active', is_trial = 0, ends_at = ? WHERE id = ?`).bind(combinedEndsAt, siteSub.id).run();
    }

    // Сохраняем старый Telegram ref_code, чтобы опубликованные реферальные ссылки не умерли.
    const sourceRefCode = String(tgUser?.ref_code || '').trim();
    if (sourceRefCode) {
      try { await env.DB.prepare(`UPDATE users SET ref_code = NULL WHERE id = ?`).bind(telegramUserId).run(); } catch (_) {}
      try { await env.DB.prepare(`UPDATE users SET ref_code = ? WHERE id = ?`).bind(sourceRefCode, siteUserId).run(); } catch (_) {}
    }

    // Переносим связи, где нет опасных уникальных конфликтов.
    const safeUpdates = [
      [`UPDATE payment_checks SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE subscription_events SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE subscription_device_activity SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE subscription_security_events SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE subscription_device_slot_purchases SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE affiliate_withdrawals SET user_id = ? WHERE user_id = ?`, siteUserId, telegramUserId],
      [`UPDATE users SET referred_by_user_id = ? WHERE referred_by_user_id = ?`, siteUserId, telegramUserId]
    ];
    for (const [sql, a, b] of safeUpdates) { try { await env.DB.prepare(sql).bind(a, b).run(); } catch (_) {} }

    // Таблицы старых версий бота: переносим, только если они существуют.
    for (const table of ['support_requests', 'survey_feedback', 'shop_purchases', 'shoppurchases']) {
      try { await env.DB.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).bind(siteUserId, telegramUserId).run(); } catch (_) {}
    }

    // Реферальные события: OR IGNORE не ломает уникальные ключи, дубликат остаётся на целевом профиле.
    try {
      await env.DB.prepare(`UPDATE OR IGNORE ref_events SET user_id = ? WHERE user_id = ?`).bind(siteUserId, telegramUserId).run();
      await env.DB.prepare(`DELETE FROM ref_events WHERE user_id = ?`).bind(telegramUserId).run();
      await env.DB.prepare(`UPDATE OR IGNORE ref_events SET invited_user_id = ? WHERE invited_user_id = ?`).bind(siteUserId, telegramUserId).run();
      await env.DB.prepare(`DELETE FROM ref_events WHERE invited_user_id = ?`).bind(telegramUserId).run();
    } catch (_) {}

    // Партнёрские записи.
    try {
      await env.DB.prepare(`UPDATE OR IGNORE affiliate_transactions SET user_id = ? WHERE user_id = ?`).bind(siteUserId, telegramUserId).run();
      await env.DB.prepare(`DELETE FROM affiliate_transactions WHERE user_id = ?`).bind(telegramUserId).run();
      await env.DB.prepare(`UPDATE affiliate_transactions SET invited_user_id = ? WHERE invited_user_id = ?`).bind(siteUserId, telegramUserId).run();
    } catch (_) {}

    // Устройства переносим по одному: совпадающий HWID не должен сорвать весь merge.
    const tgDevices = await getUserSubscriptionDevices(telegramUserId, env);
    for (const device of tgDevices) {
      try {
        const moved = await env.DB.prepare(`UPDATE OR IGNORE subscription_devices SET user_id = ? WHERE id = ? AND user_id = ?`).bind(siteUserId, Number(device.id), telegramUserId).run();
        if (Number(moved?.meta?.changes || 0) < 1 && device.device_identity_hash) {
          // Такой же физический девайс уже есть у web-профиля — старую запись оставляем как архивную revoked.
          await env.DB.prepare(`UPDATE subscription_devices SET status = 'revoked', revoked_at = datetime('now'), name = name || ' (до объединения)' WHERE id = ?`).bind(Number(device.id)).run();
        }
      } catch (_) {}
    }

    // Политику слотов пересобираем из ledger после переноса покупок.
    try { await syncPurchasedDeviceSlotsFromLedger(siteUserId, env); } catch (_) {}
    try { await env.DB.prepare(`DELETE FROM subscription_device_user_policy WHERE user_id = ?`).bind(telegramUserId).run(); } catch (_) {}
    try { await env.DB.prepare(`DELETE FROM subscription_device_input_state WHERE user_id = ?`).bind(telegramUserId).run(); } catch (_) {}
    try { await env.DB.prepare(`DELETE FROM telegram_delivery_failures WHERE user_id = ?`).bind(telegramUserId).run(); } catch (_) {}

    const paidOnWebsite = await siteUserHasWebsitePurchase(siteUserId, env);
    const targetReferredBy = Number(siteUser?.referred_by_user_id || 0) || Number(tgUser?.referred_by_user_id || 0) || null;
    const mergedRefPoints = Math.max(0, Number(siteUser?.ref_points || 0)) + Math.max(0, Number(tgUser?.ref_points || 0));
    const freeActivated = paidOnWebsite ? 1 : Math.max(Number(siteUser?.free_access_activated || 0), Number(tgUser?.free_access_activated || 0));
    const trialGranted = paidOnWebsite ? 1 : Math.max(Number(siteUser?.new_user_trial_granted || 0), Number(tgUser?.new_user_trial_granted || 0));
    const channelClaimed = Math.max(Number(siteUser?.channel_bonus_claimed || 0), Number(tgUser?.channel_bonus_claimed || 0));
    const isAdmin = Math.max(Number(siteUser?.is_admin || 0), Number(tgUser?.is_admin || 0));

    // Сначала освобождаем уникальный telegram_id на старой строке, затем назначаем его web-профилю.
    await env.DB.prepare(`UPDATE users SET telegram_id = NULL, username = NULL, merged_into_user_id = ? WHERE id = ?`).bind(siteUserId, telegramUserId).run();
    await env.DB.prepare(`
      UPDATE users
      SET telegram_id = ?, username = ?, first_name = ?, last_seen_at = ?,
          referred_by_user_id = COALESCE(referred_by_user_id, ?),
          ref_points = ?, channel_bonus_claimed = ?, is_admin = ?,
          free_access_activated = ?, new_user_trial_granted = ?
      WHERE id = ?
    `).bind(
      String(tg.id), tg.username || null, tg.first_name || null, new Date().toISOString(),
      targetReferredBy, mergedRefPoints, channelClaimed, isAdmin,
      freeActivated, trialGranted, siteUserId
    ).run();

    // Старую subscription-строку гасим, чтобы она не участвовала в напоминаниях/расчётах случайно.
    try { await env.DB.prepare(`UPDATE subscriptions SET status = 'expired', ends_at = datetime('now') WHERE user_id = ?`).bind(telegramUserId).run(); } catch (_) {}

    if (logId) await env.DB.prepare(`UPDATE site_account_merge_log SET status = 'completed', finished_at = datetime('now') WHERE id = ?`).bind(logId).run();
    return { merged: true, userId: siteUserId };
  } catch (error) {
    if (logId) {
      try { await env.DB.prepare(`UPDATE site_account_merge_log SET status = 'failed', note = ?, finished_at = datetime('now') WHERE id = ?`).bind(String(error?.message || error).slice(0, 1000), logId).run(); } catch (_) {}
    }
    throw error;
  }
}

async function siteLinkTelegram(request, env, origin) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const body = await siteReadJson(request);
  const verified = await siteVerifyTelegramWidgetAuth(body?.telegram, env);
  if (!verified.ok) return siteApiError(verified.reason, 401, null, origin);

  const account = await siteGetAccountById(session.account.id, env);
  const siteUserId = Number(account.user_id);
  const currentSiteUser = await getUserRow(siteUserId, env);
  if (String(currentSiteUser?.telegram_id || '') === String(verified.user.id)) {
    if (await siteUserHasWebsitePurchase(siteUserId, env)) await markSitePaidUserAsNonTrial(siteUserId, env);
    return siteApiJson({ ok: true, merged: false, alreadyLinked: true }, 200, origin);
  }

  const existingTelegramUserId = await findUserIdByTelegramId(verified.user.id, env);
  try {
    let result;
    if (existingTelegramUserId && Number(existingTelegramUserId) !== siteUserId) {
      result = await siteTransferTelegramUserIntoSiteUser(siteUserId, existingTelegramUserId, verified.user, env);
    } else {
      await env.DB.prepare(`
        UPDATE users SET telegram_id = ?, username = ?, first_name = ?, last_seen_at = ? WHERE id = ?
      `).bind(String(verified.user.id), verified.user.username || null, verified.user.first_name || null, new Date().toISOString(), siteUserId).run();
      result = { merged: false, userId: siteUserId };
    }
    if (await siteUserHasWebsitePurchase(siteUserId, env)) await markSitePaidUserAsNonTrial(siteUserId, env);
    return siteApiJson({ ok: true, merged: !!result.merged }, 200, origin);
  } catch (error) {
    console.error('site telegram link/merge failed', error?.stack || error?.message || String(error));
    return siteApiError('merge_failed', 500, null, origin);
  }
}

async function siteBuildAccountPayload(account, env) {
  const userId = Number(account.user_id);
  const user = await getUserRow(userId, env);
  const access = await getEffectiveSubscriptionAccess(userId, env);
  const policy = await getSubscriptionDeviceUserPolicy(userId, env);
  const limit = await getSubscriptionDeviceLimit(userId, env);
  const devices = await getUserSubscriptionDevices(userId, env);
  const visibleDevices = devices.slice(0, 50).map((device) => ({
    id: Number(device.id),
    name: String(device.name || 'Устройство'),
    status: String(device.status || ''),
    identityKind: String(device.identity_kind || ''),
    os: device.device_os || null,
    model: device.device_model || null,
    client: device.client_type || null,
    appVersion: device.app_version || null,
    lastSeen: device.last_seen_at || null
  }));
  let subUrl = null;
  let connectUrl = null;
  if (access.active) {
    subUrl = addClientQueryParam(await buildClientSubUrl(userId, 'raw', env));
    connectUrl = buildV2RayTunOpenUrl(subUrl, env);
  }
  return {
    ok: true,
    account: {
      id: Number(account.id),
      email: account.email || null,
      telegram: user?.telegram_id ? {
        id: String(user.telegram_id),
        username: normalizeUsername(user.username || '') || null,
        firstName: user.first_name || null
      } : null
    },
    subscription: {
      active: !!access.active,
      endsAt: access.endsAt || null,
      planCode: access.planCode || null,
      hasPro: !!access.hasPro,
      url: subUrl,
      connectUrl
    },
    devices: {
      used: visibleDevices.filter((item) => item.status === 'active').length,
      limit,
      purchased: Math.max(0, Number(policy?.purchasedSlots || 0)),
      items: visibleDevices
    },
    plans: PAYMENT_PLANS.map((plan) => ({ code: String(plan.code), amount: Number(plan.amount), days: Number(plan.days), title: String(plan.title) }))
  };
}

async function siteMe(request, env, origin) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const account = await siteGetAccountById(session.account.id, env);
  return siteApiJson(await siteBuildAccountPayload(account, env), 200, origin);
}

async function siteRotateSubscription(request, env, origin) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const access = await getEffectiveSubscriptionAccess(Number(session.account.user_id), env);
  if (!access.active) return siteApiError('subscription_inactive', 409, null, origin);
  await rotateUserSubscriptionLink(Number(session.account.user_id), env);
  return siteApiJson({ ok: true }, 200, origin);
}

async function siteDeviceAction(request, env, origin, action) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const body = await siteReadJson(request);
  const deviceId = Number(body?.deviceId || 0);
  if (!deviceId) return siteApiError('bad_device_id', 400, null, origin);
  const userId = Number(session.account.user_id);
  if (action === 'revoke') {
    const ok = await revokeSubscriptionDevice(deviceId, userId, env);
    return ok ? siteApiJson({ ok: true }, 200, origin) : siteApiError('device_not_found', 404, null, origin);
  }
  const result = await restoreSubscriptionDevice(deviceId, userId, env);
  return result?.ok ? siteApiJson({ ok: true }, 200, origin) : siteApiError(result?.reason || 'device_restore_failed', 409, null, origin);
}

async function siteCreatePayment(request, env, origin) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const body = await siteReadJson(request);
  const requestedCode = String(body?.planCode || PAYMENT_PLANS[0].code);
  const plan = getPaymentPlanByCode(requestedCode);
  if (!plan) return siteApiError('bad_plan', 400, null, origin);
  const userId = Number(session.account.user_id);
  const user = await getUserRow(userId, env);
  const amount = Number(plan.amount);
  const days = Number(plan.days);
  const telegramId = user?.telegram_id ? String(user.telegram_id) : null;
  const username = normalizeUsername(user?.username || '') || null;
  const payload = {
    provider: 'platega', paymentType: 'subscription', source: 'website',
    siteAccountId: Number(session.account.id), userId, telegramId, username,
    amount, currency: 'RUB', days, createdAt: new Date().toISOString()
  };

  let result;
  try {
    result = await plategaApi('/transaction/process', env, {
      method: 'POST',
      body: {
        paymentMethod: getPlategaPaymentMethod(env),
        paymentDetails: { amount, currency: 'RUB' },
        description: `MVZ подписка ${days} дней (website account ${session.account.id})`,
        return: `${SITE_URL}/?payment=success`,
        failedUrl: `${SITE_URL}/?payment=failed`,
        payload: JSON.stringify(payload)
      }
    });
  } catch (error) {
    await notifyPaymentIssueToSupport('Website: не удалось создать платёж Platega', {
      userId, telegramId, username, amount, currency: 'RUB', errorText: error?.message || String(error)
    }, env);
    return siteApiError('payment_create_failed', 502, null, origin);
  }

  const transactionId = String(result?.transactionId || result?.id || '').trim();
  const paymentUrl = result?.redirect || result?.payformSuccessUrl || result?.paymentUrl || result?.url;
  if (!transactionId || !paymentUrl) return siteApiError('payment_create_failed', 502, null, origin);

  await upsertPaymentCheck({
    donationId: transactionId, userId, telegramId, username, amount, currency: 'RUB',
    donorName: 'Platega', message: JSON.stringify(payload), status: 'pending', daysGranted: days,
    supportNotified: 0, provider: 'platega', paymentUrl, rawPayload: JSON.stringify(result),
    processedAt: null, paymentType: 'subscription', deviceSlots: 0
  }, env);

  return siteApiJson({ ok: true, transactionId, paymentUrl, amount, days }, 200, origin);
}

async function sitePaymentStatus(request, env, url, origin) {
  const session = await siteRequireSession(request, env);
  if (!session) return siteApiError('session_required', 401, null, origin);
  const transactionId = String(url.searchParams.get('id') || '').trim();
  if (!transactionId) return siteApiError('missing_transaction_id', 400, null, origin);
  let row = await getPaymentCheckByDonationId(transactionId, env);
  if (!row?.donation_id || Number(row.user_id || 0) !== Number(session.account.user_id)) return siteApiError('payment_not_found', 404, null, origin);

  let status = String(row.status || '').toLowerCase();
  if (!['completed', 'failed', 'canceled', 'cancelled', 'chargebacked', 'manual_review'].includes(status)) {
    try {
      const live = await plategaApi(`/transaction/${encodeURIComponent(transactionId)}`, env);
      const liveStatus = String(live?.status || '').toUpperCase();
      if (liveStatus === 'CONFIRMED') {
        await finalizeConfirmedPlategaPayment(transactionId, live, env);
      } else if (['CANCELED', 'CANCELLED', 'CHARGEBACKED', 'FAILED'].includes(liveStatus)) {
        await updatePlategaPaymentAsTerminal(transactionId, liveStatus, live, env);
      }
      row = await getPaymentCheckByDonationId(transactionId, env);
      status = String(row?.status || liveStatus || '').toLowerCase();
    } catch (_) {}
  }
  if (status === 'completed' && await siteUserHasWebsitePurchase(Number(session.account.user_id), env)) {
    await markSitePaidUserAsNonTrial(Number(session.account.user_id), env);
  }
  return siteApiJson({
    ok: true, status, days: Number(row?.days_granted || 0), amount: Number(row?.amount || 0), processedAt: row?.processed_at || null
  }, 200, origin);
}

async function siteApiRouter(request, env, url) {
  const origin = request.headers.get('Origin') || SITE_SUPPORT_ORIGIN;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: siteApiCorsHeaders(origin) });

  // Существующий support API оставляем отдельным и совместимым.
  if (url.pathname.startsWith('/site-api/support/')) return await siteSupportApi(request, env, url);

  if (url.pathname === '/site-api/auth/register' && request.method === 'POST') return await siteRegister(request, env, origin);
  if (url.pathname === '/site-api/auth/login' && request.method === 'POST') return await siteLogin(request, env, origin);
  if (url.pathname === '/site-api/auth/telegram' && request.method === 'POST') return await siteTelegramLogin(request, env, origin);
  if (url.pathname === '/site-api/auth/logout' && request.method === 'POST') {
    await siteDeleteSession(request, env); return siteApiJson({ ok: true }, 200, origin);
  }
  if (url.pathname === '/site-api/account/link-telegram' && request.method === 'POST') return await siteLinkTelegram(request, env, origin);
  if (url.pathname === '/site-api/me' && request.method === 'GET') return await siteMe(request, env, origin);
  if (url.pathname === '/site-api/subscription/rotate' && request.method === 'POST') return await siteRotateSubscription(request, env, origin);
  if (url.pathname === '/site-api/devices/revoke' && request.method === 'POST') return await siteDeviceAction(request, env, origin, 'revoke');
  if (url.pathname === '/site-api/devices/restore' && request.method === 'POST') return await siteDeviceAction(request, env, origin, 'restore');
  if (url.pathname === '/site-api/payment/create' && request.method === 'POST') return await siteCreatePayment(request, env, origin);
  if (url.pathname === '/site-api/payment/status' && request.method === 'GET') return await sitePaymentStatus(request, env, url, origin);

  return siteApiError('not_found', 404, null, origin);
}

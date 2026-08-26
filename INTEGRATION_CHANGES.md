# Минимальные изменения в существующем Worker

`apply_patch.py` делает только четыре изменения и пишет их в новый файл.

## 1. Новый Website API

Перед `export default {` вставляется `worker_site_patch.js`.

## 2. Маршрутизация `/site-api/`

Было:

```js
if (url.pathname.startsWith("/site-api/")) return await siteSupportApi(request, env, url);
```

Станет:

```js
if (url.pathname.startsWith("/site-api/")) return await siteApiRouter(request, env, url);
```

`siteApiRouter` сам отдаёт старые `/site-api/support/*` обратно существующему `siteSupportApi`, поэтому старый support endpoint не удаляется.

## 3. Ответ поддержки с рабочки обратно на сайт

В самое начало `handleSupportGroupMessage` добавляется:

```js
if (await trySiteSupportReply(message, env)) return;
```

Это подключает уже существующую функцию, которая была написана в Worker, но не вызывалась.

## 4. Защита от повторного trial после web-покупки

Сразу после:

```js
const endsAt = await extendUserSubscriptionDays(userId, days, env, 'paid');
```

добавляется:

```js
if (String(storedPayload?.source || '').trim().toLowerCase() === 'website') {
  await markSitePaidUserAsNonTrial(userId, env);
}
```

Telegram-покупки не затрагиваются: условие срабатывает только для transaction payload с `source: "website"`.

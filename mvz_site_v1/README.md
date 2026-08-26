# MVZ Website v1

Первая версия самостоятельного сайта MVZ: регистрация без Telegram, вход через email/пароль или Telegram, покупка через существующую Platega-интеграцию, выдача той же подписочной ссылки, личный кабинет, устройства и web↔Telegram поддержка.

## Что уже заложено

- Покупка на сайте **без Telegram**.
- Пробный период сайт не выдаёт.
- После подтверждённой web-покупки `free_access_activated=1` и `new_user_trial_granted=1`, поэтому последующая привязка Telegram не создаёт повторный trial.
- Вход через Telegram использует существующего Telegram-пользователя и его внутренний `users.id`, если он уже есть.
- Если сначала была web-покупка, а потом привязывается Telegram:
  - если Telegram ещё не был в MVZ — он назначается тому же web-пользователю;
  - если Telegram уже имел отдельный MVZ-профиль — выполняется merge в web-профиль с переносом оставшегося срока, оплат, основных referral/affiliate связей и устройств; исходная строка пользователя не удаляется, а помечается `merged_into_user_id`.
- Подписочная ссылка строится существующей функцией бота; отдельного генератора VPN-конфигов на GitHub нет.
- Сайт видит существующий лимит устройств и умеет revoke/restore.
- Поддержка сайт → рабочая Telegram-группа → reply → сайт.
- Все секреты остаются в Worker. В GitHub Pages их нет.

## Файлы

- `index.html` — страница/личный кабинет.
- `styles.css` — фиолетовый MVZ UI.
- `app.js` — frontend API, оплата, устройства, Telegram login, support chat.
- `config.js` — публичные адреса Worker и username бота.
- `assets/mvz-logo.jpg` — присланный логотип.
- `worker_site_patch.js` — Website API, который вставляется в существующий Worker.
- `apply_patch.py` — безопасно создаёт **новую** копию Worker и не перезаписывает рабочий исходник.

## 1. Сначала создать patched Worker локально

Пример:

```bash
python apply_patch.py ../mvz.txt -o ../mvz_with_site_v1.js
```

Скрипт проверяет точные якоря и остановится, если текущий Worker отличается. Исходный `mvz.txt` не меняется.

Проверка синтаксиса (если Node установлен):

```bash
cp ../mvz_with_site_v1.js ../mvz_with_site_v1.mjs
node --check ../mvz_with_site_v1.mjs
```

## 2. D1

Website API при первом запросе создаёт только новые таблицы:

- `site_accounts`
- `site_sessions`
- `site_account_merge_log`

И добавляет в `users` только nullable колонку `merged_into_user_id`.

**Важная проверка перед первым реальным web-регистрантом:** `users.telegram_id` должен разрешать `NULL`, потому что web-only пользователь по определению ещё не имеет Telegram. В присланном Worker нет исходного `CREATE TABLE users`, поэтому это единственная часть схемы, которую по коду невозможно подтвердить. Если `telegram_id` оказался `NOT NULL`, API специально вернёт `users_telegram_id_not_nullable` и не будет придумывать фальшивый Telegram ID. Никакой опасной автоматической перестройки таблицы в патч не добавлена.

Проверить в Cloudflare D1 Console:

```sql
PRAGMA table_info(users);
```

У строки `telegram_id` значение `notnull` должно быть `0`.

## 3. Telegram Login

Frontend v1 использует классический Telegram Login Widget с серверной проверкой HMAC через уже существующий `env.BOT_TOKEN`.

В BotFather нужно привязать домен сайта к `@mvzapretbot`:

```text
/setdomain
mvcomplexsite.github.io
```

На сайте Telegram остаётся дополнительным способом входа. Email/пароль полностью независимы от него.

## 4. GitHub Pages

В корень репозитория GitHub Pages положить:

```text
index.html
styles.css
app.js
config.js
assets/mvz-logo.jpg
```

`worker_site_patch.js`, `apply_patch.py` и исходник бота в публичный Pages-репозиторий класть не нужно.

## 5. Поток оплаты

1. Пользователь входит/регистрируется на сайте.
2. `POST /site-api/payment/create` создаёт Platega transaction с `source=website`.
3. Platega callback остаётся существующим `/platega/callback` / `/paymentStatus` Worker-а.
4. Существующий `finalizeConfirmedPlategaPayment` начисляет дни.
5. Добавленный hook сразу помечает website-покупателя как уже активировавшего доступ и использовавшего trial-механику.
6. Кабинет получает существующий `/sub/u/{userId}/{token}/raw` URL.

## 6. Что НЕ менять

- Не переносить `BOT_TOKEN`, `PLATEGA_SECRET`, webhook secret или серверные конфиги в GitHub Pages.
- Не заменять существующую Platega callback-логику новой.
- Не создавать отдельную таблицу VPN-подписок для сайта: сайт работает с теми же `users`, `subscriptions`, `payment_checks` и `subscription_devices`.
- Не выкладывать исходный `mvz.txt` в публичный репозиторий.

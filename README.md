# MVZ VPS — готовая загрузка

1. Открой репозиторий `mvcomplexsite/mvz-vps-site`.
2. Нажми **Add file → Upload files**.
3. Перетащи ВСЕ файлы из этой папки, кроме `BOT_PATCH.txt` и `README.md`.
4. Важно: `index.html` должен лежать в корне, не внутри папки.
5. Нажми **Commit changes**.
6. Settings → Pages: Source `Deploy from a branch`, branch `main`, folder `/(root)`, Save.
7. Подожди 2–5 минут и обнови https://mvcomplexsite.github.io/mvz-vps-site/ через Ctrl+F5.

404 означает, что в опубликованном источнике ещё нет `index.html` в корне — это не ошибка кода сайта.

`BOT_PATCH.txt` не загружать в GitHub. Это инструкция для изменения Worker.

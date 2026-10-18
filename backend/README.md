# Backend

Локальный REST API на `json-server`. Данные хранятся в `db.json`.

## Запуск

```bash
npm ci
npm run dev
```

Ресурс доступен по адресу:

```text
http://localhost:3000/meetups
```

## Примеры запросов

```text
GET /meetups
GET /meetups/1
GET /meetups?topic=frontend
GET /meetups?isOnline=true&_sort=-startsAt
GET /meetups?title:contains=fetch
```

`db.json` изменяется после успешных запросов `POST`, `PATCH` и `DELETE`.

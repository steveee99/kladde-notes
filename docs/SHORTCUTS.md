# Apple Shortcuts

[Deutsch](SHORTCUTS.de.md)

On iPhone and iPad, Safari has no Web Share Target and Web Push only works for apps added to the Home
Screen. The **Shortcuts** app fills both gaps: shortcuts appear in the share sheet, run from Siri, the
Action Button, Back Tap or a widget, and personal automations run them on a schedule. Kladde offers a
small HTTP API for them under `/api/shortcuts/…`.

## 1. Create a token

1. In Kladde open **Settings → Features → Apple Shortcuts** (activate it if needed) and switch to its **Settings** tab.
2. Enter a name (e.g. "iPhone"), pick how long it stays valid (default: one year) and tap **Create token**.
3. Copy the value `Bearer kls_…` – it is shown only once. Save it in a note on the phone or paste it straight
   into the shortcut (see below).

A shortcut token only works on `/api/shortcuts/…`: it cannot read notes, use the sync, the MCP endpoint or
the import. The list on the settings page shows when each token was last used; **Revoke** stops it at once.
Creating and revoking tokens is recorded in the audit log. Only a hash of the token is stored on the server.

Use Kladde over **https** only, otherwise the token travels in clear text.

## 2. The building block: "Get contents of URL"

Every shortcut below uses the action **Get contents of URL** with:

| Field | Value |
| --- | --- |
| URL | `https://<your-server>/api/shortcuts/<endpoint>` (the address is shown on the settings page) |
| Method | `POST` (or `GET` for `tasks`) |
| Headers | `Authorization` = `Bearer kls_…` |
| Request Body | `JSON` with the fields below (for `attachment`: `File`) |

Tip: put the token into a **Text** action at the top of the shortcut and use that variable in the header,
so it is easy to replace.

Every answer is JSON. Successful requests contain `ok: true`, the `path` and `title` of the note and its
`url`, which **Open URLs** can open in Kladde. Errors contain `error` with a readable message (HTTP 400,
401 for a wrong or revoked token, 413 for files that are too large, 429 for too many requests).

## 3. Ready-made shortcuts

### "Save to Kladde" (share sheet)

1. New shortcut → ⓘ → turn on **Show in Share Sheet**; accepts **URLs, Text, Images, PDFs**.
2. **If** *Shortcut Input* *has any value* and its type is URL: **Get contents of URL**
   `…/capture`, JSON `url` = *Shortcut Input*, `title` = *Name* of the input (optional).
3. **Otherwise if** text: `…/capture` with JSON `text` = *Shortcut Input*.
4. **Otherwise** (image, PDF): `…/attachment?name=<Name>` with Request Body **File** = *Shortcut Input*.
5. Optional: **Show notification** "Saved to Kladde", or **Open URLs** with `url` from the answer.

### "Quick note" (Siri, Action Button)

1. **Dictate text** (or **Ask for input**).
2. **Get contents of URL** `…/append`, JSON `text` = *Dictated text*.

Without `path`, `id` or `title`, the text is appended to **today's daily note** (created if needed; daily
notes must be turned on under Settings → Features). With `path` (e.g. `1 Projects/Moving.md`) it goes into
that note. Send `"lang": "en"` if your daily note names use English month or weekday names.

To create a new inbox note instead, use `…/capture` with `text`.

### "New task"

1. **Ask for input** (text) → *Task*.
2. **Ask for input** (date, optional) → *Due*.
3. **Get contents of URL** `…/task`, JSON `text` = *Task*, `due` = *Due* (format "ISO 8601" or just the date).

Optional fields: `repeat` (`daily`, `weekly`, `2 weeks`, `monatlich`, …), `time` (`09:00`, a reminder time
on the due day), `path`/`id`/`title` (the note the task goes into) or `"daily": true` (today's daily note).
Without a note it goes to the free tasks on the home page.

### "Due tasks today" (morning automation, replaces Web Push on iOS)

1. **Get contents of URL** `…/tasks?days=0` with method **GET** and the `Authorization` header.
2. **Get dictionary value** `summary` → **Show notification** with it as the body
   (e.g. "2 due today, 1 overdue").
3. Optional: **Get dictionary value** `lines` → **Choose from list** or **Show result**.

Then: Shortcuts → **Automation** → **New automation** → **Time of day** (e.g. 07:30, daily) → **Run
immediately** → this shortcut.

To turn tasks into iOS reminders, use **Repeat with each** over `tasks` and **Add new reminder** with
`text` and `due`.

## 4. API reference

All endpoints need `Authorization: Bearer kls_…`. JSON bodies may also be sent as
`application/x-www-form-urlencoded`. Limit: 120 requests per minute.

| Endpoint | Fields | Result |
| --- | --- | --- |
| `POST /api/shortcuts/capture` | `text` and/or `url` (http/https), optional `title`, `folder` (default `0 Inbox`), `tags` (list or "a, b") | New note |
| `POST /api/shortcuts/attachment` | Body: the file (images, PDFs, … up to the attachment size limit). Query: `name`, optional `title`, `text`, `folder` | New note that embeds the file; `file` = attachment URL |
| `POST /api/shortcuts/append` | `text`, optional `path` / `id` / `title`, `lang` | Text appended to the note or today's daily note |
| `POST /api/shortcuts/task` | `text`, optional `due` (`YYYY-MM-DD`, ISO date, `today`, `tomorrow`), `time` (`HH:MM`), `repeat`, `path` / `id` / `title`, `daily` | Task line in `task` |
| `GET /api/shortcuts/tasks` | Query: `days` (upcoming window, default 7, max 60), `lang` (`de`/`en`) | `counts` (overdue, today, upcoming), `summary`, `lines`, `tasks` (text, due, time, repeat, status, bucket, note, url) |

Notes in the PARA archive are left out of `tasks`. Everything is saved through the normal sync, so open
devices show the change right away and the version history keeps it.

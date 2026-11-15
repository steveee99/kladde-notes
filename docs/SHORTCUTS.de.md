# Apple Kurzbefehle

[English](SHORTCUTS.md)

Auf iPhone und iPad kennt Safari kein Web Share Target, und Web Push funktioniert nur für Apps auf dem
Home-Bildschirm. Die App **Kurzbefehle** schließt beide Lücken: Kurzbefehle erscheinen im Teilen-Menü,
laufen per Siri, Action-Taste, Doppeltippen auf die Rückseite oder Widget, und persönliche Automationen
starten sie nach Zeitplan. Kladde bietet dafür eine kleine HTTP-API unter `/api/shortcuts/…`.

## 1. Token erstellen

1. In Kladde **Einstellungen → Apple Kurzbefehle** öffnen.
2. Namen eingeben (z. B. „iPhone“), Gültigkeit wählen (Standard: ein Jahr) und **Token erstellen** tippen.
3. Den Wert `Bearer kls_…` kopieren – er wird nur einmal angezeigt. Am besten direkt in den Kurzbefehl
   einfügen (siehe unten).

Ein Kurzbefehl-Token funktioniert nur für `/api/shortcuts/…`: Es kann keine Notizen lesen und weder Sync,
MCP noch Import benutzen. Die Liste in den Einstellungen zeigt, wann ein Token zuletzt benutzt wurde;
**Widerrufen** sperrt es sofort. Erstellen und Widerrufen landen im Audit-Log. Auf dem Server liegt nur ein
Hash des Tokens.

Nutze Kladde nur über **https**, sonst wird das Token im Klartext übertragen.

## 2. Der Baustein: „Inhalte von URL abrufen“

Alle Kurzbefehle unten nutzen die Aktion **Inhalte von URL abrufen** mit:

| Feld | Wert |
| --- | --- |
| URL | `https://<dein-server>/api/shortcuts/<endpunkt>` (die Adresse steht in den Einstellungen) |
| Methode | `POST` (bzw. `GET` für `tasks`) |
| Header | `Authorization` = `Bearer kls_…` |
| Hauptteil anfragen | `JSON` mit den Feldern unten (bei `attachment`: `Datei`) |

Tipp: Lege das Token oben im Kurzbefehl in eine **Text**-Aktion und nutze diese Variable im Header – dann
lässt es sich leicht austauschen.

Jede Antwort ist JSON. Erfolgreiche Anfragen enthalten `ok: true`, `path` und `title` der Notiz und ihre
`url`, die **URLs öffnen** in Kladde öffnet. Fehler enthalten `error` mit einer lesbaren Meldung (HTTP 400,
401 bei falschem oder widerrufenem Token, 413 bei zu großen Dateien, 429 bei zu vielen Anfragen).

## 3. Fertige Kurzbefehle

### „In Kladde sichern“ (Teilen-Menü)

1. Neuer Kurzbefehl → ⓘ → **Im Share-Sheet anzeigen** einschalten; akzeptiert **URLs, Text, Bilder, PDFs**.
2. **Wenn** *Kurzbefehleingabe* eine URL ist: **Inhalte von URL abrufen** `…/capture`, JSON `url` =
   *Kurzbefehleingabe*, `title` = *Name* der Eingabe (optional).
3. **Sonst wenn** Text: `…/capture` mit JSON `text` = *Kurzbefehleingabe*.
4. **Sonst** (Bild, PDF): `…/attachment?name=<Name>` mit Hauptteil **Datei** = *Kurzbefehleingabe*.
5. Optional: **Mitteilung anzeigen** „In Kladde gesichert“ oder **URLs öffnen** mit `url` aus der Antwort.

### „Schnelle Notiz“ (Siri, Action-Taste)

1. **Text diktieren** (oder **Nach Eingabe fragen**).
2. **Inhalte von URL abrufen** `…/append`, JSON `text` = *Diktierter Text*.

Ohne `path`, `id` oder `title` wird der Text an die **heutige Tagesnotiz** angehängt (sie wird bei Bedarf
angelegt; Tagesnotizen müssen unter Einstellungen → Funktionen eingeschaltet sein). Mit `path` (z. B.
`1 Projekte/Umzug.md`) landet er in dieser Notiz. Schicke `"lang": "en"`, wenn die Namen deiner
Tagesnotizen englische Monats- oder Wochentagsnamen enthalten.

Für eine neue Inbox-Notiz stattdessen `…/capture` mit `text` nutzen.

### „Neue Aufgabe“

1. **Nach Eingabe fragen** (Text) → *Aufgabe*.
2. **Nach Eingabe fragen** (Datum, optional) → *Fällig*.
3. **Inhalte von URL abrufen** `…/task`, JSON `text` = *Aufgabe*, `due` = *Fällig* (Format „ISO 8601“ oder
   nur das Datum).

Optionale Felder: `repeat` (`täglich`, `wöchentlich`, `2 weeks`, `monthly`, …), `time` (`09:00`, Erinnerung
am Fälligkeitstag), `path`/`id`/`title` (Notiz, in die die Aufgabe kommt) oder `"daily": true` (heutige
Tagesnotiz). Ohne Notiz landet sie bei den freien Aufgaben der Startseite.

### „Heute fällig“ (Automation am Morgen, ersetzt Web Push auf iOS)

1. **Inhalte von URL abrufen** `…/tasks?days=0` mit Methode **GET** und dem Header `Authorization`.
2. **Wörterbuchwert abrufen** `summary` → **Mitteilung anzeigen** mit diesem Text
   (z. B. „2 heute fällig, 1 überfällig“).
3. Optional: **Wörterbuchwert abrufen** `lines` → **Aus Liste auswählen** oder **Ergebnis anzeigen**.

Dann: Kurzbefehle → **Automation** → **Neue Automation** → **Tageszeit** (z. B. 07:30, täglich) →
**Sofort ausführen** → dieser Kurzbefehl.

Um Aufgaben als iOS-Erinnerungen anzulegen: **Wiederholen mit jedem** über `tasks` und
**Neue Erinnerung hinzufügen** mit `text` und `due`.

## 4. API-Referenz

Alle Endpunkte brauchen `Authorization: Bearer kls_…`. JSON-Hauptteile dürfen auch als
`application/x-www-form-urlencoded` kommen. Limit: 120 Anfragen pro Minute.

| Endpunkt | Felder | Ergebnis |
| --- | --- | --- |
| `POST /api/shortcuts/capture` | `text` und/oder `url` (http/https), optional `title`, `folder` (Standard `0 Inbox`), `tags` (Liste oder „a, b“) | Neue Notiz |
| `POST /api/shortcuts/attachment` | Hauptteil: die Datei (Bilder, PDFs, … bis zur Größengrenze für Anhänge). Query: `name`, optional `title`, `text`, `folder` | Neue Notiz, die die Datei einbettet; `file` = Adresse des Anhangs |
| `POST /api/shortcuts/append` | `text`, optional `path` / `id` / `title`, `lang` | Text an Notiz oder heutige Tagesnotiz angehängt |
| `POST /api/shortcuts/task` | `text`, optional `due` (`YYYY-MM-DD`, ISO-Datum, `today`, `tomorrow`, `heute`, `morgen`), `time` (`HH:MM`), `repeat`, `path` / `id` / `title`, `daily` | Aufgabenzeile in `task` |
| `GET /api/shortcuts/tasks` | Query: `days` (Zeitraum für „demnächst“, Standard 7, höchstens 60), `lang` (`de`/`en`) | `counts` (overdue, today, upcoming), `summary`, `lines`, `tasks` (text, due, time, repeat, status, bucket, note, url) |

Notizen im PARA-Archiv fehlen in `tasks`. Alles wird über den normalen Sync gespeichert: Offene Geräte
zeigen die Änderung sofort, und der Versionsverlauf behält sie.

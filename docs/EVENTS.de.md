# Git-Ereignisse und zentrale Webhooks

*English: [EVENTS.md](EVENTS.md)*

Kladde nimmt Webhooks von GitLab und GitHub an einer Stelle entgegen, übersetzt jede Zustellung in eines von wenigen
**Git-Ereignissen** und gibt es auf dem **Eventbus** des Servers an alle Abonnenten weiter: an Kladdes eigene
Ticket-Automationen und an beliebig viele [Plugins](PLUGINS.de.md). Ein Webhook pro GitLab-Projekt oder -Gruppe
(bzw. GitHub-Repository) genügt, egal wie viele Plugins seine Ereignisse nutzen.

```
GitLab / GitHub ──► POST /api/events/hooks/<id> ──► Secret prüfen ──► übersetzen ──► Wiederholungen weg ──► Eventbus
                                                                                                          ├─► Ticket-Automationen
                                                                                                          ├─► Plugin A (events: {...})
                                                                                                          └─► Plugin B
```

## Webhook einrichten

1. In Kladde: **Einstellungen → Webhooks → Neuer Webhook**. GitLab oder GitHub wählen, einen Namen geben und
   optional die Projektpfade, die er annehmen soll (`team/app`, oder ein Gruppenpfad wie `team` für alles darunter).
   Eigentümer einer Gruppe können den Webhook für die Gruppe statt für ihr Konto anlegen.
2. Kladde zeigt Adresse und Secret **einmal**. Das Secret liegt verschlüsselt; „Neues Secret“ ersetzt es.
3. Beim Anbieter:
   - **GitLab:** *Einstellungen → Webhooks* im Projekt oder in der Gruppe (Gruppen-Webhooks brauchen GitLab
     Premium). URL und *Secret token* aus Kladde, dann die Auslöser wählen: Push events, Tag push events, Comments,
     Confidential comments, Issues events, Confidential issues events, Merge request events, Job events, Pipeline
     events, Deployment events, Wiki page events, Releases events. Was Kladde nicht braucht, ignoriert es – mehr
     anzukreuzen schadet nicht.
   - **GitHub:** *Settings → Webhooks → Add webhook* im Repository oder in der Organisation. Payload URL und Secret
     aus Kladde, **Content type `application/json`**, dann „Let me select individual events“: Pull requests, Pull
     request reviews, Pushes, Workflow runs, Workflow jobs, Issues, Issue comments, Pull request review comments,
     Commit comments, Releases, Deployment statuses, Wiki.
4. GitLabs „Test“-Knopf und GitHubs Ping erscheinen in der Liste als *Ignoriert*: Die Verbindung steht.

Die Einstellungen zeigen pro Webhook die letzten 20 Zustellungen (Status, Zeit, Ereignis, Projekt, Ergebnis – nie
den Inhalt). Die Status:

| Status | Bedeutung |
| --- | --- |
| Zugestellt (`accepted`) | Auf dem Bus veröffentlicht; das Detail sagt, was die Abonnenten getan haben |
| Fehler (`failed`) | Mindestens ein Abonnent hat einen Fehler geworfen (im Detail genannt); die anderen liefen trotzdem |
| Abgelehnt (`invalid`) | Falsches Secret oder kein JSON |
| Ignoriert (`ignored`) | Ein Ereignis, das Kladde nicht kennt (Ping, Mitgliederänderungen, …) |
| Gefiltert (`filtered`) | Das Projekt steht nicht in der Pfadliste des Webhooks |
| Doppelt (`duplicate`) | Dieselbe Delivery-Id kam noch einmal (ein Retry): nicht ein zweites Mal veröffentlicht |

## Wie Zustellungen verarbeitet werden

- **Adresse und Secret:** Die Id in der Adresse findet den Webhook, das Secret beweist den Absender: GitLabs
  `X-Gitlab-Token` wird in konstanter Zeit verglichen, GitHubs `X-Hub-Signature-256` als HMAC-SHA256 über den
  rohen Body geprüft. Unbekannte Ids und falsche Secrets bekommen dasselbe `404`.
- **Grenzen:** höchstens 2 MB pro Zustellung, 300 Zustellungen pro Minute und Absenderadresse, 20 Webhooks pro
  Konto oder Gruppe, 20 Projektpfade pro Webhook.
- **Wiederholungen:** Die Delivery-Id (`X-Gitlab-Event-UUID`, `X-GitHub-Delivery`; ohne eine ein Hash des Bodys)
  merkt sich Kladde pro Webhook 3 Tage lang. Ein Retry derselben Zustellung bekommt `200` und wird nicht noch einmal
  veröffentlicht.
- **Erst antworten:** Kladde antwortet `202`, sobald das Ereignis auf dem Bus ist; die Abonnenten laufen danach,
  ihr Ergebnis landet in der Zustellungsliste. Ereignisse liegen nur im Speicher: Was beim Neustart noch in einer
  Warteschlange steht, geht verloren (GitLab und GitHub schicken eine mit `202` beantwortete Zustellung nicht neu).
- **Isolation:** Jeder Abonnent (die Ticket-Automationen, jedes Plugin) hat eine eigene Warteschlange und bekommt
  seine Ereignisse nacheinander in der Reihenfolge des Eingangs. Ein Fehler markiert nur die Zustellung als
  *Fehler*, wird geloggt und erscheint bei den Jobs im Admin-Dashboard; andere Abonnenten merken davon nichts.
- **Begrenzter Inhalt:** Titel und Pfade werden auf einige hundert Zeichen gekürzt, Beschreibungen, Nachrichten und
  Kommentare auf 4.000, Listen (Labels, Zuständige, …) auf 20 Einträge, die Commits eines Pushs auf die neuesten 20.

## Der Umschlag eines Ereignisses

Jedes Ereignis hat diese Felder; das typspezifische Objekt folgt unten.

| Feld | Typ | Inhalt |
| --- | --- | --- |
| `id` | string | Delivery-Id (siehe oben). Damit werden Handler idempotent |
| `type` | string | Einer der Typen unten, z. B. `git.merge_request` |
| `action` | string | Was passiert ist, je nach Typ |
| `provider` | `'gitlab' \| 'github'` | Woher es kam |
| `project` | `{ path, name, url, defaultBranch }` | Repository: `gruppe/unter/projekt` oder `owner/repo` |
| `actor` | `{ username, name } \| null` | Wer es ausgelöst hat |
| `at` | number | Wann es passiert ist (Zeit des Anbieters, wenn vorhanden), ms seit 1970 |
| `owner` | `{ kind: 'user' \| 'group', id, name }` | Wessen Webhook es geliefert hat |
| `users` | string[] | Nur für Plugins: die Konten, für die es ist (siehe [Plugins](#plugins)) |
| `raw` | unknown | Nur für Plugins, auf Wunsch: das JSON des Anbieters |

## Ereignistypen

Typen und Felder gehören zur Plugin-API (seit 1.4.0): Neue Typen, Aktionen oder Felder kommen mit einer
Minor-Version, Änderungen und Entfernungen mit einer Major-Version.

### `git.merge_request`

Merge Requests (GitLab) und Pull Requests (GitHub).

| Aktion | GitLab | GitHub |
| --- | --- | --- |
| `opened` | `open` | `opened`, `ready_for_review` |
| `reopened` | `reopen` | `reopened` |
| `updated` | `update` (neue Commits, Titel, Labels, …) | `edited`, `synchronize`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `review_requested`, `converted_to_draft` |
| `merged` | `merge` | `closed` mit `merged: true` |
| `closed` | `close` | `closed` ohne Merge |
| `approved` | `approved`, `approval` | Review `submitted` mit Status `approved` |
| `unapproved` | `unapproved`, `unapproval` | Review `dismissed` |

`mergeRequest`: `number` (GitLab `iid`), `title`, `description`, `url`, `state` (`open`/`merged`/`closed`),
`draft`, `sourceBranch`, `targetBranch`, `sha` (letzter Commit), `author`, `labels`, `assignees`, `reviewers`.

### `git.push`

Pushes auf Branches (GitLab *Push Hook*, GitHub `push` auf `refs/heads/…`).

| Aktion | Wann |
| --- | --- |
| `pushed` | Commits auf einem bestehenden Branch |
| `created` | Neuer Branch (`before` nur Nullen / `created: true`) |
| `deleted` | Branch gelöscht (`after` nur Nullen / `deleted: true`) |

`push`: `ref` (`refs/heads/main`), `branch`, `before`, `after`, `commits` (die neuesten 20: `sha`, `title` (erste
Zeile), `message`, `url`, `author`, `at`), `commitCount` (alle Commits des Pushs).

### `git.tag`

Tags (GitLab *Tag Push Hook*, GitHub `push` auf `refs/tags/…`). Aktionen `created`, `deleted`.
`tag`: `name` (`v1.2.0`), `ref`, `sha`, `message` (annotierte Tags bei GitLab).

### `git.pipeline`

CI-Pipelines (GitLab *Pipeline Hook*) und GitHub-Actions-Workflow-Runs (`workflow_run`). Die Aktion ist der Status:

| Aktion / Status | GitLab | GitHub |
| --- | --- | --- |
| `created` | `created` | – |
| `waiting` | `waiting_for_resource` | `waiting` |
| `pending` | `pending`, `preparing` | `queued`, `requested` |
| `running` | `running` | `in_progress` |
| `success` | `success` | Ergebnis `success`, `neutral` |
| `failed` | `failed` | Ergebnis `failure`, `timed_out`, `startup_failure` |
| `canceled` | `canceled`, `canceling` | Ergebnis `cancelled`, `stale` |
| `skipped` | `skipped` | Ergebnis `skipped` |
| `manual` | `manual` | Ergebnis `action_required` |
| `scheduled` | `scheduled` | – |

`pipeline`: `id`, `status`, `ref`, `sha`, `url`, `source` (`push`, `merge_request_event`, `schedule`, `web`, …;
GitHub: das auslösende Ereignis), `mergeRequest` (Nummer oder null), `durationSeconds`, `name` (GitHub: Name des
Workflows; GitLab: Name der Pipeline, wenn gesetzt).

### `git.job`

Einzelne CI-Jobs (GitLab *Job Hook*, GitHub `workflow_job`). Aktionen und Status wie bei Pipelines.
`job`: `id`, `name`, `stage` (GitHub: Name des Workflows), `status`, `ref`, `sha`, `url`, `pipelineId`,
`allowFailure`, `durationSeconds`, `failureReason` (GitLab: z. B. `script_failure`, `runner_system_failure`).

### `git.comment`

Kommentare (GitLab *Note Hook* und *Confidential Note Hook*, GitHub `issue_comment`, `pull_request_review_comment`,
`commit_comment`). Aktionen `created`, `edited`, `deleted` (GitLab meldet neue Kommentare und in neueren Versionen
auch bearbeitete).
`comment`: `id`, `body`, `url`, `on` (`merge_request`, `issue`, `commit`, `snippet`), `number` (des Merge Requests
oder Issues, sonst null), `title` (dessen Titel), `sha` (kommentierter Commit).

### `git.issue`

Issues (GitLab *Issue Hook* und *Confidential Issue Hook*, GitHub `issues`). Aktionen `opened`, `reopened`,
`updated` (Änderungen, Labels, Zuständige), `closed`.
`issue`: `number`, `title`, `description`, `url`, `state` (`open`/`closed`), `author`, `labels`, `assignees`,
`confidential`.

### `git.release`

Releases (GitLab *Release Hook*, GitHub `release`). Aktionen `created` (GitHub: `published`; Entwürfe bleiben
still), `updated`, `deleted`. `release`: `tag`, `name`, `description`, `url`.

### `git.deployment`

Deployments (GitLab *Deployment Hook*, GitHub `deployment_status`). Die Aktion ist der Status: `created`, `running`,
`success`, `failed` (GitHub `failure`, `error`), `canceled` (GitHub `inactive`).
`deployment`: `id`, `environment`, `status`, `ref`, `sha`, `url` (Adresse der Umgebung oder des Jobs).

### `git.wiki`

Wiki-Seiten (GitLab *Wiki Page Hook*, GitHub `gollum`). Aktionen `created`, `updated`, `deleted` (GitHub meldet nur
angelegte und bearbeitete Seiten). `wiki`: `title`, `slug`, `url`.

### (Noch) nicht übersetzt

GitLab: Mitglieder-, Untergruppen-, Projekt-, Feature-Flag-, Emoji-, Access-Token- und Schwachstellen-Ereignisse;
System Hooks. GitHub: Stars, Forks, Check Runs/Suites, Discussions, Packages, Security Advisories und alles
Weitere. Sie werden beantwortet und als *Ignoriert* gelistet. Ideen für weitere Typen gehören in ein Issue; bis
dahin kann ein Plugin sie über eigene `publicRoutes` annehmen ([PLUGINS.de.md](PLUGINS.de.md)).

## Ticket-Automationen

Ticket-Projekte (`project`-Block, siehe Projekteinstellungen) sind der erste Abonnent des Busses:
`git.merge_request`-Ereignisse mit `opened`/`reopened` (Auslöser *Merge Request geöffnet*), `merged` und `closed`
führen die Automationen jedes Ticket-Projekts des **Eigentümers** des Webhooks aus, dessen Ticket-Ids der Merge
Request in Titel, Branch oder Beschreibung nennt (`KLD-12`). Die Änderungen macht die Person, die den Webhook
angelegt hat; sie muss das Projekt weiterhin ändern dürfen. Die eigenen Webhooks eines Projekts
(*Projekteinstellungen → Git-Integration*) funktionieren weiter; beide für dasselbe Repository zu nutzen, führt die
Automationen zweimal aus (meist harmlos, weil sie denselben Status setzen).

## Plugins

Ein Server-Plugin abonniert mit `events`, ein Handler pro Typ (Plugin-API 1.4.0):

```ts
import { defineServerPlugin } from '@kladde/plugin-api/server';

export default defineServerPlugin({
  id: 'enhancements',
  events: {
    async 'git.merge_request'(event, ctx) {
      if (event.action !== 'merged') return;
      for (const userId of event.users) {
        ctx.notify(userId, { title: `Gemergt: ${event.mergeRequest.title}`, text: event.project.path });
      }
    },
    'git.pipeline'(event, ctx) {
      if (event.action === 'failed') ctx.log.warn(`Pipeline ${event.pipeline.id} auf ${event.pipeline.ref} fehlgeschlagen`);
    },
  },
  // rawPayload: ['git.push'],   // nur wenn die übersetzten Felder nicht reichen
});
```

- Ein Plugin bekommt ein Ereignis nur für Personen, die **das Plugin eingeschaltet** haben: beim Webhook eines
  Kontos dessen Eigentümer, beim Webhook einer Gruppe deren Mitglieder. `event.users` nennt sie (nie leer); mit
  ihnen arbeiten `ctx.notes`, `ctx.notify` und die eigenen Tabellen. `event.owner` sagt, wessen Webhook es war.
- Jedes Plugin bekommt eine eigene Kopie; Plugins sehen nie Webhook-Ids, Secrets oder Ereignisse anderer Eigentümer.
- `rawPayload: ['git.push', …]` legt für diese Typen das JSON des Anbieters als `event.raw` bei. Es kann groß sein,
  und seine Form ist die des Anbieters, nicht Teil der Plugin-API.
- Die Handler eines Plugins laufen nacheinander; sie sollten kurz sein oder lange Arbeit an einen Job geben. Ein
  geworfener Fehler markiert die Zustellung als *Fehler* mit dem Namen des Plugins und wird geloggt; andere Plugins
  erreicht er nie.
- Handler idempotent machen (über `event.id` oder das Objekt, das sie ändern): Dieselbe Änderung kann über zwei
  Webhooks kommen (den eines Projekts und den seiner Gruppe).
- Unbekannte Typen in `events` oder `rawPayload` stoppen den Start des Servers, wie ein ungültiger MCP-Tool-Name.

Das Beispiel-Plugin (`examples/kladde-plugin-logbook`) schreibt für jeden gemergten Merge Request einen
Logbucheintrag, einmal pro Delivery-Id.

## API für die Einstellungen

Alle Routen brauchen ein angemeldetes Konto; Webhooks einer Gruppe verwalten deren Eigentümer.

| Route | Zweck |
| --- | --- |
| `GET /api/event-sources` | Webhooks des Kontos und der Gruppen, die es besitzt, mit ihren letzten Zustellungen |
| `POST /api/event-sources` | `{ provider, name?, projects?, group? }` → `{ source, secret }` |
| `PATCH /api/event-sources/:id` | `{ name?, projects? }` |
| `POST /api/event-sources/:id/rotate` | Neues Secret → `{ secret }` |
| `DELETE /api/event-sources/:id` | Entfernt den Webhook (seine Adresse antwortet danach mit 404) |
| `POST /api/events/hooks/:id` | Die Adresse für GitLab/GitHub (ohne Konto; das Secret beweist den Absender) |

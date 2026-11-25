# GitLab/GitHub-Notizen

[English](REMOTE_NOTES.md)

Eine GitLab/GitHub-Notiz zeigt ein Markdown-Dokument aus einem Repository. Standardmäßig lädt Kladde es bei jedem Öffnen live und speichert nur die Adresse; mit **Regelmäßig synchronisieren** behält der Server stattdessen eine Kopie (siehe unten). Die Notiz ist immer schreibgeschützt: bearbeitet wird das Dokument an der Quelle.

## Benutzen

**Neu → GitLab/GitHub-Notiz**, die Befehlspalette oder `/gitlab` beim Schreiben (das bettet sie gleich mit `![[…]]` ein). Die Adresse ist die aus dem Browser:

| Adresse | Zeigt |
| --- | --- |
| `https://gitlab.com/gruppe/unter/projekt/-/blob/main/docs/a.md` (auch `/-/raw/…`) | diese Datei |
| `https://github.com/besitzer/repo/blob/main/a.md`, `https://raw.githubusercontent.com/…` | diese Datei |
| `https://gitlab.com/gruppe/projekt`, `https://github.com/besitzer/repo` | das README auf dem Standard-Branch |
| `…/tree/main/docs` | das README in diesem Ordner |

- Die Adresse darf [Variablen](VARIABLES.de.md) enthalten: `https://gitlab.com/{{var:kunde}}/doku/-/blob/main/README.md`. Mit `{{` werden die des Ordners angeboten.
- **Branch, Tag oder Commit** geht dem in der Adresse vor. Nötig ist das, wenn ein Branch mit Schrägstrichen mehrdeutig ist (Kladde probiert bis zu vier Lesarten der Adresse).
- Markdown- und Textdateien gehen (`.md`, `.markdown`, `.mdx`, `.txt`, README, LICENSE, …), bis 2 MB; Bilder bis 10 MB.
- Die Leiste über dem Text zeigt Quelle, Branch, letzten Commit und Ladezeit, dazu **Neu laden** und für alle, die die Notiz ändern dürfen, **Quelle ändern**. Titel und Ordner ändern sich wie gewohnt.
- Relative Links führen zur Datei auf ihrem Host, relative Bilder lädt Kladde. `[[Links]]`, Einbettungen, Abfragen, Variablen, Tickets und Erwähnungen im Dokument bleiben reiner Text; seine Aufgaben und sein Frontmatter zählen nicht als deine. Sein Text wird nur durchsucht, wenn die Notiz synchronisiert wird.
- Word, PDF, Markdown-Export, Druck und „Als Markdown kopieren“ enthalten das aktuelle Dokument.
- Öffentliche Links, Confluence-Seiten und die Demo zeigen einen Platzhalter: weder Dokument noch Adresse verlassen Kladde auf diesem Weg.
- Ohne Verbindung lässt sich das Dokument nicht zeigen, außer die Notiz wird synchronisiert.

### Live oder synchronisiert

Der Schalter **Regelmäßig synchronisieren** (beim Anlegen oder unter **Quelle ändern**) bestimmt, wie das Dokument nach Kladde kommt:

| | Live (Standard) | Synchronisiert |
| --- | --- | --- |
| Wann gelesen | bei jedem Öffnen der Notiz | vom Server alle `REMOTE_SYNC_HOURS` Stunden (Standard 6) und mit **Jetzt synchronisieren** |
| Gespeichert | nur die Adresse | Adresse und eine verschlüsselte Kopie des Dokuments auf dem Server, die mit der Notiz auf deine Geräte kommt |
| Suche | wird nicht durchsucht | wird gefunden (auch im Online-Modus und über MCP) |
| Offline | nicht sichtbar | Stand der letzten Synchronisierung (Bilder brauchen weiter eine Verbindung) |

Die Leiste über einer synchronisierten Notiz zeigt, wann sie synchronisiert wurde; **Jetzt synchronisieren** liest sie sofort für alle, die die Notiz sehen. Schlägt eine Synchronisierung fehl, bleibt die vorige Kopie und die Leiste sagt, warum. Nur ein geändertes Dokument geht erneut an die Geräte, unveränderte kosten keinen Sync-Verkehr. Die Kopie gehört zur Adresse: Nach einer Änderung der Quelle wird das neue Dokument sofort gelesen. Wird der Schalter ausgeschaltet, wird die Kopie gelöscht.

In der Datei steht:

```yaml
---
type: remote
source: "https://gitlab.com/team/{{var:projekt}}/-/blob/main/README.md"
ref: v2
sync: true
---
```

`sync: true` ist optional (synchronisiert, siehe oben). Text unter dem Frontmatter (von Hand oder von einem anderen Programm) bleibt erhalten, wird aber nicht gezeigt; die Notiz bietet an, eine normale zu werden. Die Apps von Kladde schreiben solchen Text nie, und KI-Assistenten (MCP) dürfen nur `source`, `ref` und `sync` ändern.

## Zugriff einrichten

Ein Admin legt fest, welche Instanzen gelesen werden. Das Token gilt für **alle**, die sich bei dieser Kladde anmelden.

> **Alle können lesen, was das Token lesen darf.** Jeder Benutzer kann jede Adresse auf einer eingerichteten Instanz eintragen. Nimm ein Projekt- oder Gruppen-Token nur mit Leserechten und begrenze es mit erlaubten Pfaden. Das persönliche Token eines Admins ist die falsche Wahl.

### Am Container

| Variable | Bedeutung |
| --- | --- |
| `REMOTE_GITLAB_URL` | GitLab-Instanz, Standard `https://gitlab.com`; auch mit Pfad (`https://example.org/gitlab`) |
| `REMOTE_GITLAB_TOKEN` | Projekt- oder Gruppen-Token mit `read_repository`. Mit `read_api` zeigt Kladde auch das Datum des letzten Commits |
| `REMOTE_GITLAB_INTERNAL_URL` | Adresse, unter der der Container GitLab erreicht, wenn sie abweicht (LAN, Containername). Das Token geht dorthin |
| `REMOTE_GITLAB_PUBLIC` | `1` = ohne Token, nur öffentliche Projekte |
| `REMOTE_GITHUB_URL` | Standard `https://github.com`, oder ein GitHub Enterprise Server |
| `REMOTE_GITHUB_TOKEN` | Fine-grained Token mit *Contents: Read-only* |
| `REMOTE_GITHUB_PUBLIC` | `1` = ohne Token, nur öffentliche Repositories (GitHub erlaubt 60 Anfragen pro Stunde) |
| `REMOTE_SYNC_HOURS` | Wie oft synchronisierte Notizen neu gelesen werden, in Stunden: Standard `6`, mindestens `1`, höchstens `168`. Der Server liest höchstens 10 Notizen pro Minute |
| `REMOTE_ALLOWED_PATHS` | Kommagetrennte Gruppen oder Repositories, die Benutzer lesen dürfen, z. B. `team/doku,handbuch`. `gitlab:team` oder `github:team` gelten nur für eine Art. Leer = alles, was das Token lesen darf. Solange gesetzt, wird Weiterleitungen umbenannter Projekte nicht gefolgt |

`REMOTE_GITLAB_TOKEN_FILE` und `REMOTE_GITHUB_TOKEN_FILE` lesen das Token aus einer Datei (Docker Secrets). Ohne Token und ohne `…_PUBLIC` ist eine Instanz aus.

Für ein GitLab mit Zertifikat der eigenen CA siehe [GITLAB.de.md](GITLAB.de.md) (`NODE_EXTRA_CA_CERTS`). Die Variablen für die Anmeldung (`GITLAB_*`) sind davon unabhängig.

### In der App

**Einstellungen → Verwaltung → GitLab/GitHub**: beliebige Instanzen mit Token und erlaubten Pfaden, dazu **Zugriff testen**. Tokens liegen verschlüsselt und werden nie wieder angezeigt; ändert sich die Adresse, muss das Token neu eingegeben werden. Einträge aus der Umgebung werden gezeigt, lassen sich aber nicht ändern, und gehen einem Eintrag mit derselben Adresse vor.

## Was der Server tut

- Die Adresse kommt aus der gespeicherten Notiz, nach der Prüfung, ob der Benutzer sie sehen darf, mit den Variablen ihres Besitzers. Empfänger und Gruppenmitglieder sehen dasselbe Dokument.
- Gefragt werden nur eingerichtete Hosts (genau gleicher Ursprung) und dort nur feste API-Adressen. `..`, kodierte Schrägstriche, Zugangsdaten in Adressen und Ähnliches werden abgelehnt, auch nach dem Einsetzen der Variablen.
- Das Token geht nur an die API seiner eigenen Instanz, nie über eine Weiterleitung woandershin. Es steht in keiner Antwort, keiner Fehlermeldung und keinem Log.
- Antworten sind in Zeit und Größe begrenzt, Anfragen pro Benutzer auch. Dokumente von Live-Notizen liegen nur im Arbeitsspeicher und werden jedes Mal neu erfragt (innerhalb weniger Sekunden gilt dieselbe Antwort). Kopien synchronisierter Notizen liegen verschlüsselt wie Notizen und verlassen Kladde weder über öffentliche Links noch über den Katalog des Online-Modus.
- Bilder werden am Inhalt erkannt; SVGs können keine Skripte ausführen.
- Wer eine geteilte Notiz ändern darf, bestimmt ihre Quelle. Die eingesetzte Adresse eines Dokuments, das sich nicht lesen ließ, erfährt er nie.
- Bei einer `http://`-Instanz geht das Token unverschlüsselt durchs Netz: nur in einem vertrauenswürdigen Netz.

## Meldungen

| Meldung | Ursache |
| --- | --- |
| Dieser Host ist nicht eingerichtet | Die Adresse liegt auf keiner eingerichteten Instanz (Schema, Host und Port müssen stimmen), oder es fehlen Token und `…_PUBLIC` |
| Dieses Projekt ist für Kladde nicht freigegeben | Außerhalb der erlaubten Pfade |
| Der eingerichtete Zugang darf dieses Dokument nicht lesen | Token falsch, abgelaufen oder ohne das Recht |
| Dieses Dokument gibt es nicht … | Falsche Adresse, oder das Token sieht das Projekt nicht (GitLab und GitHub antworten gleich) |
| Die Adresse leitet woanders hin | Projekt umbenannt, oder GitLab leitet auf eine andere Adresse oder https um: URL anpassen |
| Eine Variable in der Adresse hat hier keinen Wert | Im Ordner der Notiz oder darüber anlegen |

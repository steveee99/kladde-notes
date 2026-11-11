# Anmelden mit GitLab

Kladde kann optional einen Knopf **„Mit GitLab anmelden“** auf der Anmeldeseite zeigen. Das funktioniert mit GitLab.com und mit jeder selbst gehosteten GitLab-Instanz (Community oder Enterprise Edition). Die Funktion ist **aus**, solange `GITLAB_CLIENT_ID` und `GITLAB_CLIENT_SECRET` nicht gesetzt sind. Ein- und ausgeschaltet wird sie nur über Umgebungsvariablen am Docker-Container.

Technisch ist es OAuth 2.0 (Authorization Code mit PKCE) gegen GitLab: Kladde schickt den Browser zu GitLab, GitLab schickt ihn mit einem Code zurück, und der Kladde-Server tauscht den Code direkt bei GitLab gegen Benutzer-ID, Benutzername und Gruppen ein. Passwörter oder Tokens von GitLab speichert Kladde nicht, nur die Verknüpfung „GitLab-Benutzer-ID → Kladde-Konto“.

---

## Überblick

1. In GitLab eine **OAuth-Anwendung** anlegen (Redirect-URI + Scopes `openid` und `profile`).
2. **Anwendungs-ID** und **Geheimnis** als Variablen an den Kladde-Container geben.
3. Container neu erstellen: `docker compose up -d`.
4. Bestehende Konten unter *Einstellungen → Anmelden mit GitLab* verknüpfen, neue Personen per Einladung registrieren.

Voraussetzungen:

- `PUBLIC_URL` ist gesetzt (z. B. `https://notes.example.org`). Daraus entsteht die Redirect-URI. Ohne `PUBLIC_URL` nimmt Kladde die Adresse aus der Anfrage; hinter einem Reverse-Proxy stimmt die dann oft nicht.
- Der **Browser** erreicht GitLab unter `GITLAB_URL`.
- Der **Kladde-Container** erreicht GitLab ebenfalls (unter `GITLAB_URL` oder `GITLAB_INTERNAL_URL`, siehe unten).

---

## 1. OAuth-Anwendung in GitLab anlegen

Es gibt drei Orte für die Anwendung. Für eine selbst gehostete Instanz ist die **instanzweite** Anwendung meist die beste Wahl.

| Wo | Menü | Wer kann es | Geeignet für |
| --- | --- | --- | --- |
| **Instanz** (nur selbst gehostet) | *Admin-Bereich → Anwendungen → Neue Anwendung* (`/admin/applications`) | Instanz-Admins | Die eigene GitLab-Instanz für alle; erlaubt „Vertrauenswürdig“ |
| **Gruppe** | *Gruppe → Einstellungen → Anwendungen* | Gruppen-Owner | GitLab.com oder ohne Admin-Rechte |
| **Benutzer** | *Avatar → Profil bearbeiten → Anwendungen* (`/-/user_settings/applications`) | Jede Person | Ausprobieren, Einzelnutzung |

Die Anwendung gehört nur dem, der sie angelegt hat; **anmelden** können sich damit trotzdem alle GitLab-Benutzer der Instanz (einschränken lässt sich das mit `GITLAB_ALLOWED_GROUPS`).

Felder ausfüllen:

| Feld | Wert |
| --- | --- |
| **Name** | `Kladde` (sehen die Benutzer auf der Zustimmungsseite) |
| **Redirect-URI** | `https://notes.example.org/api/auth/gitlab/callback` – also `PUBLIC_URL` + `/api/auth/gitlab/callback`, exakt so (Schema, Port, kein Schrägstrich am Ende) |
| **Vertrauenswürdig** (*Trusted*, nur im Admin-Bereich) | Optional. An = GitLab fragt die Benutzer nicht mehr, ob Kladde zugreifen darf |
| **Vertraulich** (*Confidential*) | **An** (Kladde hält das Geheimnis auf dem Server) |
| **Bereiche** (*Scopes*) | **`openid`** und **`profile`** – nichts weiter. `openid` liefert auch die Gruppen für `GITLAB_ALLOWED_GROUPS`. `api`/`read_api` sind **nicht** nötig |

Nach dem Speichern zeigt GitLab **Anwendungs-ID** und **Geheimnis**. Das Geheimnis ist später nur noch über „Erneuern“ zu bekommen, also gleich übernehmen.

> Erreichen Benutzer Kladde unter mehreren Adressen (z. B. intern und extern), funktioniert die GitLab-Anmeldung nur unter der Adresse aus `PUBLIC_URL`. GitLab erlaubt zwar mehrere Redirect-URIs (eine pro Zeile), Kladde verwendet aber immer `PUBLIC_URL`.

---

## 2. Container konfigurieren

Die Variablen sind in `docker-compose.yml` bereits vorbereitet und standardmäßig leer. Am einfachsten setzt du sie in einer `.env` neben der `docker-compose.yml`:

```env
PUBLIC_URL=https://notes.example.org
TRUST_PROXY=1

GITLAB_URL=https://gitlab.example.org
GITLAB_CLIENT_ID=6f1c…            # Anwendungs-ID
GITLAB_CLIENT_SECRET=gloas-…      # Geheimnis
GITLAB_LABEL=Firmen-GitLab        # optional: Beschriftung des Knopfs
GITLAB_ALLOWED_GROUPS=familie     # optional: nur Mitglieder dieser Gruppen
# GITLAB_ALLOW_SIGNUP=1           # optional: Konten ohne Einladung anlegen
# GITLAB_INTERNAL_URL=http://gitlab   # optional: siehe „Netzwerk“
```

Danach den Container **neu erstellen** (ein `docker restart` übernimmt keine geänderten Variablen):

```bash
docker compose up -d
```

Auf der Anmeldeseite erscheint jetzt „Mit GitLab anmelden“ (bzw. „Mit Firmen-GitLab anmelden“).

Ohne Compose:

```bash
docker run -d --name kladde -p 13002:3002 -v kladde-data:/app/data \
  -e PUBLIC_URL=https://notes.example.org -e TRUST_PROXY=1 \
  -e GITLAB_URL=https://gitlab.example.org \
  -e GITLAB_CLIENT_ID=… -e GITLAB_CLIENT_SECRET=… \
  kladde
```

### Alle Variablen

| Variable | Bedeutung |
| --- | --- |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | Aus der OAuth-Anwendung. **Beide gesetzt = Funktion an**, sonst aus |
| `GITLAB_URL` | Adresse der GitLab-Instanz, wie der **Browser** sie erreicht. Standard `https://gitlab.com`. Bei Installation unter einem Pfad mit Pfad angeben, z. B. `https://example.org/gitlab` |
| `GITLAB_INTERNAL_URL` | Optional. Adresse, unter der der **Kladde-Server** GitLab für Token und Benutzerdaten erreicht. Leer = `GITLAB_URL` |
| `GITLAB_ALLOWED_GROUPS` | Kommagetrennte **vollständige Gruppenpfade** (wie in der URL, z. B. `familie,firma/team`). Untergruppen zählen mit. Leer = jeder GitLab-Benutzer der Instanz |
| `GITLAB_ALLOW_SIGNUP` | `1` = unbekannte GitLab-Benutzer bekommen ohne Einladung ein neues Konto. Am besten nur zusammen mit `GITLAB_ALLOWED_GROUPS` |
| `GITLAB_LABEL` | Name im Knopf, Standard `GitLab` |

Das Geheimnis lieber nicht in eine eingecheckte Datei schreiben; `.env` gehört nicht ins Git.

---

## 3. Netzwerk bei selbst gehostetem GitLab

Der Browser und der Kladde-Server sprechen beide mit GitLab:

- **Browser → `GITLAB_URL`/oauth/authorize** (Anmeldung und Zustimmung)
- **Kladde-Container → `GITLAB_INTERNAL_URL` bzw. `GITLAB_URL`** `/oauth/token` und `/oauth/userinfo`

### GitLab ist vom Container aus unter der öffentlichen Adresse nicht erreichbar

Typisch im Heimnetz: `gitlab.example.org` zeigt auf die öffentliche IP, und der Router kann kein „Hairpin-NAT“; oder GitLab läuft auf demselben Docker-Host. Dann `GITLAB_INTERNAL_URL` auf eine Adresse setzen, die der Container erreicht:

```env
GITLAB_URL=https://gitlab.example.org          # für den Browser
GITLAB_INTERNAL_URL=http://192.168.1.20        # für den Kladde-Server
```

Liegen beide Container im selben Docker-Netzwerk, geht auch der Containername (z. B. `http://gitlab`). Wichtig: Die interne Adresse muss `/oauth/token` **direkt** beantworten und darf nicht auf HTTPS oder eine andere Adresse umleiten (bei Omnibus ggf. `nginx['redirect_http_to_https']` beachten oder die interne Adresse per HTTPS mit passendem Zertifikat nutzen).

### Eigenes Zertifikat (interne CA, selbst signiert)

Node.js vertraut nur den üblichen öffentlichen Zertifizierungsstellen. Ist das Zertifikat von GitLab von einer eigenen CA ausgestellt, schlägt die Anmeldung mit „GitLab ist gerade nicht erreichbar.“ fehl und im Log steht z. B. `SELF_SIGNED_CERT_IN_CHAIN` oder `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Lösung: das CA-Zertifikat (PEM) in den Container legen und mit `NODE_EXTRA_CA_CERTS` bekannt machen:

```yaml
services:
  kladde:
    environment:
      - NODE_EXTRA_CA_CERTS=/certs/gitlab-ca.pem
    volumes:
      - ./gitlab-ca.pem:/certs/gitlab-ca.pem:ro
```

Die Datei muss für alle lesbar sein (`chmod 644`), weil Kladde im Container als Benutzer `node` läuft. TLS-Prüfung abzuschalten (`NODE_TLS_REJECT_UNAUTHORIZED=0`) ist keine gute Idee.

### Verbindung testen

```bash
docker exec kladde node -e "fetch((process.env.GITLAB_INTERNAL_URL||process.env.GITLAB_URL)+'/.well-known/openid-configuration').then(r=>console.log('HTTP',r.status)).catch(e=>console.error(e.cause??e))"
```

`HTTP 200` = alles gut. Ein Fehler mit `ENOTFOUND`, `ECONNREFUSED` oder `ETIMEDOUT` bedeutet, dass der Container GitLab nicht erreicht (→ `GITLAB_INTERNAL_URL`, Firewall, Docker-Netzwerk); ein Zertifikatsfehler → `NODE_EXTRA_CA_CERTS`.

### GitLab selbst

- `external_url` in `/etc/gitlab/gitlab.rb` muss der Adresse aus `GITLAB_URL` entsprechen, sonst leitet GitLab bei der Anmeldung auf eine falsche Adresse um.
- Ist die Instanz nur im LAN oder per VPN erreichbar, funktioniert die GitLab-Anmeldung auch nur dort. Passkey/Passwort bleiben als Weg von unterwegs.

---

## 4. Konten verknüpfen und registrieren

- **Bestehende Konten:** anmelden wie bisher, dann *Einstellungen → Anmelden mit GitLab → Mit GitLab verknüpfen*. Danach reicht der GitLab-Knopf.
- **Neue Personen mit Einladung:** Einladungslink öffnen und „Mit GitLab registrieren“ wählen. Der Kladde-Benutzername wird aus dem GitLab-Benutzernamen gebildet (bei Kollision mit Zusatz).
- **Neue Personen ohne Einladung:** nur mit `GITLAB_ALLOW_SIGNUP=1`.
- Mit `GITLAB_ALLOWED_GROUPS` wird **jede** GitLab-Anmeldung geprüft (auch bei verknüpften Konten). Wer die Gruppe verlässt, kommt per GitLab nicht mehr hinein, per Passkey/Passwort weiterhin.
- Gesperrte Konten bleiben gesperrt. Eine Verknüpfung lässt sich nur entfernen, solange ein Passkey oder Passwort übrig bleibt.
- Jede GitLab-Anmeldung, Verknüpfung und Ablehnung steht im Protokoll unter *Einstellungen → Verwaltung*.

---

## 5. Fehlersuche

| Meldung / Symptom | Ursache und Lösung |
| --- | --- |
| Kein GitLab-Knopf | `GITLAB_CLIENT_ID` oder `GITLAB_CLIENT_SECRET` fehlt, oder der Container wurde nur neu gestartet statt neu erstellt (`docker compose up -d`). `docker logs kladde` zeigt, ob `GITLAB_URL` ungültig ist |
| GitLab: „The redirect URI included is not valid.“ | Die Redirect-URI in GitLab passt nicht zu `PUBLIC_URL` + `/api/auth/gitlab/callback`. Auf Schema (`http`/`https`), Port und abschließenden Schrägstrich achten. `PUBLIC_URL` setzen |
| GitLab: „Client authentication failed due to unknown client …“ | Falsche `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET` oder die Anwendung wurde in einer anderen Instanz angelegt als `GITLAB_URL` |
| GitLab: „The requested scope is invalid …“ | In der Anwendung fehlen `openid` oder `profile` |
| „GitLab ist gerade nicht erreichbar.“ | Der Container erreicht GitLab nicht oder vertraut dem Zertifikat nicht. Siehe *Verbindung testen*, `GITLAB_INTERNAL_URL`, `NODE_EXTRA_CA_CERTS`. Details in `docker logs kladde` |
| „GitLab hat die Anmeldung nicht bestätigt.“ | Token-Tausch abgelehnt: Geheimnis falsch, Anwendung nicht „vertraulich“ oder die Redirect-URI weicht ab |
| „Die GitLab-Anmeldung ist abgelaufen, bitte noch einmal.“ | Mehr als 10 Minuten bei GitLab, Container dazwischen neu gestartet, oder Kladde wurde unter einer anderen Adresse als `PUBLIC_URL` geöffnet (das Cookie fehlt dann) |
| „Dein GitLab-Konto gehört zu keiner freigegebenen Gruppe.“ | `GITLAB_ALLOWED_GROUPS` enthält den Anzeigenamen statt des **Pfads** (aus der URL, z. B. `firma/team`), oder die Person ist nicht Mitglied |
| „Dieses GitLab-Konto ist mit keinem Kladde-Konto verknüpft …“ | Erst in den Einstellungen verknüpfen, per Einladung registrieren oder `GITLAB_ALLOW_SIGNUP=1` setzen |

---

## Ausschalten

`GITLAB_CLIENT_ID` und `GITLAB_CLIENT_SECRET` leeren und `docker compose up -d`. Der Knopf verschwindet; bestehende Verknüpfungen bleiben gespeichert und gelten wieder, sobald die Funktion erneut eingeschaltet wird. Konten, die **nur** GitLab nutzen, brauchen dann einen Gerätecode oder Passwort-Reset unter *Einstellungen → Verwaltung*.

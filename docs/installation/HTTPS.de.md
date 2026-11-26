# HTTPS-Zertifikat einrichten

Kladde selbst spricht nur HTTP (Port `3002` im Container, `13002` auf dem Host). HTTPS übernimmt ein **Reverse Proxy** davor: Er hält das Zertifikat, nimmt die verschlüsselten Verbindungen an und leitet sie an Kladde weiter.

Ohne HTTPS geht vieles nicht, außer auf `localhost`:

- **Passkeys** (WebAuthn) verlangen einen sicheren Kontext und sind an die Domain aus `PUBLIC_URL` gebunden.
- **Offline-Modus und Installation als App** (Service Worker, PWA) gibt es nur über HTTPS.
- **Erinnerungen per Web Push**, die Zwischenablage und das Teilen an Kladde („Teilen → Kladde“) brauchen ebenfalls HTTPS.

Ohne HTTPS meldest du dich mit Benutzername und Passwort an, und die App läuft nur online im Browser.

> Englische Fassung: [HTTPS.md](HTTPS.md)

## Überblick

| Weg | Wann | Zertifikat |
| --- | --- | --- |
| [Caddy](#1-caddy-empfohlen) | Server mit öffentlicher Domain, am einfachsten | Let's Encrypt, automatisch |
| [nginx + certbot](#2-nginx--certbot) | nginx läuft schon | Let's Encrypt über certbot |
| [Traefik](#3-traefik) | Traefik verwaltet schon deine Container | Let's Encrypt über Traefik |
| [Heimnetz ohne öffentliche Erreichbarkeit](#4-heimnetz-ohne-öffentliche-erreichbarkeit) | nur im LAN oder per VPN | DNS-Challenge, Tailscale oder eigene CA |

Bei jedem Weg gilt für Kladde:

```env
PUBLIC_URL=https://notes.example.org   # genau die Adresse, die im Browser steht
TRUST_PROXY=1                          # Kladde steht hinter genau einem Proxy
```

`PUBLIC_URL` bestimmt die Passkey-Domain und die Einladungslinks. Wechselst du die Domain später, gelten bestehende Passkeys nicht mehr. Die Anmeldung mit Passwort oder GitLab funktioniert weiter, und unter Einstellungen → Konto legst du einen neuen Passkey an.

### Voraussetzungen für Let's Encrypt (Wege 1–3)

1. Eine Domain oder Subdomain, z. B. `notes.example.org`.
2. Ein **DNS-Eintrag** (A für IPv4, AAAA für IPv6), der auf die öffentliche IP des Servers zeigt.
3. **Port 80 und 443** sind von außen erreichbar (Firewall, Portweiterleitung am Router). Port 80 braucht Let's Encrypt für die Prüfung (HTTP-01-Challenge), danach leitet er auf HTTPS um.

Prüfen: `dig +short notes.example.org` muss die IP des Servers liefern.

---

## 1. Caddy (empfohlen)

Caddy holt und verlängert Zertifikate selbst. Lege neben der `docker-compose.yml` von Kladde eine Datei `docker-compose.override.yml` an. Docker Compose liest sie automatisch mit ein:

```yaml
services:
  kladde:
    # Nicht mehr direkt nach außen: nur Caddy erreicht Kladde
    ports: !reset []
    environment:
      - PUBLIC_URL=https://notes.example.org
      - TRUST_PROXY=1

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"   # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data      # Zertifikate: nicht löschen, sonst werden sie neu angefordert
      - caddy_config:/config
    depends_on:
      - kladde

volumes:
  caddy_data:
  caddy_config:
```

`Caddyfile` im selben Ordner:

```caddy
notes.example.org {
	encode zstd gzip
	reverse_proxy kladde:3002
}
```

Starten:

```bash
docker compose up -d
docker logs -f caddy   # "certificate obtained successfully"
```

Mehr braucht es nicht. Caddy leitet HTTP auf HTTPS um, verlängert das Zertifikat vor Ablauf und gibt die Live-Updates (Server-Sent Events unter `/api/events`) ohne Pufferung weiter.

> `ports: !reset []` braucht Docker Compose 2.24 oder neuer. Bei älteren Versionen nimmst du den `ports`-Block direkt aus der `docker-compose.yml` heraus oder bindest ihn nur an localhost: `"127.0.0.1:13002:3002"`.

**Caddy läuft schon direkt auf dem Host** (nicht im Container)? Dann zeigt der Proxy auf den veröffentlichten Port:

```caddy
notes.example.org {
	reverse_proxy 127.0.0.1:13002
}
```

---

## 2. nginx + certbot

Kladde nur auf localhost veröffentlichen (`docker-compose.yml` → `ports: - "127.0.0.1:13002:3002"`), dann certbot installieren:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/kladde`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name notes.example.org;

    # Anhänge bis 25 MB, Importe bis 26 MB
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:13002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Live-Updates (Server-Sent Events): nicht puffern, Verbindung lange offen halten
    location /api/events {
        proxy_pass http://127.0.0.1:13002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Aktivieren und Zertifikat holen:

```bash
sudo ln -s /etc/nginx/sites-available/kladde /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notes.example.org   # ergänzt den 443-Block und die Umleitung
sudo certbot renew --dry-run                # prüft die automatische Verlängerung
```

certbot richtet einen Timer ein, der die Zertifikate rechtzeitig verlängert.

---

## 3. Traefik

Läuft Traefik schon mit einem Let's-Encrypt-Resolver (hier `le`) und dem Entrypoint `websecure`, reichen Labels am Kladde-Dienst (`docker-compose.override.yml`):

```yaml
services:
  kladde:
    ports: !reset []
    environment:
      - PUBLIC_URL=https://notes.example.org
      - TRUST_PROXY=1
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.kladde.rule=Host(`notes.example.org`)
      - traefik.http.routers.kladde.entrypoints=websecure
      - traefik.http.routers.kladde.tls.certresolver=le
      - traefik.http.services.kladde.loadbalancer.server.port=3002

networks:
  traefik:
    external: true
```

Traefik puffert Server-Sent Events nicht. Weitere Einstellungen sind nicht nötig.

---

## 4. Heimnetz ohne öffentliche Erreichbarkeit

Let's Encrypt prüft per HTTP-01 über Port 80 aus dem Internet. Ist dein Server nur im LAN oder per VPN erreichbar, hast du drei Möglichkeiten.

### a) DNS-Challenge mit eigener Domain (empfohlen)

Du brauchst eine Domain, deren DNS bei einem Anbieter mit API liegt (z. B. Cloudflare, Hetzner, deSEC). Let's Encrypt prüft dann einen DNS-Eintrag statt Port 80. Der Server muss dafür nicht aus dem Internet erreichbar sein.

1. Im lokalen DNS (Router, Pi-hole, AdGuard Home) `notes.example.org` auf die **LAN-IP** des Servers zeigen lassen.
2. Caddy mit dem DNS-Modul deines Anbieters bauen, z. B. für Cloudflare ein `Dockerfile.caddy`:

   ```dockerfile
   FROM caddy:2-builder AS builder
   RUN xcaddy build --with github.com/caddy-dns/cloudflare
   FROM caddy:2
   COPY --from=builder /usr/bin/caddy /usr/bin/caddy
   ```

   und im Override `image: caddy:2` durch `build: { context: ., dockerfile: Dockerfile.caddy }` ersetzen sowie `CLOUDFLARE_API_TOKEN` als Umgebungsvariable setzen (Token mit dem Recht „Zone → DNS → Bearbeiten“, nur für diese Zone).
3. `Caddyfile`:

   ```caddy
   notes.example.org {
   	tls {
   		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
   	}
   	reverse_proxy kladde:3002
   }
   ```

Das Zertifikat ist öffentlich gültig. Alle Geräte vertrauen ihm ohne weitere Einrichtung, auch iPhone und iPad.

### b) Tailscale

Sind deine Geräte per [Tailscale](https://tailscale.com) verbunden, stellt Tailscale selbst gültige Zertifikate für `<rechner>.<tailnet>.ts.net` aus:

1. In der Tailscale-Verwaltung unter DNS **MagicDNS** und **HTTPS Certificates** einschalten.
2. Auf dem Server: `sudo tailscale serve --bg 13002`
3. `PUBLIC_URL=https://<rechner>.<tailnet>.ts.net` und `TRUST_PROXY=1` setzen und Kladde neu starten.

Erreichbar ist Kladde dann nur in deinem Tailnet.

### c) Eigene Zertifizierungsstelle (mkcert)

Für reine Testumgebungen oder wenn keine Domain verfügbar ist. Jedes Gerät muss der eigenen CA vertrauen.

```bash
mkcert -install                                   # legt eine lokale CA an
mkcert notes.home.arpa 192.168.1.10               # Zertifikat + Schlüssel
```

Caddy mit diesen Dateien:

```caddy
notes.home.arpa {
	tls /certs/notes.home.arpa+1.pem /certs/notes.home.arpa+1-key.pem
	reverse_proxy kladde:3002
}
```

Die CA-Datei (`mkcert -CAROOT` zeigt den Ordner, Datei `rootCA.pem`) musst du auf jedem Gerät als vertrauenswürdig installieren:

- **iPhone/iPad:** Datei per AirDrop oder Mail öffnen → Einstellungen → „Profil geladen“ → installieren, danach unter Einstellungen → Allgemein → Info → **Zertifikatsvertrauenseinstellungen** das volle Vertrauen einschalten.
- **Android:** Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat.
- **Windows/macOS/Linux-Desktop:** `mkcert -install` auf dem Gerät, oder `rootCA.pem` in die Zertifikatsverwaltung bzw. den Schlüsselbund importieren.

Passkeys funktionieren damit. Manche Browser lehnen Web Push mit einer privaten CA aber ab. Für den Dauerbetrieb ist Weg a) besser.

---

## Prüfen

```bash
curl -I https://notes.example.org/health        # HTTP/2 200
curl -N https://notes.example.org/api/events    # 401 ohne Anmeldung; mit Cookie kommen sofort "event: hello" und alle 25 s ": ping"
```

Im Browser:

- Das Schloss in der Adressleiste zeigt ein gültiges Zertifikat.
- Unter Einstellungen → Konto lässt sich ein **Passkey** anlegen.
- In Chrome → DevTools → Application → Service Workers ist `sw.js` aktiv.

## Häufige Probleme

| Problem | Ursache und Lösung |
| --- | --- |
| Passkey: „Die Domain ist ungültig“ / `SecurityError` | `PUBLIC_URL` passt nicht zur Adresse im Browser (Schreibweise, `www.`, Port). Genau die aufgerufene Adresse eintragen und Kladde neu starten. |
| Anmeldung meldet „Zu viele Versuche – bitte kurz warten“, obwohl kaum jemand sich anmeldet | `TRUST_PROXY=1` fehlt: Kladde sieht dann für alle Besucher die IP des Proxys, und die Anmeldelimits pro IP gelten für alle zusammen. Außerdem erkennt Kladde ohne die Einstellung nicht, dass der Browser HTTPS benutzt. |
| Aufrufe von einer zweiten Adresse werden abgelehnt | Kladde nimmt nur Anfragen von `PUBLIC_URL` und der aufgerufenen Adresse an. Eine weitere Adresse (z. B. eine zweite Domain) trägst du in `ALLOWED_ORIGINS` ein, mehrere durch Kommas getrennt. |
| Let's Encrypt: `Timeout during connect` / `unauthorized` | Port 80 ist von außen nicht erreichbar oder der DNS-Eintrag zeigt woanders hin. Router-Portweiterleitung und `dig +short` prüfen, oder die DNS-Challenge (4a) nutzen. |
| `too many certificates already issued` | Rate-Limit von Let's Encrypt durch viele Versuche. Bis zu einer Woche warten. Zum Testen Caddys Staging-CA nutzen (`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`). Das Volume `caddy_data` nicht löschen. |
| Änderungen anderer Geräte kommen erst nach Minuten an | Der Proxy puffert `/api/events`. Bei nginx `proxy_buffering off` für diesen Pfad setzen (siehe oben). Kladde sendet zusätzlich `X-Accel-Buffering: no`. |
| Upload eines Anhangs bricht mit 413 ab | Der Body des Proxys ist zu klein: bei nginx `client_max_body_size 30m`. |
| iPhone zeigt nach Domainwechsel eine alte Version oder meldet sich ab | Die App vom Home-Bildschirm entfernen und unter der neuen Adresse neu hinzufügen. |

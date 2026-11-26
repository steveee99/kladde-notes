# Setting up an HTTPS certificate

Kladde itself only speaks HTTP (port `3002` in the container, `13002` on the host). HTTPS is done by a **reverse proxy** in front of it: it holds the certificate, accepts the encrypted connections and passes them on to Kladde.

Without HTTPS, a lot does not work, except on `localhost`:

- **Passkeys** (WebAuthn) need a secure context and are bound to the domain from `PUBLIC_URL`.
- **Offline mode and installing as an app** (service worker, PWA) only work over HTTPS.
- **Reminders via Web Push**, the clipboard and sharing to Kladde ("Share → Kladde") need HTTPS as well.

Without HTTPS you sign in with username and password, and the app only works online in the browser.

> German version: [HTTPS.de.md](HTTPS.de.md)

## Overview

| Option | When | Certificate |
| --- | --- | --- |
| [Caddy](#1-caddy-recommended) | Server with a public domain, the simplest | Let's Encrypt, automatic |
| [nginx + certbot](#2-nginx--certbot) | nginx already runs | Let's Encrypt via certbot |
| [Traefik](#3-traefik) | Traefik already manages your containers | Let's Encrypt via Traefik |
| [Home network without public access](#4-home-network-without-public-access) | LAN or VPN only | DNS challenge, Tailscale or your own CA |

Whichever you choose, Kladde needs:

```env
PUBLIC_URL=https://notes.example.org   # exactly the address in the browser
TRUST_PROXY=1                          # Kladde sits behind exactly one proxy
```

`PUBLIC_URL` sets the passkey domain and the invitation links. If you change the domain later, existing passkeys stop working. Signing in with a password or GitLab still works, and you add a new passkey under Settings → Account.

### Requirements for Let's Encrypt (options 1–3)

1. A domain or subdomain, e.g. `notes.example.org`.
2. A **DNS record** (A for IPv4, AAAA for IPv6) pointing to the server's public IP.
3. **Ports 80 and 443** reachable from the internet (firewall, port forwarding on the router). Let's Encrypt uses port 80 for its check (HTTP-01 challenge); afterwards it redirects to HTTPS.

Check: `dig +short notes.example.org` must return the server's IP.

---

## 1. Caddy (recommended)

Caddy gets and renews certificates on its own. Next to Kladde's `docker-compose.yml`, create a `docker-compose.override.yml`. Docker Compose reads it automatically:

```yaml
services:
  kladde:
    # No longer published directly: only Caddy reaches Kladde
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
      - caddy_data:/data      # certificates: do not delete, or they are requested again
      - caddy_config:/config
    depends_on:
      - kladde

volumes:
  caddy_data:
  caddy_config:
```

`Caddyfile` in the same folder:

```caddy
notes.example.org {
	encode zstd gzip
	reverse_proxy kladde:3002
}
```

Start it:

```bash
docker compose up -d
docker logs -f caddy   # "certificate obtained successfully"
```

That is all. Caddy redirects HTTP to HTTPS, renews the certificate before it expires and passes the live updates (server-sent events at `/api/events`) through without buffering.

> `ports: !reset []` needs Docker Compose 2.24 or newer. With older versions, remove the `ports` block from `docker-compose.yml` itself, or bind it to localhost only: `"127.0.0.1:13002:3002"`.

**Caddy already runs on the host** (not in a container)? Then point it at the published port:

```caddy
notes.example.org {
	reverse_proxy 127.0.0.1:13002
}
```

---

## 2. nginx + certbot

Publish Kladde on localhost only (`docker-compose.yml` → `ports: - "127.0.0.1:13002:3002"`), then install certbot:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/kladde`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name notes.example.org;

    # Attachments up to 25 MB, imports up to 26 MB
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:13002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Live updates (server-sent events): no buffering, keep the connection open
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

Enable it and get the certificate:

```bash
sudo ln -s /etc/nginx/sites-available/kladde /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notes.example.org   # adds the 443 block and the redirect
sudo certbot renew --dry-run                # checks the automatic renewal
```

certbot sets up a timer that renews the certificates in time.

---

## 3. Traefik

If Traefik already runs with a Let's Encrypt resolver (here `le`) and the entrypoint `websecure`, labels on the Kladde service are enough (`docker-compose.override.yml`):

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

Traefik does not buffer server-sent events, so nothing else is needed.

---

## 4. Home network without public access

Let's Encrypt checks with HTTP-01 over port 80 from the internet. If your server is only reachable in your LAN or over a VPN, you have three choices.

### a) DNS challenge with your own domain (recommended)

You need a domain whose DNS is hosted by a provider with an API (e.g. Cloudflare, Hetzner, deSEC). Let's Encrypt then checks a DNS record instead of port 80, so the server does not need to be reachable from the internet.

1. In your local DNS (router, Pi-hole, AdGuard Home), point `notes.example.org` at the server's **LAN IP**.
2. Build Caddy with your provider's DNS module, e.g. for Cloudflare a `Dockerfile.caddy`:

   ```dockerfile
   FROM caddy:2-builder AS builder
   RUN xcaddy build --with github.com/caddy-dns/cloudflare
   FROM caddy:2
   COPY --from=builder /usr/bin/caddy /usr/bin/caddy
   ```

   In the override, replace `image: caddy:2` with `build: { context: ., dockerfile: Dockerfile.caddy }` and set `CLOUDFLARE_API_TOKEN` as an environment variable (a token with "Zone → DNS → Edit" for this zone only).
3. `Caddyfile`:

   ```caddy
   notes.example.org {
   	tls {
   		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
   	}
   	reverse_proxy kladde:3002
   }
   ```

The certificate is publicly valid. Every device trusts it with no extra setup, including iPhone and iPad.

### b) Tailscale

If your devices are connected with [Tailscale](https://tailscale.com), Tailscale issues valid certificates for `<machine>.<tailnet>.ts.net` itself:

1. In the Tailscale admin console under DNS, turn on **MagicDNS** and **HTTPS Certificates**.
2. On the server: `sudo tailscale serve --bg 13002`
3. Set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `TRUST_PROXY=1`, then restart Kladde.

Kladde is then reachable only in your tailnet.

### c) Your own certificate authority (mkcert)

For test setups, or when no domain is available. Every device has to trust your own CA.

```bash
mkcert -install                                   # creates a local CA
mkcert notes.home.arpa 192.168.1.10               # certificate + key
```

Caddy with these files:

```caddy
notes.home.arpa {
	tls /certs/notes.home.arpa+1.pem /certs/notes.home.arpa+1-key.pem
	reverse_proxy kladde:3002
}
```

You have to install the CA file (`mkcert -CAROOT` shows the folder, the file is `rootCA.pem`) as trusted on every device:

- **iPhone/iPad:** open the file via AirDrop or mail → Settings → "Profile Downloaded" → install, then turn on full trust under Settings → General → About → **Certificate Trust Settings**.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
- **Windows/macOS/Linux desktop:** run `mkcert -install` on the device, or import `rootCA.pem` into the certificate store or keychain.

Passkeys work with this. Some browsers refuse Web Push with a private CA, though. For permanent use, option a) is the better choice.

---

## Checking

```bash
curl -I https://notes.example.org/health        # HTTP/2 200
curl -N https://notes.example.org/api/events    # 401 without signing in; with the cookie "event: hello" arrives at once and ": ping" every 25 s
```

In the browser:

- The lock in the address bar shows a valid certificate.
- Under Settings → Account you can add a **passkey**.
- In Chrome → DevTools → Application → Service Workers, `sw.js` is active.

## Common problems

| Problem | Cause and fix |
| --- | --- |
| Passkey: "The domain is invalid" / `SecurityError` | `PUBLIC_URL` does not match the address in the browser (spelling, `www.`, port). Enter exactly the address you open and restart Kladde. |
| Sign-in says "too many attempts" although hardly anyone signs in | `TRUST_PROXY=1` is missing. Kladde then sees the proxy's IP for every visitor, so the per-IP sign-in limits apply to everyone together. Without the setting Kladde also does not see that the browser uses HTTPS. |
| Requests from a second address are refused | Kladde only accepts requests from `PUBLIC_URL` and the address being called. Add other addresses (e.g. a second domain) to `ALLOWED_ORIGINS`, separated by commas. |
| Let's Encrypt: `Timeout during connect` / `unauthorized` | Port 80 is not reachable from outside, or the DNS record points elsewhere. Check port forwarding and `dig +short`, or use the DNS challenge (4a). |
| `too many certificates already issued` | Let's Encrypt's rate limit after many attempts. Wait up to a week. For testing use Caddy's staging CA (`acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`). Do not delete the `caddy_data` volume. |
| Changes from other devices arrive only after minutes | The proxy buffers `/api/events`. With nginx set `proxy_buffering off` for that path (see above). Kladde also sends `X-Accel-Buffering: no`. |
| Uploading an attachment fails with 413 | The proxy's body limit is too small: with nginx `client_max_body_size 30m`. |
| iPhone shows an old version or signs out after a domain change | Remove the app from the home screen and add it again from the new address. |

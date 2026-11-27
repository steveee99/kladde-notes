# Sign in with GitLab

[Deutsch](GITLAB.de.md)

Kladde can optionally show a **"Sign in with GitLab"** button on the sign-in page. It works with GitLab.com and with any self-hosted GitLab instance (Community or Enterprise Edition). The feature is **off** as long as `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` are not set. It is switched on and off only through environment variables on the Docker container.

Technically it is OAuth 2.0 (authorization code with PKCE) against GitLab: Kladde sends the browser to GitLab, GitLab sends it back with a code, and the Kladde server exchanges the code directly with GitLab for user id, username and groups. Kladde stores no GitLab passwords or tokens, only the link "GitLab user id → Kladde account".

---

## Overview

1. Create an **OAuth application** in GitLab (redirect URI + scopes `openid` and `profile`).
2. Pass the **application ID** and **secret** to the Kladde container as variables.
3. Recreate the container: `docker compose up -d`.
4. Link existing accounts under *Settings → Sign in with GitLab*; new people register with an invitation.

Requirements:

- `PUBLIC_URL` is set (e.g. `https://notes.example.org`). The redirect URI is built from it. Without `PUBLIC_URL` Kladde takes the address from the request, which is often wrong behind a reverse proxy.
- The **browser** reaches GitLab at `GITLAB_URL`.
- The **Kladde container** reaches GitLab too (at `GITLAB_URL` or `GITLAB_INTERNAL_URL`, see below).

---

## 1. Create the OAuth application in GitLab

There are three places for the application. For a self-hosted instance the **instance-wide** application is usually the best choice.

| Where | Menu | Who can do it | Suited for |
| --- | --- | --- | --- |
| **Instance** (self-hosted only) | *Admin area → Applications → New application* (`/admin/applications`) | Instance admins | Your own GitLab instance for everyone; allows "Trusted" |
| **Group** | *Group → Settings → Applications* | Group owners | GitLab.com or without admin rights |
| **User** | *Avatar → Edit profile → Applications* (`/-/user_settings/applications`) | Anyone | Trying it out, single use |

The application belongs only to whoever created it; still, every GitLab user of the instance can **sign in** with it (restrict that with `GITLAB_ALLOWED_GROUPS`).

Fill in the fields:

| Field | Value |
| --- | --- |
| **Name** | `Kladde` (users see it on the consent page) |
| **Redirect URI** | `https://notes.example.org/api/auth/gitlab/callback` – that is `PUBLIC_URL` + `/api/auth/gitlab/callback`, exactly like this (scheme, port, no trailing slash) |
| **Trusted** (admin area only) | Optional. On = GitLab no longer asks users whether Kladde may access their account |
| **Confidential** | **On** (Kladde keeps the secret on the server) |
| **Scopes** | **`openid`** and **`profile`** – nothing else. `openid` also provides the groups for `GITLAB_ALLOWED_GROUPS`. `api`/`read_api` are **not** needed |

After saving, GitLab shows the **application ID** and the **secret**. Later the secret can only be obtained by renewing it, so copy it right away.

> If users reach Kladde under several addresses (e.g. internal and external), GitLab sign-in only works under the address from `PUBLIC_URL`. GitLab allows several redirect URIs (one per line), but Kladde always uses `PUBLIC_URL`.

---

## 2. Configure the container

The variables are already prepared in `docker-compose.yml` and empty by default. The easiest way is to set them in a `.env` next to `docker-compose.yml`:

```env
PUBLIC_URL=https://notes.example.org
TRUST_PROXY=1

GITLAB_URL=https://gitlab.example.org
GITLAB_CLIENT_ID=6f1c…            # application ID
GITLAB_CLIENT_SECRET=gloas-…      # secret
GITLAB_LABEL=Company GitLab       # optional: button label
GITLAB_ALLOWED_GROUPS=family      # optional: only members of these groups
SIGNUP_WITHOUT_INVITE=gitlab      # optional: register GitLab users without an invitation
# GITLAB_INTERNAL_URL=http://gitlab   # optional: see "Networking"
```

Then **recreate** the container (a `docker restart` does not pick up changed variables):

```bash
docker compose up -d
```

The sign-in page now shows "Sign in with GitLab" (or "Sign in with Company GitLab").

Without Compose:

```bash
docker run -d --name kladde -p 13002:3002 -v kladde-data:/app/data \
  -e PUBLIC_URL=https://notes.example.org -e TRUST_PROXY=1 \
  -e GITLAB_URL=https://gitlab.example.org \
  -e GITLAB_CLIENT_ID=… -e GITLAB_CLIENT_SECRET=… \
  kladde
```

### All variables

| Variable | Meaning |
| --- | --- |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | From the OAuth application. **Both set = feature on**, otherwise off |
| `GITLAB_URL` | Address of the GitLab instance as the **browser** reaches it. Default `https://gitlab.com`. If GitLab is installed under a path, include it, e.g. `https://example.org/gitlab` |
| `GITLAB_INTERNAL_URL` | Optional. Address the **Kladde server** uses to reach GitLab for tokens and user data. Empty = `GITLAB_URL` |
| `GITLAB_ALLOWED_GROUPS` | Comma-separated **full group paths** (as in the URL, e.g. `family,company/team`). Subgroups count too. Empty = every GitLab user of the instance |
| `SIGNUP_WITHOUT_INVITE` | If it contains `gitlab`, unknown GitLab users get a new account without an invitation (see *Sign-up without invitation*). Best combined with `GITLAB_ALLOWED_GROUPS`. The older variable `GITLAB_ALLOW_SIGNUP=1` has the same effect |
| `GITLAB_LABEL` | Name on the button, default `GitLab` |

Better not write the secret into a checked-in file; `.env` does not belong in Git.

---

## 3. Networking with a self-hosted GitLab

The browser and the Kladde server both talk to GitLab:

- **Browser → `GITLAB_URL`/oauth/authorize** (sign-in and consent)
- **Kladde container → `GITLAB_INTERNAL_URL` or `GITLAB_URL`** `/oauth/token` and `/oauth/userinfo`

### The container cannot reach GitLab at its public address

Typical in a home network: `gitlab.example.org` points to the public IP and the router cannot do hairpin NAT; or GitLab runs on the same Docker host. Then set `GITLAB_INTERNAL_URL` to an address the container can reach:

```env
GITLAB_URL=https://gitlab.example.org          # for the browser
GITLAB_INTERNAL_URL=http://192.168.1.20        # for the Kladde server
```

If both containers are in the same Docker network, the container name works too (e.g. `http://gitlab`). Important: the internal address must answer `/oauth/token` **directly** and must not redirect to HTTPS or another address (with Omnibus, mind `nginx['redirect_http_to_https']`, or use the internal address over HTTPS with a matching certificate).

### Custom certificate (internal CA, self-signed)

Node.js trusts only the usual public certificate authorities. If GitLab's certificate is issued by your own CA, sign-in fails with "GitLab ist gerade nicht erreichbar." (GitLab is not reachable right now) and the log shows e.g. `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Fix: put the CA certificate (PEM) into the container and announce it with `NODE_EXTRA_CA_CERTS`:

```yaml
services:
  kladde:
    environment:
      - NODE_EXTRA_CA_CERTS=/certs/gitlab-ca.pem
    volumes:
      - ./gitlab-ca.pem:/certs/gitlab-ca.pem:ro
```

The file must be world-readable (`chmod 644`) because Kladde runs as user `node` in the container. Turning off TLS verification (`NODE_TLS_REJECT_UNAUTHORIZED=0`) is not a good idea.

### Test the connection

```bash
docker exec kladde node -e "fetch((process.env.GITLAB_INTERNAL_URL||process.env.GITLAB_URL)+'/.well-known/openid-configuration').then(r=>console.log('HTTP',r.status)).catch(e=>console.error(e.cause??e))"
```

`HTTP 200` = all good. An error with `ENOTFOUND`, `ECONNREFUSED` or `ETIMEDOUT` means the container does not reach GitLab (→ `GITLAB_INTERNAL_URL`, firewall, Docker network); a certificate error → `NODE_EXTRA_CA_CERTS`.

### GitLab itself

- `external_url` in `/etc/gitlab/gitlab.rb` must match the address in `GITLAB_URL`, otherwise GitLab redirects to a wrong address during sign-in.
- If the instance is reachable only in the LAN or via VPN, GitLab sign-in works only there as well. Passkey/password remain the way in from elsewhere.

---

## 4. Linking and registering accounts

- **Existing accounts:** sign in as before, then *Settings → Sign in with GitLab → Link GitLab*. From then on the GitLab button is enough.
- **New people with an invitation:** open the invitation link and choose "Register with GitLab". The Kladde username is derived from the GitLab username (with a suffix on collision).
- **New people without an invitation:** when `SIGNUP_WITHOUT_INVITE` contains `gitlab`. Then the normal "Sign in with GitLab" button is enough: if the GitLab account is still unknown, Kladde creates an account right away.
- With `GITLAB_ALLOWED_GROUPS` **every** GitLab sign-in is checked (linked accounts too). Whoever leaves the group can no longer get in through GitLab, but still with passkey/password.
- Suspended accounts stay suspended. A link can only be removed as long as a passkey or password remains.
- Every GitLab sign-in, link and rejection appears in the audit log under *Settings → Administration*.

### Sign-up without invitation, per sign-in method

`SIGNUP_WITHOUT_INVITE` decides per installation **which sign-in methods may create new accounts without an invitation**. All others still need an invitation. Invitation links always work, also for open sign-in methods.

| Value | Effect |
| --- | --- |
| *(empty)* | Default: every new account needs an invitation |
| `gitlab` | GitLab users register freely, passkey/password only with an invitation. Typical for your own GitLab |
| `gitlab,password` | Additionally open registration with username and password |
| `all` | Every sign-in method is open (`gitlab,passkey,password`) |

If `passkey` or `password` is open, the sign-in page shows "Create new account" (`/register`). GitLab needs no button of its own: "Sign in with GitLab" creates unknown users directly.

```env
# Company instance: everyone in the group "company" may join, nobody else without an invitation
SIGNUP_WITHOUT_INVITE=gitlab
GITLAB_ALLOWED_GROUPS=company
```

### Sign in only with GitLab

`LOGIN_METHODS` decides which sign-in methods exist at all (default: all of them). With only `gitlab`, the sign-in page shows just the GitLab button: no username and password, no passkeys, no device codes. The server refuses those routes too, and in the settings the sections for passkeys and the password disappear.

```env
LOGIN_METHODS=gitlab
SIGNUP_WITHOUT_INVITE=gitlab      # optional: colleagues join without an invitation
GITLAB_ALLOWED_GROUPS=company
```

- **Before switching:** existing accounts must have linked GitLab (*Settings → Sign in with GitLab*), otherwise they can no longer get in.
- The GitLab link can no longer be removed (it is the only way in).
- `LOGIN_METHODS=gitlab` without `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET` stops the server at start with a clear message, instead of locking everyone out. Unknown names in the list stop it as well.
- Combinations work too, e.g. `LOGIN_METHODS=gitlab,passkey`.

> Open registration by passkey or password on a publicly reachable instance means **anyone** on the internet can create an account. For GitLab, `GITLAB_ALLOWED_GROUPS` limits that; without groups and with `GITLAB_URL=https://gitlab.com`, anyone with a GitLab.com account can get in.

---

## 5. Troubleshooting

The server's sign-in messages are German; the English meaning is given in parentheses.

| Message / symptom | Cause and fix |
| --- | --- |
| No GitLab button | `GITLAB_CLIENT_ID` or `GITLAB_CLIENT_SECRET` missing, or the container was only restarted instead of recreated (`docker compose up -d`). `docker logs kladde` shows whether `GITLAB_URL` is invalid |
| GitLab: "The redirect URI included is not valid." | The redirect URI in GitLab does not match `PUBLIC_URL` + `/api/auth/gitlab/callback`. Watch the scheme (`http`/`https`), port and trailing slash. Set `PUBLIC_URL` |
| GitLab: "Client authentication failed due to unknown client …" | Wrong `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET`, or the application was created on a different instance than `GITLAB_URL` |
| GitLab: "The requested scope is invalid …" | The application lacks `openid` or `profile` |
| "GitLab ist gerade nicht erreichbar." (GitLab is not reachable right now) | The container does not reach GitLab or does not trust its certificate. See *Test the connection*, `GITLAB_INTERNAL_URL`, `NODE_EXTRA_CA_CERTS`. Details in `docker logs kladde` |
| "GitLab hat die Anmeldung nicht bestätigt." (GitLab did not confirm the sign-in) | Token exchange refused: wrong secret, application not "confidential", or the redirect URI differs |
| "Die GitLab-Anmeldung ist abgelaufen, bitte noch einmal." (the GitLab sign-in expired, please try again) | More than 10 minutes at GitLab, container restarted in between, or Kladde was opened under an address other than `PUBLIC_URL` (the cookie is missing then) |
| "Dein GitLab-Konto gehört zu keiner freigegebenen Gruppe." (your GitLab account is in no allowed group) | `GITLAB_ALLOWED_GROUPS` contains the display name instead of the **path** (from the URL, e.g. `company/team`), or the person is not a member |
| "Dieses GitLab-Konto ist mit keinem Kladde-Konto verknüpft …" (this GitLab account is not linked to a Kladde account) | Link it in the settings first, register with an invitation, or set `SIGNUP_WITHOUT_INVITE=gitlab` |

---

## Switching it off

Clear `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` and run `docker compose up -d`. The button disappears; existing links stay stored and apply again as soon as the feature is switched back on. Accounts that use **only** GitLab then need a device code or a password reset under *Settings → Administration*.

# Security Policy

Kladde stores personal notes, handles sign-in (passkeys, passwords, GitLab OAuth), shares notes between users and exposes an MCP endpoint. We take security reports seriously.

## Supported versions

Only the latest release receives security fixes. Please update before reporting, if you can.

| Version | Supported |
| --- | --- |
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report them privately through GitHub:
**[Report a vulnerability](https://github.com/steveee99/kladde-notes/security/advisories/new)** (Security tab → "Report a vulnerability").

Please include:

- what is affected (component, endpoint, version) and the impact you see,
- steps to reproduce or a proof of concept,
- your deployment (Docker, desktop mode, reverse proxy) if it matters.

What to expect:

- an acknowledgement within a few days,
- a fix or a mitigation plan as soon as the issue is confirmed,
- credit in the release notes if you want it.

This is a hobby project maintained by one person, so please allow some time. Please give us a reasonable period to ship a fix before you disclose the issue publicly.

## Scope

In scope: authentication and sessions, access control between users (spaces, shares, public links), encryption at rest, the sync, import and MCP APIs, the Docker image and its defaults.

Out of scope: problems that need a fully compromised server or browser, missing HTTPS on a deployment that you configured without it, denial of service by an authenticated admin, and findings in third-party dependencies without a demonstrable impact on Kladde (report those upstream).

## Hardening notes for operators

- Run Kladde behind HTTPS (passkeys require it) and set `PUBLIC_URL` and `TRUST_PROXY` correctly.
- Pass `DATA_KEY` as a secret instead of keeping the key file next to the database, and back the key up. Without it the notes cannot be decrypted.
- `DEV_LOGIN` is for local development only and is ignored in production mode. Never set it on a public instance.

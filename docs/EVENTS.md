# Git events and central webhooks

*Deutsch: [EVENTS.de.md](EVENTS.de.md)*

Kladde takes webhooks from GitLab and GitHub at one place, turns their deliveries into a small set of **git events**
and hands them to everyone who subscribes on the server's **event bus**: Kladde's own ticket automations and any
number of [plugins](PLUGINS.md). One webhook per GitLab project or group (or GitHub repository) is enough, however
many plugins use its events.

```
GitLab / GitHub ──► POST /api/events/hooks/<id> ──► check secret ──► normalise ──► drop repeats ──► event bus
                                                                                                    ├─► ticket automations
                                                                                                    ├─► plugin A (events: {...})
                                                                                                    └─► plugin B
```

## Setting up a webhook

1. In Kladde: **Settings → Webhooks → New webhook**. Choose GitLab or GitHub, give it a name and optionally the
   project paths it should take (`team/app`, or a group path like `team` for everything below it). Owners of a
   group can create the webhook for the group instead of their own account.
2. Kladde shows the address and the secret **once**. The secret is stored encrypted; "New secret" replaces it.
3. At the provider:
   - **GitLab:** *Settings → Webhooks* of the project or of the group (group webhooks need GitLab Premium). URL and
     *Secret token* from Kladde, then pick the triggers: Push events, Tag push events, Comments, Confidential
     comments, Issues events, Confidential issues events, Merge request events, Job events, Pipeline events,
     Deployment events, Wiki page events, Releases events. Kladde ignores what it does not need, so ticking more
     is harmless.
   - **GitHub:** *Settings → Webhooks → Add webhook* of the repository or organisation. Payload URL and secret from
     Kladde, **Content type `application/json`**, then "Let me select individual events": Pull requests, Pull
     request reviews, Pushes, Workflow runs, Workflow jobs, Issues, Issue comments, Pull request review comments,
     Commit comments, Releases, Deployment statuses, Wiki.
4. GitLab's "Test" button and GitHub's ping show up as *Ignored* in the delivery list: the connection works.

The settings list the latest 20 deliveries of every webhook (status, time, event, project, result — never the
payload). Statuses:

| Status | Meaning |
| --- | --- |
| Delivered (`accepted`) | Published on the bus; the detail names what the subscribers did |
| Failed (`failed`) | At least one subscriber threw an error (named in the detail); the others still ran |
| Refused (`invalid`) | Wrong secret or no JSON |
| Ignored (`ignored`) | An event Kladde does not know (ping, member changes, …) |
| Filtered (`filtered`) | The project is not in the webhook's list of paths |
| Repeat (`duplicate`) | The same delivery id came again (a retry): not published a second time |

## How deliveries are handled

- **Address and secret:** the id in the address finds the webhook, the secret proves the sender: GitLab's
  `X-Gitlab-Token` is compared in constant time, GitHub's `X-Hub-Signature-256` is checked as HMAC-SHA256 over the
  raw body. Unknown ids and wrong secrets get the same `404`.
- **Limits:** at most 2 MB per delivery, 300 deliveries per minute and address of the sender, 20 webhooks per
  account or group, 20 project paths per webhook.
- **Repeats:** the delivery id (`X-Gitlab-Event-UUID`, `X-GitHub-Delivery`; without one a hash of the body) is
  remembered for 3 days per webhook. A retry of the same delivery is answered with `200` and not published again.
- **Answer first:** Kladde answers `202` as soon as the event is on the bus; the subscribers run afterwards and
  their outcome lands in the delivery list. Events live in memory only: what is still queued when the server
  restarts is lost (GitLab and GitHub do not resend a delivery that got `202`).
- **Isolation:** every subscriber (the ticket automations, every plugin) has its own queue and gets its events one
  after another in arrival order. An error only marks the delivery as *Failed*, is logged and shows up in the
  admin dashboard's jobs; other subscribers are not affected.
- **Bounded content:** titles and paths are cut to a few hundred characters, descriptions, messages and comment
  bodies to 4,000, lists (labels, assignees, …) to 20 entries, the commits of a push to the newest 20.

## The event envelope

Every event has these fields; the type-specific object follows below.

| Field | Type | Content |
| --- | --- | --- |
| `id` | string | Delivery id (see above). Use it to make handlers idempotent |
| `type` | string | One of the types below, e.g. `git.merge_request` |
| `action` | string | What happened, per type |
| `provider` | `'gitlab' \| 'github'` | Where it came from |
| `project` | `{ path, name, url, defaultBranch }` | Repository: `group/sub/project` or `owner/repo` |
| `actor` | `{ username, name } \| null` | Who caused it |
| `at` | number | When it happened (provider time when available), ms since 1970 |
| `owner` | `{ kind: 'user' \| 'group', id, name }` | Whose webhook delivered it |
| `users` | string[] | Plugins only: the accounts it is for (see [Plugins](#plugins)) |
| `raw` | unknown | Plugins only, on request: the provider's JSON |

## Event types

The types and their fields are part of the plugin API (since 1.4.0): new types, actions or fields come with a minor
version, changes and removals with a major one.

### `git.merge_request`

Merge requests (GitLab) and pull requests (GitHub).

| Action | GitLab | GitHub |
| --- | --- | --- |
| `opened` | `open` | `opened`, `ready_for_review` |
| `reopened` | `reopen` | `reopened` |
| `updated` | `update` (new commits, title, labels, …) | `edited`, `synchronize`, `labeled`, `unlabeled`, `assigned`, `unassigned`, `review_requested`, `converted_to_draft` |
| `merged` | `merge` | `closed` with `merged: true` |
| `closed` | `close` | `closed` without merge |
| `approved` | `approved`, `approval` | review `submitted` with state `approved` |
| `unapproved` | `unapproved`, `unapproval` | review `dismissed` |

`mergeRequest`: `number` (GitLab `iid`), `title`, `description`, `url`, `state` (`open`/`merged`/`closed`),
`draft`, `sourceBranch`, `targetBranch`, `sha` (last commit), `author`, `labels`, `assignees`, `reviewers`.

### `git.push`

Pushes to branches (GitLab *Push Hook*, GitHub `push` to `refs/heads/…`).

| Action | When |
| --- | --- |
| `pushed` | Commits on an existing branch |
| `created` | New branch (`before` is all zeros / `created: true`) |
| `deleted` | Branch deleted (`after` is all zeros / `deleted: true`) |

`push`: `ref` (`refs/heads/main`), `branch`, `before`, `after`, `commits` (newest 20: `sha`, `title` (first line),
`message`, `url`, `author`, `at`), `commitCount` (all commits of the push).

### `git.tag`

Tags (GitLab *Tag Push Hook*, GitHub `push` to `refs/tags/…`). Actions `created`, `deleted`.
`tag`: `name` (`v1.2.0`), `ref`, `sha`, `message` (annotated tags on GitLab).

### `git.pipeline`

CI pipelines (GitLab *Pipeline Hook*) and GitHub Actions workflow runs (`workflow_run`). The action is the status:

| Action / status | GitLab | GitHub |
| --- | --- | --- |
| `created` | `created` | – |
| `waiting` | `waiting_for_resource` | `waiting` |
| `pending` | `pending`, `preparing` | `queued`, `requested` |
| `running` | `running` | `in_progress` |
| `success` | `success` | conclusion `success`, `neutral` |
| `failed` | `failed` | conclusion `failure`, `timed_out`, `startup_failure` |
| `canceled` | `canceled`, `canceling` | conclusion `cancelled`, `stale` |
| `skipped` | `skipped` | conclusion `skipped` |
| `manual` | `manual` | conclusion `action_required` |
| `scheduled` | `scheduled` | – |

`pipeline`: `id`, `status`, `ref`, `sha`, `url`, `source` (`push`, `merge_request_event`, `schedule`, `web`, …;
GitHub: the triggering event), `mergeRequest` (number or null), `durationSeconds`, `name` (GitHub: workflow name;
GitLab: the pipeline's name when set).

### `git.job`

Single CI jobs (GitLab *Job Hook*, GitHub `workflow_job`). Actions and statuses as for pipelines.
`job`: `id`, `name`, `stage` (GitHub: the workflow's name), `status`, `ref`, `sha`, `url`, `pipelineId`,
`allowFailure`, `durationSeconds`, `failureReason` (GitLab: e.g. `script_failure`, `runner_system_failure`).

### `git.comment`

Comments (GitLab *Note Hook* and *Confidential Note Hook*, GitHub `issue_comment`, `pull_request_review_comment`,
`commit_comment`). Actions `created`, `edited`, `deleted` (GitLab reports new comments and, in newer versions,
edited ones).
`comment`: `id`, `body`, `url`, `on` (`merge_request`, `issue`, `commit`, `snippet`), `number` (of the merge
request or issue, else null), `title` (its title), `sha` (commented commit).

### `git.issue`

Issues (GitLab *Issue Hook* and *Confidential Issue Hook*, GitHub `issues`). Actions `opened`, `reopened`,
`updated` (edits, labels, assignees), `closed`.
`issue`: `number`, `title`, `description`, `url`, `state` (`open`/`closed`), `author`, `labels`, `assignees`,
`confidential`.

### `git.release`

Releases (GitLab *Release Hook*, GitHub `release`). Actions `created` (GitHub: `published`; drafts stay quiet),
`updated`, `deleted`. `release`: `tag`, `name`, `description`, `url`.

### `git.deployment`

Deployments (GitLab *Deployment Hook*, GitHub `deployment_status`). The action is the status: `created`, `running`,
`success`, `failed` (GitHub `failure`, `error`), `canceled` (GitHub `inactive`).
`deployment`: `id`, `environment`, `status`, `ref`, `sha`, `url` (environment or job address).

### `git.wiki`

Wiki pages (GitLab *Wiki Page Hook*, GitHub `gollum`). Actions `created`, `updated`, `deleted` (GitHub only
reports created and edited pages). `wiki`: `title`, `slug`, `url`.

### Not (yet) normalised

GitLab: member, subgroup, project, feature flag, emoji, resource access token and vulnerability events; system
hooks. GitHub: stars, forks, check runs/suites, discussions, packages, security advisories and everything else.
They are answered and listed as *Ignored*. Ideas for further types belong in an issue; until then a plugin can
take them through its own `publicRoutes` ([PLUGINS.md](PLUGINS.md)).

## Ticket automations

Ticket projects (`project` block, see the project settings) are the bus's first subscriber: `git.merge_request`
events with `opened`/`reopened` (trigger *merge request opened*), `merged` and `closed` run the automations of
every ticket project of the webhook's **owner** whose ticket ids the merge request names in its title, branch or
description (`KLD-12`). Changes are made as the person who created the webhook, who must still be allowed to change
the project. The project's own webhooks (*Project settings → Git integration*) keep working; using both for the
same repository runs the automations twice (usually harmless, since they set the same status).

## Plugins

A server plugin subscribes with `events`, one handler per type (plugin API 1.4.0):

```ts
import { defineServerPlugin } from '@kladde/plugin-api/server';

export default defineServerPlugin({
  id: 'enhancements',
  events: {
    async 'git.merge_request'(event, ctx) {
      if (event.action !== 'merged') return;
      for (const userId of event.users) {
        ctx.notify(userId, { title: `Merged: ${event.mergeRequest.title}`, text: event.project.path });
      }
    },
    'git.pipeline'(event, ctx) {
      if (event.action === 'failed') ctx.log.warn(`Pipeline ${event.pipeline.id} failed on ${event.pipeline.ref}`);
    },
  },
  // rawPayload: ['git.push'],   // only when the normalised fields are not enough
});
```

- A plugin gets an event only for people who **switched the plugin on**: for an account's webhook its owner, for a
  group's webhook the group's members. `event.users` lists them (never empty); use them with `ctx.notes`,
  `ctx.notify` and the plugin's own tables. `event.owner` says whose webhook it was.
- Every plugin gets its own copy of the event; plugins never see webhook ids, secrets or other owners' events.
- `rawPayload: ['git.push', …]` adds the provider's JSON as `event.raw` for those types. It can be large and its
  shape is the provider's, not part of the plugin API.
- Handlers of one plugin run one after another; keep them short or hand long work to a job. A thrown error marks
  the delivery as *Failed* with the plugin's name and is logged; it never reaches other plugins.
- Make handlers idempotent (by `event.id` or by the object they change): the same change can arrive twice through
  two webhooks (a project's and its group's).
- Unknown types in `events` or `rawPayload` stop the server's start, like a bad MCP tool name.

The example plugin (`examples/kladde-plugin-logbook`) writes a logbook entry for every merged merge request, once
per delivery id.

## API for the settings

All routes need a signed-in account; group webhooks are managed by the group's owners.

| Route | Purpose |
| --- | --- |
| `GET /api/event-sources` | Webhooks of the account and of the groups it owns, with their latest deliveries |
| `POST /api/event-sources` | `{ provider, name?, projects?, group? }` → `{ source, secret }` |
| `PATCH /api/event-sources/:id` | `{ name?, projects? }` |
| `POST /api/event-sources/:id/rotate` | New secret → `{ secret }` |
| `DELETE /api/event-sources/:id` | Removes the webhook (its address answers 404 from then on) |
| `POST /api/events/hooks/:id` | The address for GitLab/GitHub (no account; the secret proves the sender) |

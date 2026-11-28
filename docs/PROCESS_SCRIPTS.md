# Process scripts and loops

Guided processes (part of the cockpit, `/processes`) describe a development process as stages. Two features make a
process do things on its own:

- **Stage scripts**: `onEnter` runs when a run enters a stage, `onExit` when it leaves it. Scripts change run
  variables, tick steps off, notify people and create notes.
- **Loops**: a stage of kind `loop` repeats a group of stages until a condition holds, a number of rounds passed or
  every item of a list had its round.

This page explains both and ends with a complete example: the V-Model.

## Scripts

### The script editor

On a model's page, select a stage in the graph and press **Add script** below its details (or **Edit** next to an
existing one). The script editor opens only then, and it closes again after saving:

- the slot to write: **On enter** or **On exit** (an end stage has only On enter),
- highlighting of functions, strings, `{{run.x}}`, variables, keywords, numbers and comments,
- suggestions while typing (**Ctrl+Space** asks for them): functions with their parameters, run variables (also
  after `{{run.`), step ids in `done()`/`undone()`, variables in `set()`/`inc()`/`clear()`, template names as the
  second argument of `note()`, and `owner`, `me`, `all` and people after `@` in `notify()`,
- problems underlined in red while typing, with the message below the editor; a script with problems cannot be
  saved,
- **Ctrl+/** comments a line in or out, **Remove script** deletes it.

Saving writes the model like any other change, so its version goes up. In the JSON editor a script is a string with
one statement per line, or a list of lines:

```json
"onEnter": [
  "plan = note(\"Tests/{{run.ticket}} Test plan\", \"Test plan\")",
  "notify(\"all\", \"Please review {{run.title}}: {{run.plan}}\")"
]
```

`#` starts a comment. Strings are written in double (or single) quotes and fill in `{{run.x}}`. Bare names
(`ticket`, `run.ticket`) are run variables. Kladde never runs JavaScript: the language only knows the functions
below.

### Functions

| Function | What it does |
| --- | --- |
| `notify(to, text)` | Notifies people (in the app and as a push message). `to` holds one or more of `owner` (who started the run), `me` (who moves it right now), `all` (everyone who can see the run, except the person moving it) and user names (`@anna @ben`). Only people who can see the run are reached. |
| `note(path, template?)` | Creates a note at `path` in the run's space (the own space or the group), optionally from one of the templates of the person who moves the run. Returns the path, so `plan = note(…)` keeps it in a variable. A note that already exists is left as it is. |
| `set(name, value)` | Sets a run variable, like `name = value`. |
| `inc(name, step?)` | Counts a variable up by 1 (or by `step`). |
| `clear(name)` | Empties a variable. |
| `done(step)` / `undone(step)` | Ticks a step off (by its id) or opens it again. |
| `log(text)` | Writes a line into the run's actions. |

### Assignments and conditions

```text
attempt = attempt + 1                 # numbers add up, other values are joined as text
label = "Round " + attempt
if attempt >= 3: notify("owner", "{{run.title}} needs a third attempt")
if result == "failed" and not hotfix: log("Regular fix")
```

Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=` (numbers are compared as numbers). Join them with `and` and `or`,
negate with `not`. A name on its own is true when the variable is set and not `0`, `false` or `nein`.

The run's own fields (`title`, `ticket`, `target`, `branch`, `repos`) can be read but not overwritten.

### When the actions happen

Variables and steps change at once, while the run moves. Notifications and new notes are written into the run as
**actions**. Kladde's server carries out each one once, as soon as the changed run is saved: from the app, from a
device that comes back online, or from an AI assistant through MCP. The run page lists the actions with their outcome
(waiting, done, skipped, failed) and a link to every note created. Saving the run again, or opening it on another
device, does not repeat them. Actions older than 14 days are not carried out any more.

A line with an error is reported when the model is saved (with its line number) and, while running, shows up in red
in the run's actions. The other lines still run.

Limits: 60 lines and 20 actions per script.

## Loops

```json
{
  "id": "review",
  "kind": "loop",
  "title": "Review rounds",
  "body": "check",
  "var": "round",
  "max": 3,
  "until": { "var": "verdict", "op": "eq", "value": "ok" },
  "next": [{ "to": "release" }]
}
```

- `body` is the first stage of a round. A round ends when a way from its stages leads back to the loop stage
  (`"next": [{ "to": "review" }]`, or a decision option with `"to": "review"`).
- Before every round the loop checks `until`, `max` (default 10, at most 100) and, with `over`, whether items are
  left. When the loop is over, the run takes the loop's `next`.
- `var` counts the rounds (1, 2, …; default `runde`). With `"over": "repos"` there is one round per item of the comma
  separated variable, and the item is in `<var>_item` (here `round_item`).
- In every new round the steps of the round's stages are open again and its decisions are made again. Linked pages
  stay.
- `onEnter` of a loop runs at the start of every round, `onExit` once when the loop lets the run out.
- The loop never waits for anybody: it starts a round or lets the run out at once.

## Example: the V-Model

In the V-Model every design level on the left side of the V has a test level on the right side that verifies it:

```text
Requirements ─────────────────────────────── Acceptance test
   System design ─────────────────────── System test
      Architecture ──────────────── Integration test
         Module design ───────── Unit tests
                    Implementation
```

The model below follows the V from the top left to the top right:

- **Plans with the design.** Each design stage creates the test plan of its counterpart with `note()` (from a
  template called "Test plan") and keeps the path in a variable, so later stages and notifications can point to it.
- **Reviewers are notified.** The system design asks everyone who sees the run for a review, and the acceptance test
  tells everyone that the work is ready.
- **Unit tests per repository.** The loop `unittests` runs one round per repository of the run (`"over": "repos"`);
  the check in each round reads the pipeline jobs of just that repository (`{{run.repo_item}}`).
- **Integration test until it passes.** The loop `integration` repeats test and decision until the result is
  `passed`, at most three times. Every round gets its own report note. From the second round on everyone is
  notified; if three rounds were not enough, the owner hears about it and the stage `integrationgate` (only when the
  test did not pass) leads back into the architecture.
- **Ways back** from every test level to its design level.

To use it, create the templates "Test plan" and "Test report" (Settings → Templates), open `/processes`, create a new
model, open its JSON editor and paste:

```json
{
  "key": "v-model",
  "title": "V-Model",
  "description": "Every design level on the left has a test level on the right that verifies it. Test plans are created while designing, tests repeat until they pass.",
  "branchPrefix": "feature",
  "branchPattern": "{{prefix}}/{{ticket}}-{{slug}}",
  "start": "requirements",
  "stages": [
    {
      "id": "requirements",
      "title": "Requirements",
      "description": "What the business needs. The acceptance test is planned now, against these requirements.",
      "onEnter": [
        "# The right side of the V is planned together with the left side",
        "acceptanceplan = note(\"V-Model/{{run.ticket}}/Acceptance test plan\", \"Test plan\")",
        "notify(\"owner\", \"{{run.ticket}}: requirements started, acceptance test plan is {{run.acceptanceplan}}\")"
      ],
      "steps": [
        { "id": "r1", "kind": "link", "label": "Link the requirements in Jira", "var": "requirements", "source": "jira" },
        { "id": "r2", "kind": "task", "label": "Acceptance criteria written into the acceptance test plan" }
      ],
      "onExit": "log(\"Requirements frozen\")",
      "next": [{ "to": "system" }]
    },
    {
      "id": "system",
      "title": "System design",
      "description": "The system as a whole: interfaces to the outside, non-functional requirements.",
      "onEnter": [
        "systemplan = note(\"V-Model/{{run.ticket}}/System test plan\", \"Test plan\")",
        "notify(\"all\", \"{{run.title}}: please review the system design\")"
      ],
      "steps": [
        { "id": "s1", "kind": "link", "label": "Link the system design", "var": "systemdesign", "source": "confluence" },
        { "id": "s2", "kind": "task", "label": "System design reviewed" }
      ],
      "next": [{ "to": "architecture" }, { "to": "requirements", "back": true, "label": "Requirements unclear" }]
    },
    {
      "id": "architecture",
      "title": "Architecture",
      "description": "Components and how they talk to each other.",
      "onEnter": "integrationplan = note(\"V-Model/{{run.ticket}}/Integration test plan\", \"Test plan\")",
      "steps": [
        { "id": "a1", "kind": "link", "label": "Link the architecture", "var": "architecture", "source": "confluence" },
        { "id": "a2", "kind": "task", "label": "Architecture reviewed" }
      ],
      "next": [{ "to": "modules" }, { "to": "system", "back": true, "label": "Back to the system design" }]
    },
    {
      "id": "modules",
      "title": "Module design",
      "description": "The inner design of every module, with its unit tests.",
      "steps": [
        { "id": "m1", "kind": "task", "label": "Module design written" },
        { "id": "m2", "kind": "task", "label": "Unit test cases defined" }
      ],
      "next": [{ "to": "implementation" }]
    },
    {
      "id": "implementation",
      "title": "Implementation",
      "description": "The bottom of the V: the code, on its own branch in every repository.",
      "onEnter": "notify(\"me\", \"Branch to create: {{run.branch}} from {{run.target}}\")",
      "steps": [
        { "id": "i1", "kind": "branch", "label": "Branch created in every repository" },
        { "id": "i2", "kind": "mr", "label": "Merge request opened in every repository", "mrState": "opened" }
      ],
      "next": [{ "to": "unittests" }]
    },
    {
      "id": "unittests",
      "kind": "loop",
      "title": "Unit tests per repository",
      "description": "One round per repository of the run.",
      "var": "repo",
      "over": "repos",
      "max": 30,
      "body": "unittest",
      "onExit": "log(\"Unit tests passed in {{run.repo}} repositories\")",
      "next": [{ "to": "integration" }]
    },
    {
      "id": "unittest",
      "title": "Unit test",
      "description": "Verifies the module design, in one repository at a time.",
      "steps": [
        {
          "id": "u1",
          "kind": "check",
          "label": "No red jobs in this repository",
          "query": { "source": "gitlab.jobs", "params": { "projects": ["{{run.repo_item}}"], "ref": "{{run.branch}}", "since": "7d", "latestOnly": true }, "filters": [] },
          "expect": "none"
        },
        { "id": "u2", "kind": "task", "label": "Coverage of the new code checked" }
      ],
      "next": [{ "to": "unittests" }]
    },
    {
      "id": "integration",
      "kind": "loop",
      "title": "Integration test rounds",
      "description": "Repeats the integration test until it passes, at most three times.",
      "var": "integrationround",
      "max": 3,
      "until": { "var": "integrationresult", "op": "eq", "value": "passed" },
      "body": "integrationtest",
      "onEnter": [
        "if integrationround > 1: notify(\"all\", \"{{run.title}}: integration test round {{run.integrationround}}\")"
      ],
      "onExit": [
        "if integrationresult != \"passed\": notify(\"owner\", \"{{run.title}}: integration test still failing after {{run.integrationround}} rounds\")"
      ],
      "next": [{ "to": "integrationgate" }]
    },
    {
      "id": "integrationtest",
      "title": "Integration test",
      "description": "Verifies the architecture: the components work together.",
      "onEnter": "report = note(\"V-Model/{{run.ticket}}/Integration test round {{run.integrationround}}\", \"Test report\")",
      "steps": [
        { "id": "t1", "kind": "task", "label": "Integration test run, results in the round's report" }
      ],
      "next": [{ "to": "integrationresult" }]
    },
    {
      "id": "integrationresult",
      "kind": "choice",
      "title": "Integration result",
      "var": "integrationresult",
      "options": [
        { "value": "passed", "label": "Passed", "to": "integration" },
        { "value": "failed", "label": "Failed", "hint": "Another round", "to": "integration" }
      ]
    },
    {
      "id": "integrationgate",
      "title": "Integration not passed",
      "description": "Only when three rounds were not enough: back into the architecture.",
      "when": { "var": "integrationresult", "op": "ne", "value": "passed" },
      "steps": [{ "id": "g1", "kind": "task", "label": "Cause found and written down" }],
      "next": [{ "to": "systemtest" }, { "to": "architecture", "back": true, "label": "Rework the architecture" }]
    },
    {
      "id": "systemtest",
      "title": "System test",
      "description": "Verifies the system design.",
      "steps": [
        { "id": "st1", "kind": "link", "label": "Link the system test report", "var": "systemreport", "source": "confluence" },
        { "id": "st2", "kind": "task", "label": "Non-functional requirements met" }
      ],
      "onExit": "log(\"System test passed after {{run.integrationround}} integration round(s)\")",
      "next": [{ "to": "acceptance" }, { "to": "system", "back": true, "label": "Back to the system design" }]
    },
    {
      "id": "acceptance",
      "title": "Acceptance test",
      "description": "Validates the requirements with the business side.",
      "onEnter": "notify(\"all\", \"{{run.title}} is ready for acceptance – plan: {{run.acceptanceplan}}\")",
      "steps": [
        { "id": "ac1", "kind": "task", "label": "Accepted by the business side" }
      ],
      "next": [{ "to": "release" }, { "to": "requirements", "back": true, "label": "Requirements missed" }]
    },
    {
      "id": "release",
      "title": "Release",
      "steps": [{ "id": "rl1", "kind": "mr", "label": "Merge requests merged", "mrState": "merged" }],
      "next": [{ "to": "done" }]
    },
    {
      "id": "done",
      "kind": "end",
      "title": "Released",
      "end": "released",
      "onEnter": "notify(\"all\", \"{{run.ticket}} {{run.title}} is released\")"
    }
  ]
}
```

### A run through the model

Started with the ticket `SHOP-412`, the title "Voucher" and the repositories `shop/web` and `shop/api`, a run goes
through these stages (loops show their rounds):

```text
requirements > system > architecture > modules > implementation
  > unittests (round 1: shop/web) > unittest > unittests (round 2: shop/api) > unittest > unittests (over after 2 rounds)
  > integration (round 1) > integrationtest > integrationresult: failed
  > integration (round 2) > integrationtest > integrationresult: passed
  > integration (over after 2 rounds) > integrationgate (skipped: the test passed)
  > systemtest > acceptance > release > done
```

and leaves these actions:

| Stage | When | Action |
| --- | --- | --- |
| Requirements | enter | Note `V-Model/SHOP-412/Acceptance test plan` from "Test plan" |
| Requirements | enter | Notification to `owner`: "SHOP-412: requirements started, acceptance test plan is V-Model/SHOP-412/Acceptance test plan" |
| Requirements | exit | Log: "Requirements frozen" |
| System design | enter | Note `V-Model/SHOP-412/System test plan` from "Test plan" |
| System design | enter | Notification to `all`: "Voucher: please review the system design" |
| Architecture | enter | Note `V-Model/SHOP-412/Integration test plan` from "Test plan" |
| Implementation | enter | Notification to `me`: "Branch to create: feature/SHOP-412-voucher from main" |
| Unit tests per repository | exit | Log: "Unit tests passed in 2 repositories" |
| Integration test | enter | Note `V-Model/SHOP-412/Integration test round 1` from "Test report" |
| Integration test rounds | enter | Notification to `all`: "Voucher: integration test round 2" |
| Integration test | enter | Note `V-Model/SHOP-412/Integration test round 2` from "Test report" |
| System test | exit | Log: "System test passed after 2 integration round(s)" |
| Acceptance test | enter | Notification to `all`: "Voucher is ready for acceptance – plan: V-Model/SHOP-412/Acceptance test plan" |
| Released | enter | Notification to `all`: "SHOP-412 Voucher is released" |

## More snippets

Remind the owner when a stage takes several attempts:

```json
"onEnter": [
  "inc(\"attempts\")",
  "if attempts > 2: notify(\"owner\", \"{{run.title}}: attempt {{run.attempts}} at {{run.ticket}}\")"
]
```

A log line for every time a stage is left:

```json
"onExit": "log(\"Left with branch {{run.branch}}\")"
```

Tick a manual step off when an earlier decision already answers it:

```json
"onEnter": "if severity == \"normal\": done(\"h1\")"
```

Notify a fixed team and the person who started the run:

```json
"onEnter": "notify(\"@anna @ben owner\", \"{{run.ticket}} needs a security review\")"
```

AI assistants read this format through the MCP tool `process_guide` and create models like this one with
`process_save`.

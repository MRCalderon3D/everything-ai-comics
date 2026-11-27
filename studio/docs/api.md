# Comics studio API

The server in `studio/server/` answers on `http://127.0.0.1:4310` (or the port
given with `--port`). The browser app in `studio/web/` uses nothing else. This
file lists every route, every event, and every operation.

The examples are real responses, recorded from a fake-mode run by
`node studio/test-support/record-api-examples.js`, which rewrites the blocks
between the `example` comments. They are shortened so they can be read: a long
list keeps its first items and ends with an entry such as `"... 3 more"`, a
long string ends with `…`, and local paths are replaced by `<studio home>` and
`<scaffold>`. In fake mode the texts and images are placeholders.

## Contents

- [Conventions](#conventions)
- [Studio](#studio)
- [Projects](#projects)
- [Settings and options](#settings-and-options)
- [Screens](#screens)
- [Text files](#text-files)
- [Raw files](#raw-files)
- [Uploads](#uploads)
- [Operations and jobs](#operations-and-jobs)
- [Events](#events)
- [Conversation](#conversation)
- [Actions of the conversation](#actions-of-the-conversation)
- [Story proposals](#story-proposals)
- [History](#history)
- [Approvals](#approvals)
- [Deleting, merging and renaming](#deleting-merging-and-renaming)
- [Overlay lettering](#overlay-lettering)
- [Operations reference](#operations-reference)
- [Fake mode](#fake-mode)

## Conventions

### Requests

- Every body is JSON with `Content-Type: application/json`, except the two
  routes that take file bytes (`POST .../uploads` and
  `POST .../pages/:page/lettered`). A JSON body is at most 1 MB (3 MB for
  `PUT .../file`).
- The server answers only requests whose `Host` header is `127.0.0.1:<port>`
  or `localhost:<port>`. A request that changes something and carries an
  `Origin` other than the server's own is refused. A page served by the
  server itself needs to do nothing special.
- `:id` in a path is the project id, a lowercase slug such as
  `the-night-ferry`.
- File paths are relative to the project's workspace (the `production/`
  directory), with forward slashes: `story/story-bible.yaml`. A path that
  leaves the workspace is refused with `400 bad_path`.
- IDs follow the scaffold: `ISS_001` (issue), `PG_001_002` (page),
  `PN_001_002_03` (panel), `PG_001_002_V01` (page render), `CV_001` (cover),
  `CV_001_V01` (cover render), `CHAR_MARA`, `LOC_FERRY_DECK`, `PROP_FLARE_GUN`,
  `LOOK_NOIR_INK` (entities), `ED_001_01` (edition).

### Language

The server writes its own text in English and in Spanish: job titles, step
labels and notes, the summaries and blockers of the project home, history
titles, error messages, preset names and intents, format and page size
labels. The language of a response is chosen per request, in this order:

1. `?lang=en` or `?lang=es` on the request.
2. For a route under `/api/projects/:id`, the interface language of that
   project (`language` in its settings).
3. The `Accept-Language` header, for a route with no project.
4. English.

The event stream follows the same order: `?lang=` when it was opened, else
the project's interface language at the time of each event.

Every text the server writes comes with its code. A field `x` that holds
such a text has two siblings: `x_code`, the stable dictionary key, and
`x_params`, the values that went into the sentence. A client can show `x`
as it is, or write its own wording from the code.

<!-- example:language-es -->
```json
{
  "operations": [
    {
      "name": "character.update",
      "title": "Cambiar un personaje",
      "title_code": "op.character.update.title",
      "title_params": {},
      "summary": "Aplica un cambio a un personaje, con fotos nuevas si las hay, y puede dibujar una hoja de giro nueva.",
      "summary_code": "op.character.update.summary",
      "summary_params": {},
      "params": [
        {
          "name": "character",
          "type": "string",
          "required": true,
          "description": "Character ID, for example CHAR_MARTA."
        },
        "... 3 more"
      ]
    }
  ]
}
```
<!-- /example:language-es -->

Jobs and history entries are stored with the code and the params, and the
text is written when they are read. A job that ran while the interface was
in Spanish reads in English to a request with `?lang=en`, and after the
interface language of the project changes.

A key that counts something has two forms in the dictionary, `<key>.one`
and `<key>.many`, chosen by the param `n`; `x_code` is the key without the
suffix. The dictionaries are `studio/server/i18n-text.js`.

What stays as it was written:

- Text a tool wrote: the `summary` and `decisions` of a job result, chat
  answers, review evidence and findings, everything in the workspace files.
  The prompts ask the tools to write for the person in the interface
  language.
- The words the studio adds to workspace files (the notes of a review, the
  notes of a generation record, the notes of a registered reference image)
  are written once, in the interface language of that moment.
- Mechanical findings (`continuity`, `validation`, schema `findings`) and
  the handoff instructions of `page.manual` come from the scaffold scripts,
  in English, each with its own `code`.
- Job log lines, the `description` of operation parameters in
  `GET /api/ops`, and the drawing descriptions of a preset (`line`,
  `inking`, `tone`, `rendering`, `lettering_style`, `palette`) are English.
- `placement` in a panel's `slot` is the scaffold's English word. Use the
  numbers beside it.

### The app's own files

Everything under `studio/web/` is served from the root of the server:
`studio/web/index.html` at `/`, `studio/web/app.js` at `/app.js`. A path that
is not a file gets `index.html`, so the app can route in the browser; a
missing file with an asset extension (`.js`, `.css`, `.png`, `.svg`, `.json`
and the like) gets a 404. The files are sent with this policy, which the app
has to live within:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'self'
```

Scripts load from the server only: ES modules in files work, inline scripts
and inline event handlers do not. Images may also come from `data:` and
`blob:` URLs, which the lettering canvas needs. The web reader of an edition
can be shown in an `iframe`.

### Errors

Every error has the same body: `code`, `message` and `params`. `details` is
present only where a route documents it.

| Field | Meaning |
|---|---|
| `code` | Stable identifier of the refusal. Branch on this. |
| `message` | A sentence for the person, in the language of the request. Its dictionary key is `error.<code>`; a code with no sentence of its own uses `error.other`, which quotes the detail. |
| `params` | The values of the sentence. `params.detail` is always there: the technical text in English, which names the exact file, ID or value. Sentences for malformed requests quote it. |
| `details` | Structured data for a few errors, such as the open findings of `review_flagged`. |

<!-- example:error-404 -->
```json
{
  "error": {
    "code": "page_not_found",
    "message": "That page does not exist in this project.",
    "params": { "detail": "PG_001_099 does not exist in this project." }
  }
}
```
<!-- /example:error-404 -->

| Status | Meaning |
|---|---|
| 400 | The request is malformed: a missing or invalid parameter (`bad_params`, `bad_path`, `bad_json`, `bad_settings`, `bad_options`, `bad_chat_key`, `unknown_operation`). |
| 403 | The `Host` or `Origin` check failed (`bad_host`, `bad_origin`). |
| 404 | The project, page, job, file, upload or other thing named in the request does not exist. |
| 405 | The method is not allowed on this route. |
| 409 | The request is well formed and the current state does not allow it. The code says why: `plan_not_approved`, `style_frozen`, `no_draw_tool`, `look_not_approved`, `review_flagged`, `job_finished`, `project_busy`, `file_changed`, `history_unavailable`, `nothing_to_do`, `no_story_text`, `proposal_closed`, `part_decided`, and the refusal codes of the scaffold scripts such as `master_exists`. |
| 413 | The body is larger than the route allows (`too_large`). |
| 415 | The body is of a type the route does not take (`unsupported_media_type`, `unsupported_file`, `not_an_image`, `not_text`). |
| 422 | A YAML text does not parse (`yaml_parse`, `yaml_empty`, with `details.line`), or a workspace file read by a screen does not parse (`workspace_yaml`). |
| 500 | Something unexpected (`internal`). |
| 501 | The scaffold lacks a function the route needs (`scaffold_missing`). |

A 400 and a 409, as they come back:

<!-- example:error-400 -->
```json
{
  "error": {
    "code": "bad_params",
    "message": "The request is not valid. Detail: \"pages\" must be a whole number from 1 to 24.",
    "params": { "detail": "\"pages\" must be a whole number from 1 to 24." }
  }
}
```
<!-- /example:error-400 -->

<!-- example:error-409 -->
```json
{
  "error": {
    "code": "style_frozen",
    "message": "The look is approved and its style is fixed: every page depends on it.",
    "params": {
      "detail": "The look is approved and its style block is frozen: every page depends on it. A different style means a new project, or a new look defined by hand in …"
    }
  }
}
```
<!-- /example:error-409 -->

The first of them again, asked for with `?lang=es`:

<!-- example:error-404-es -->
```json
{
  "error": {
    "code": "page_not_found",
    "message": "Esa página no existe en este proyecto.",
    "params": { "detail": "PG_001_099 does not exist in this project." }
  }
}
```
<!-- /example:error-404-es -->

### Image objects

Wherever a response names an image it carries an object ready to use:

| Field | Meaning |
|---|---|
| `path` | Workspace-relative path. |
| `url` | Path on this server (through the raw endpoint), with a `?v=` value that changes when the file changes. |
| `width`, `height` | Pixels, or `null` when the file could not be read as an image. |
| `bytes` | File size. |
| `mtime` | Last modification, ISO 8601. |

A field that holds an image is `null` when the file does not exist.

### Text documents

Wherever a response carries a text file of the workspace it has this shape,
whether the file exists or not:

| Field | Meaning |
|---|---|
| `path` | Workspace-relative path. |
| `exists` | `false` for a file that is not there yet. Then `text` is `""` and `data` is `null`. |
| `kind` | `yaml`, `markdown` or `text`. |
| `schema` | Name of the JSON Schema that governs the file (`story-bible`, `page`, ...), or `null`. Fetch it from `GET /api/schemas/:name`. |
| `text` | The raw text. |
| `data` | The parsed YAML, or `null` for Markdown, text, and YAML that does not parse. |
| `parse_error` | `{ message, line }` when the YAML does not parse, else `null`. |
| `findings` | Schema violations as `[{ path, message }]`. Empty when the file follows its schema. |
| `etag` | Version of the file. Send it back as `base_etag` on save to detect a change made elsewhere. |
| `mtime` | Last modification, ISO 8601. |
| `url` | Raw URL of the file. |

### Mechanical checks and review verdicts

Two kinds of check appear in the responses and they are never merged.

- Mechanical findings (`findings`, `continuity`, `validation`, `mechanical`)
  come from the schemas and from `check-continuity.js`. They say the plan
  files agree with each other. They say nothing about a drawing.
- A review (`review`, `verdict`, `checks`) is what a reviewer wrote after
  opening the image. `independent` is `false` when the tool that reviewed
  the image is the tool that drew it. A pass is an automated reading with
  evidence, and the person's approval is recorded apart from it
  (`human_approval`).

Every review object carries `outcome`, which is what the interface should
show:

| `outcome` | `verdict` in the file | Meaning |
|---|---|---|
| `pass` | `pass`, or `fixed` with nothing open | The image matches the plan. Nothing is open. |
| `notes` | `fixed` | The image passes and the review lists open findings, all of them minor. Show them as notes. Nothing blocks: the page counts as reviewed and enters a final edition. The person can turn any note into a correction with `page.correct`, or approve the page, which accepts the notes. |
| `flagged` | `flagged` | Something blocks: an open blocking finding, a failed gate, a change request that is still open, or a check nobody made. |

Only a blocking finding or a failed gate triggers an automatic repair. A
minor finding never does. `passes` is `true` for `pass` and `notes`.

A review that passes with one note:

<!-- example:review-notes -->
```json
{
  "path": "issues/ISS_001/pages/PG_001_003/reviews/PG_001_003_V01.review.yaml",
  "verdict": "fixed",
  "outcome": "notes",
  "passes": true,
  "independent": true,
  "reviewer": "visual-reviewer",
  "repair_cycle": 0,
  "reviewed_at": "2026-11-27",
  "supersedes": null,
  "human_approval": { "status": "pending", "by": null, "at": null },
  "gates": { "style_fidelity": "pass", "narrative_continuity": "pass" },
  "checks": {
    "identity": {
      "result": "pass",
      "evidence": "Placeholder evidence for identity: the fake reviewer does not look at pixels."
    },
    "cast_count": {
      "result": "pass",
      "evidence": "Placeholder evidence for cast count: the fake reviewer does not look at pixels."
    },
    "...": "12 more"
  },
  "findings": [
    {
      "id": "F01",
      "panel": "PN_001_003_01",
      "check": "wardrobe",
      "expected": "The jacket is buttoned, as on the sheet.",
      "visible": "Placeholder note forced by the word NOTE in the text: the jacket is open.",
      "severity": "minor",
      "repair": "Button the jacket and keep everything else as it is.",
      "status": "open"
    }
  ],
  "open_findings": 1,
  "open_blocking": 0,
  "open_notes": 1,
  "accepted_notes": 0,
  "overruled": false,
  "overruled_at": null,
  "overrule_note": null,
  "overruled_items": [],
  "change_requests": 0,
  "compared_against": { "references": ["LOOK_NOIR_INK_MASTER_V01", "CHAR_MARA_TURN_MASTER_V01"], "neighbors": ["PG_001_002_V02"] },
  "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
}
```
<!-- /example:review-notes -->

## Studio

### `GET /api/health`

Which tools are installed, which models each one offers, and what the server
can do. `?refresh=1` looks for the tools and their models again instead of
using the cached answer (the answer about the tools is kept one minute; the
model lists are looked up once when the server starts and then only on
request).

| Field | Meaning |
|---|---|
| `version` | Version of the scaffold. |
| `fake` | `true` in fake mode: no AI tool is called. |
| `home` | The studio home, where projects live. |
| `git` | `{ installed, version }`. Without git, history is recorded and cannot be restored. |
| `tools.claude`, `tools.codex` | `{ installed, version, jobs, models, models_source, models_detected_at }`. In fake mode `version` is `"fake"` and `fake` is `true`. |
| `tools.*.jobs` | What the tool can do in the studio: `["plan", "look"]` for Claude Code, `["plan", "look", "draw"]` for Codex. |
| `tools.*.models` | The models the tool offers, in its own order. Empty when the tool is not installed. Fields below. |
| `tools.*.models_source` | Where the list came from: `{ kind, where, note }`. `kind` is `cli`, `documented`, `config`, `fake`, `none` (the tool reports nothing) or `detecting` (the first lookup has not finished). `where` names the file or the command, with the home directory written as `~`, or `null`. `note` is a sentence for the person, with its code. Codex adds `default_from`, the configuration file its default comes from. |
| `tools.*.models_detected_at` | When the list was looked up, or `null` while it is being looked up. |
| `draw.available` | `true` when Codex is installed and the scaffold has its `codex-cli` provider. `draw.manual` says the manual handoff exists. |
| `formats` | Export formats `publish.build` accepts. |
| `languages` | Interface languages the settings accept. |

A model:

| Field | Meaning |
|---|---|
| `id` | What goes into the settings (`settings.models.<tool>.<job>`) and reaches the CLI as `--model` or `-m`. |
| `label` | The name the tool gives it. |
| `default` | `true` on the model the tool uses when the setting is `null`. At most one per tool; none when the tool does not say. |
| `source` | `cli` (a list the tool keeps or prints), `config` (the tool's configuration file), `documented` (named in the tool's own help) or `fake`. |
| `note` | The tool's own description, as it wrote it (English), or a sentence of the studio with `note_code`. `null` when there is neither. |
| `alias_of` | For an alias such as `opus`, the model id it points at today. Otherwise `null`. |

#### Where the model lists come from

Neither CLI has a command that lists its models in plain words, so the server
reads what each tool keeps on disk, and only falls back to its help when
nothing is there. Nothing here starts a session or spends anything. Measured
with Claude Code 2.1.314 and codex-cli 0.167.1.

Claude Code:

1. `~/.claude/cache/model-catalog/*.json` (or under `CLAUDE_CONFIG_DIR`): the
   model catalog Claude Code downloads and caches for its model picker.
   `catalog.config.models` lists the models with a name and a short
   description, `section: "main"` for the current ones and `"overflow"` for
   earlier ones. `catalog.config.provider_alias_targets` maps each alias
   (`fable`, `opus`, `sonnet`, `haiku`) to a model id, and
   `catalog.state.model` is the account's default. The aliases come first in
   the list, marked `source: "cli"`, followed by the models no alias points
   at. The file name carries an account id, so `where` names only the folder.
2. When there is no catalog, `claude --help`: its `--model` option names
   aliases (`'fable'`, `'opus'`, `'sonnet'`). They are listed with
   `source: "documented"` and no default.

The studio runs Claude Code with `--setting-sources project`, so a `model`
set in the person's own `~/.claude/settings.json` does not apply to studio
runs, and the server does not report it as the default. `claude` has no
subcommand that lists models.

Codex:

1. `~/.codex/models_cache.json` (or under `CODEX_HOME`): the catalog Codex
   fetches and caches. Entries with `visibility: "list"` are the ones its own
   picker shows, in `priority` order; hidden ones are left out.
   `source: "cli"`.
2. When there is no cache, `codex debug models --bundled`: the catalog built
   into the binary, printed without going to the network. `source: "cli"`.
   (Without `--bundled` the command refreshes the list from the network, so
   the server never runs it.)
3. The default is `model = "..."` in `~/.codex/config.toml`, or the `model`
   of the profile a top-level `profile = "..."` selects. When that model is
   not in the list it is added first with `source: "config"`.

Codex's help names no model (its only mention is `-c model="o3"`, an example
of the configuration syntax), so there is no documented fallback: with no
cache, no bundled list and no configured model, the list is empty and the
person can type a name.

A name typed by hand is always accepted in the settings (see
[`PUT .../settings`](#put-apiprojectsidsettings)); `model_status` says when a
setting is not in the list.

<!-- example:health -->
```json
{
  "ok": true,
  "name": "comics-studio",
  "version": "0.1.0",
  "node": "v24.14.1",
  "platform": "win32",
  "fake": true,
  "home": "<studio home>",
  "git": { "installed": true, "version": "2.45.1.windows.1" },
  "tools": {
    "claude": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look"],
      "models": [
        {
          "id": "fake-large",
          "label": "Fake large model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        "... 1 more"
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    },
    "codex": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look", "draw"],
      "models": [
        {
          "id": "fake-codex",
          "label": "Fake Codex model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        "... 1 more"
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    }
  },
  "draw": { "available": true, "provider": "codex-cli", "manual": true },
  "formats": ["pdf", "cbz", "web", "images", "epub"],
  "languages": ["en", "es"]
}
```
<!-- /example:health -->

### `POST /api/tools/refresh`

Looks for the tools and their models again, now, and answers with the result
as `tools` (the shape of `tools` in `GET /api/health`). For a Settings screen
after the person installs a tool or signs in. The body is ignored; send `{}`.
It reads files and may run `claude --help` or `codex debug models --bundled`;
it starts no session.

<!-- example:tools-refresh -->
```json
{
  "tools": {
    "claude": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look"],
      "models": [
        {
          "id": "fake-large",
          "label": "Fake large model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        {
          "id": "fake-fast",
          "label": "Fake fast model",
          "default": false,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        }
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    },
    "codex": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look", "... 1 more"],
      "models": [
        {
          "id": "fake-codex",
          "label": "Fake Codex model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        {
          "id": "fake-codex-mini",
          "label": "Fake small Codex model",
          "default": false,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        }
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    }
  }
}
```
<!-- /example:tools-refresh -->

### `GET /api/ops`

The operations a job can run, with their parameters. The
[operations reference](#operations-reference) describes each one. `title`
and `summary` are in the language of the request (`?lang=` or
`Accept-Language`), with their codes `op.<name>.title` and
`op.<name>.summary`. The `description` of a parameter is English.

<!-- example:ops -->
```json
{
  "operations": [
    {
      "name": "project.setup",
      "title": "Set up the project",
      "title_code": "op.project.setup.title",
      "title_params": {},
      "summary": "Deprecated: use Draft the story bible. Saves the description as your text and asks the AI for a draft of the story bible, as a proposal you decide on.",
      "summary_code": "op.project.setup.summary",
      "summary_params": {},
      "params": [
        {
          "name": "description",
          "type": "string",
          "required": true,
          "description": "What the comic is about, in the person's words."
        },
        {
          "name": "pages",
          "type": "integer",
          "required": false,
          "description": "Page budget of the first issue, 1 to 200. Default 4."
        }
      ]
    },
    {
      "name": "story.update",
      "title": "Update the story",
      "title_code": "op.story.update.title",
      "title_params": {},
      "summary": "Applies a change you describe, or reads a source text you uploaded, and updates the story bible.",
      "summary_code": "op.story.update.summary",
      "summary_params": {},
      "params": [
        {
          "name": "instruction",
          "type": "string",
          "required": false,
          "description": "What to change in the story."
        },
        {
          "name": "source_upload",
          "type": "string",
          "required": false,
          "description": "Id of an uploaded text file (txt, md, fountain) to use as source."
        }
      ]
    },
    "... 19 more"
  ]
}
```
<!-- /example:ops -->

### `GET /api/actions`

What the conversation can propose: every operation except `chat.turn`, with
the operation's own `params`, and the decisions the screens make without a
job (approvals, a story proposal decided or discarded, the project options,
answering or cancelling a job, the next issue). Each entry is
`{ name, kind, title, summary, params, decision }`: `kind` is `op` (it runs
as a job) or `direct` (it happens at once), and `decision` is `true` for
what only the person decides. See
[Actions of the conversation](#actions-of-the-conversation).

### `GET /api/schemas`

Names of the JSON Schemas of the scaffold.

<!-- example:schemas -->
```json
{
  "schemas": ["character", "continuity-state", "cover", "edition", "generation-record", "issue", "... 13 more"]
}
```
<!-- /example:schemas -->

### `GET /api/schemas/:name`

One schema (JSON Schema draft 2020-12), for generated forms. 404
`schema_not_found` for an unknown name.

<!-- example:schema -->
```json
{
  "name": "series-plan",
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://everything-ai-comics.dev/schemas/series-plan.schema.json",
    "title": "Series Plan",
    "description": "Division of the story into issues (production/story/series-plan.yaml): source span, page b…",
    "type": "object",
    "additionalProperties": false,
    "required": ["title", "issues"],
    "properties": {
      "title": { "type": "string", "minLength": 1, "description": "Title of the series or story." },
      "issues": {
        "type": "array",
        "description": "Issues in publication order.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["id", "number", "title", "page_budget", "status"],
          "properties": {
            "id": { "type": "string", "pattern": "^ISS_\\d{3}$", "description": "Issue ID, e.g. ISS_001." },
            "number": { "type": "integer", "minimum": 1, "description": "Issue number." },
            "title": { "type": "string", "minLength": 1, "description": "Issue title." },
            "source_span": {
              "type": "string",
              "description": "Part of the source this issue adapts, e.g. story/source/night-ferry.txt#p1-p9."
            },
            "summary": { "type": "string", "description": "What happens in the issue." },
            "page_budget": { "type": "integer", "minimum": 1, "description": "Planned number of pages." },
            "status": {
              "enum": ["planning", "scripting", "production", "review", "published"],
              "description": "Production status of the issue."
            }
          }
        }
      },
      "notes": { "type": "string", "description": "Free-form notes for people. Never read by scripts." }
    }
  }
}
```
<!-- /example:schema -->

### `GET /api/presets`

The look presets (`templates/looks/*.yaml`) and the choices of the project
options, for the screen that creates a project. Each preset has `key` (what
`style.define` takes as `preset`), `look_id`, `name`, `intent`, `color_mode`,
the drawing in words (`line`, `inking`, `tone`, `rendering`,
`lettering_style`, `palette`), `drift_risks`, its `style_block` and
`preview`. `name` and `intent` are in the language of the request, with
their codes; the drawing in words, `drift_risks` and the style block are the
preset file's own English text, which is also what goes into the prompts.
The labels of the page sizes are in the language of the request too; the
other choices are plain ids.

| Field | Meaning |
|---|---|
| `drift_risks` | What tends to drift from page to page with this look, as the preset records it: a list of English sentences, written for the model. An empty list when the preset has none. |
| `preview` | The sample page of the preset, `{ url, width, height }`, or `null` when none has been drawn. The samples live in `templates/looks/previews/<key>.jpg` (`.png` and `.webp` are read too), all drawn from the same small scene so the looks can be compared; `templates/looks/previews/README.md` says how they were made. `url` carries a version (`?v=`) that changes with the file. |

A style described in words or taken from uploaded images is not a preset and
has no sample until its look page is drawn (`style.look`).

<!-- example:presets -->
```json
{
  "presets": [
    {
      "key": "adventure-strip",
      "file": "templates/looks/adventure-strip.yaml",
      "id": "LOOK_ADVENTURE_STRIP_V01",
      "look_id": "LOOK_ADVENTURE_STRIP",
      "name": "Adventure strip",
      "name_code": "preset.adventure-strip.name",
      "name_params": {},
      "intent": "Serial adventure, mystery, or romance told a few panels at a time. Realistic people and places, lit like a fil…",
      "intent_code": "preset.adventure-strip.intent",
      "intent_params": {},
      "color_mode": "monochrome",
      "line": "Flexible brush line on realistic figures: thick on the shadow side, tapering to a hairline on the lit side. Fi…",
      "inking": "Feathered brush strokes model faces and cloth; spotted blacks shape the night and the folds of coats. Dry-brus…",
      "tone": "Mechanical dot tone laid on one or two planes per panel (sky, a wall, a dress), cut to shape with a clean edge…",
      "rendering": "Naturalistic anatomy and specific, grown-up faces. Cinematic framing with silhouettes in the foreground and de…",
      "lettering_style": "Hand-lettered upper case, small and even. Round balloons tucked into the corners, a rectangular caption at the…",
      "palette": [],
      "pairs_with": {
        "comic_formats": ["paged"],
        "publications": ["strip", "... 1 more"],
        "typical_genres": ["adventure", "... 4 more"]
      },
      "drift_risks": [
        "Feathering turns into cross-hatching or into soft grey shading.",
        "Dot tone spreads over the whole panel or becomes a smooth gradient.",
        "... 2 more"
      ],
      "style_block": "Black-and-white realistic adventure newspaper strip.\nLine: flexible brush line on realistic figures, thick on …",
      "preview": { "url": "/api/presets/adventure-strip/preview?v=mwy19ubv7u6q", "width": 768, "height": 1152 }
    },
    "... 25 more"
  ],
  "choices": {
    "comic_format": ["paged", "webtoon"],
    "reading_direction": ["ltr", "rtl"],
    "color_mode": ["monochrome", "limited", "full_color"],
    "lettering_mode": ["in_image", "overlay"],
    "publication": ["strip", "one-shot", "miniseries", "ongoing", "graphic-novel", "webtoon-series"],
    "rating": ["all-ages", "teen", "mature"],
    "page_size": [
      {
        "id": "comic-2-3",
        "label": "Comic page 2:3",
        "label_code": "page_size.comic-2-3",
        "label_params": {},
        "aspect_ratio": "2:3",
        "width_px": 2000,
        "height_px": 3000,
        "formats": ["paged"]
      },
      {
        "id": "album-3-4",
        "label": "Album page 3:4",
        "label_code": "page_size.album-3-4",
        "label_params": {},
        "aspect_ratio": "3:4",
        "width_px": 2100,
        "height_px": 2800,
        "formats": ["paged"]
      },
      {
        "id": "square",
        "label": "Square 1:1",
        "label_code": "page_size.square",
        "label_params": {},
        "aspect_ratio": "1:1",
        "width_px": 2048,
        "height_px": 2048,
        "formats": ["paged"]
      },
      {
        "id": "scroll-9-16",
        "label": "Scroll segment 9:16",
        "label_code": "page_size.scroll-9-16",
        "label_params": {},
        "aspect_ratio": "9:16",
        "width_px": 1080,
        "height_px": 1920,
        "formats": ["webtoon"]
      }
    ]
  }
}
```
<!-- /example:presets -->

### `GET /api/presets/:key/preview`

The sample page of a preset: the image bytes, with its own content type
(`image/png`, `image/jpeg` or `image/webp`), `X-Content-Type-Options:
nosniff` and `Cache-Control: public, max-age=31536000, immutable`. Use the
`preview.url` of `GET /api/presets`, whose `?v=` changes when the file does.
`:key` must be the key of a preset (lowercase letters, digits and hyphens);
anything else, a preset with no sample, or a file that is not an image is
404 `preview_not_found`. Only files directly inside the previews folder are
served.

## Projects

A project is a directory under the studio home that holds
`production/project.yaml`.

### `GET /api/projects`

Every project, most recently changed first. `image` is the cover, else the
first drawn page, else the look master, else `null`. `busy` is `true` while a
job is queued or running.

<!-- example:projects -->
```json
{
  "home": "<studio home>",
  "projects": [
    {
      "id": "the-night-ferry",
      "title": "The Night Ferry",
      "logline": "",
      "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
      "comic_format": "paged",
      "language": "en",
      "created_at": "2026-11-27",
      "updated_at": "2026-11-27T03:25:07.822Z",
      "image": null,
      "counts": { "pages": 0, "rendered": 0, "passed": 0 },
      "busy": false
    }
  ]
}
```
<!-- /example:projects -->

### `POST /api/projects`

Creates a project: the workspace (through `create-project.js`), the options,
the person's story files, and a git repository in the project directory. No
AI job starts: the AI writes story text only when the person asks
([Story proposals](#story-proposals)).

The story files are written by the server, from what the person typed:

- `story/source/description.md`: the description, as the person's own source
  text (only when a description is given).
- `story/story-bible.yaml`: empty but valid. `premise` is the description (the
  title when there is none), `tone` is `""`, and `world_rules`, `facts`,
  `characters`, `timeline` and `open_questions` are empty lists. The comment
  block of the scaffold's template stays at the top.
  `validate-workspace.js` passes on it.
- `story/series-plan.yaml`: one issue, `ISS_001`, titled like the project,
  with the page budget of `pages`, status `planning`, and
  `source_span: story/source/description.md` when there is a description.

| Body field | Type | Meaning |
|---|---|---|
| `title` | string, required | At most 120 characters. The project id is its slug; a second project with the same title gets `-2`. |
| `description` | string | What the comic is about, in the person's words. It becomes the source text and the premise. |
| `format` | `paged` (default) or `webtoon` | Sets `comic_format`. A webtoon gets a 9:16 scroll segment. |
| `language` | string | Language of the comic, such as `en` or `es`. |
| `pages` | integer 1 to 200 | Page budget of the first issue. Default 4. |
| `options` | object | Any field of [`PUT .../options`](#put-apiprojectsidoptions) except `title` and `comic_format`. |
| `interface_language` | `en` or `es` | Language of the interface for this project. Default: the comic's language when it is one of the two, else `en`. |
| `guide` | boolean | `true` starts the project conversation in [guide mode](#guide-mode), with the guide's first message already in it. Default `false`. |
| `setup` | boolean | Deprecated. Default `false`. `true` (with a description) queues the deprecated [`project.setup`](#projectsetup), which now asks for a draft of the story bible as a proposal and writes no story. |

Answers 201 with the project card, `job` (`null` unless `setup` is `true`),
`written`, the workspace paths of the story files, and `guide`, `true`
when the conversation starts in guide mode.

<!-- example:create-guided -->
```json
{ "project": { "id": "guided", "...": "as for any project" }, "job": null, "guide": true }
```
<!-- /example:create-guided -->

<!-- example:project-create-request -->
```json
{
  "title": "The Night Ferry",
  "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
  "format": "paged",
  "language": "en",
  "pages": 3,
  "options": { "reading_direction": "ltr" }
}
```
<!-- /example:project-create-request -->

<!-- example:project-create -->
```json
{
  "project": {
    "id": "the-night-ferry",
    "title": "The Night Ferry",
    "logline": "",
    "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
    "comic_format": "paged",
    "language": "en",
    "created_at": "2026-11-27",
    "updated_at": "2026-11-27T03:25:07.822Z",
    "image": null,
    "counts": { "pages": 0, "rendered": 0, "passed": 0 },
    "busy": false
  },
  "job": null,
  "written": ["story/source/description.md", "story/story-bible.yaml", "... 1 more"],
  "guide": false
}
```
<!-- /example:project-create -->

### `GET /api/projects/:id`

The project home: per-screen status, the next thing to do, what blocks it.

| Field | Meaning |
|---|---|
| `project` | The card of `GET /api/projects` plus `publication`, `genre`, `reading_direction`, `color_mode`, `lettering_mode`, `page`, and the local `path` and `workspace` directories. |
| `settings` | The project's studio settings (see below). |
| `tools` | Which tool does each verb right now: `{ requested, tool, available, fallback, model, reason }` for `plan`, `look` and `draw`. `fallback` is `true` when the configured tool is missing and the other one took the verb. |
| `screens` | One entry per screen, in pipeline order: `story`, `style`, `characters`, `places`, `pages`, `check`, `corrections`, `cover`, `publish`. |
| `screens[].status` | `done`, `in_progress`, `todo`, `blocked`, `next` (ready to do) or `optional`. |
| `screens[].summary` | One sentence for the person, with `summary_code` and `summary_params`. |
| `screens[].blockers` | `[{ code, message, page?, detail? }]`: what has to happen first. `message` is the sentence for the person, with `message_code` and `message_params`; a blocker of a page also carries `detail`, the scaffold script's own text. |
| `screens[].counts` | Numbers for the screen (pages planned, drawn, flagged, and so on). |
| `screens[].next` | `true` on the screen `next` points at. |
| `next` | `{ screen, summary }`: the first required screen that is not done, or `null` when everything is. |
| `issues` | The issues, as in `GET .../issues`. `first_issue` is the id to open by default. |
| `look` | `{ id, approved }`. |
| `repair_limit` | Repair cycles the studio spends on its own before it leaves a page flagged. |
| `touch_up_warning` | Edits of one image after which a correction asks the person to choose between touching up anyway and a redraw (`repair_policy.touch_up_warning`, default 2). |
| `history.git` | `true` when earlier states can be restored. |
| `active_jobs` | Jobs that are queued, running, or waiting for an answer. |

<!-- example:overview -->
```json
{
  "project": {
    "id": "the-night-ferry",
    "title": "The Night Ferry",
    "logline": "",
    "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
    "comic_format": "paged",
    "language": "en",
    "created_at": "2026-11-27",
    "updated_at": "2026-11-27T03:25:51.112Z",
    "image": {
      "path": "issues/ISS_001/cover/renders/CV_001_V03.png",
      "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V03.png?v=6tsmwyf5fqh",
      "width": 600,
      "height": 900,
      "bytes": 8848,
      "mtime": "2026-11-27T03:25:42.761Z"
    },
    "counts": { "pages": 3, "rendered": 3, "passed": 3 },
    "busy": false,
    "publication": "one-shot",
    "genre": "drama",
    "reading_direction": "ltr",
    "color_mode": "monochrome",
    "lettering_mode": "in_image",
    "page": {
      "aspect_ratio": "2:3",
      "width_px": 2000,
      "height_px": 3000,
      "trim_mm": { "width": 168, "height": 260 },
      "bleed_mm": 3,
      "safe_margin_mm": 6
    },
    "path": "<studio home>/the-night-ferry",
    "workspace": "<studio home>/the-night-ferry/production"
  },
  "settings": {
    "language": "en",
    "drivers": { "plan": "claude", "look": "claude", "draw": "codex" },
    "models": { "claude": { "plan": null, "look": "sonnet" }, "codex": { "plan": null, "look": null, "draw": null } },
    "repair_limit": null,
    "chat_auto_run": false
  },
  "tools": {
    "plan": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    },
    "look": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": "sonnet",
      "reason": null
    },
    "draw": {
      "requested": "codex",
      "tool": "codex",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    }
  },
  "screens": [
    {
      "key": "story",
      "status": "done",
      "summary": "The story bible is written.",
      "summary_code": "screen.story.done",
      "summary_params": {},
      "blockers": [],
      "counts": { "facts": 3, "proposals_open": 3 }
    },
    {
      "key": "style",
      "status": "done",
      "summary": "The look is approved and the style is fixed.",
      "summary_code": "screen.style.done",
      "summary_params": {},
      "blockers": [],
      "counts": { "candidates": 1 }
    },
    "... 7 more"
  ],
  "next": {
    "screen": "characters",
    "summary": "One of 2 characters still needs an approved sheet.",
    "summary_code": "screen.characters.missing",
    "summary_params": { "n": 1, "total": 2 }
  },
  "issues": [
    {
      "id": "ISS_001",
      "number": 1,
      "title": "Crossing",
      "summary": "Mara crosses the river alone at night.",
      "status": "scripting",
      "page_budget": 3,
      "pages": 3,
      "rendered": 3,
      "passed": 3,
      "cover": {
        "exists": true,
        "status": "approved",
        "approved_render": "CV_001_V03",
        "renders": 3,
        "current_render": "CV_001_V03",
        "image": {
          "path": "issues/ISS_001/cover/renders/CV_001_V03.png",
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V03.png?v=6tsmwyf5fqh",
          "width": 600,
          "height": 900,
          "bytes": 8848,
          "mtime": "2026-11-27T03:25:42.761Z"
        },
        "verdict": "fixed",
        "outcome": "pass",
        "open_findings": 0,
        "open_notes": 0,
        "accepted_notes": 0,
        "overruled": false,
        "overruled_at": null,
        "overrule_note": null,
        "human_approval": "approved",
        "passes": true
      }
    }
  ],
  "first_issue": "ISS_001",
  "look": { "id": "LOOK_NOIR_INK", "approved": true },
  "repair_limit": 1,
  "touch_up_warning": 2,
  "history": { "git": true },
  "active_jobs": []
}
```
<!-- /example:overview -->

### `DELETE /api/projects/:id`

Moves the project directory to `.trash/` inside the studio home. Nothing is
erased. While a job is queued or running the answer is 409 `project_busy`;
`?force=1` cancels the jobs first.

<!-- example:project-delete -->
```json
{
  "deleted": "overlay-letters",
  "trash": ".trash/overlay-letters-20261127032603",
  "note": "The project was moved to the trash folder of the studio home. Nothing was erased.",
  "note_code": "note.trashed",
  "note_params": {}
}
```
<!-- /example:project-delete -->

## Settings and options

Settings belong to the studio and live in `.studio/settings.json`. Options
are fields of `production/project.yaml`.

### `GET /api/projects/:id/settings`

| Field | Meaning |
|---|---|
| `settings.language` | Interface language, `en` or `es`. |
| `settings.drivers` | Which tool does each verb: `plan` and `look` take `claude` or `codex`; `draw` takes `codex` or `manual`. |
| `settings.models` | Model per driver and verb, or `null` for the tool's default: `claude.plan`, `claude.look`, `codex.plan`, `codex.look`, `codex.draw`. A model `id` from `installed.<tool>.models`, or any name the person types (letters, digits, `.`, `_`, `:`, `-`, `[`, `]`, at most 80 characters). |
| `settings.repair_limit` | `null`, or a number from 0 to 10 that stops the automatic repairs earlier than the project's own limit. It never raises that limit. |
| `settings.chat_auto_run` | `false` by default. When `true`, an action card the conversation proposes runs at once when it only writes text (planning pages, a story suggestion, a style written without drawing). Drawings, approvals, decisions and answers always wait for the person. |
| `tools` | The resulting assignment, as in the project home. |
| `installed` | `{ claude, codex }` as in `GET /api/health`, with `jobs`, `models` and `models_source`. Show a tool only when `installed` is `true`, and per job only the tools whose `jobs` include it. |
| `model_status` | Per tool and verb: `default` (the setting is `null`), `listed` (it names a model of the list, or the model an alias points at) or `custom` (a name typed by hand). |
| `timings` | How long AI calls took in this project, per tool, model and job (below). Empty until something ran. |
| `choices`, `languages` | What each field accepts. |

`timings` comes from `.studio/timings.jsonl` in the project, one line per AI
call: planning and writing (`plan`), reading an image (`look`) and drawing
(`draw`), with its duration and whether it succeeded. Each entry of
`timings`:

| Field | Meaning |
|---|---|
| `tool`, `model`, `job` | The group. `model` is the setting the calls ran with; `null` is the tool's default. |
| `runs`, `failed` | Calls that succeeded and calls that failed. Failed calls are not in the averages. |
| `average_ms` | Average duration of a call that succeeded. |
| `per_page_ms` | Average time per page, over the calls that worked on pages (planning pages, checking a page, drawing a page), or `null`. This is the "about 3 minutes per page" figure. |
| `last_at` | When the last call of the group ran. |
| `kinds` | The same per kind of call: a prompt name (`pages.plan`, `pages.breakdown`, `review`, `chat`, `story.propose`...) or, for drawing, `page`, `cover` or `sheet`. Each `{ runs, average_ms, per_page_ms }`. |

After a few pages were drawn:

<!-- example:settings-timings -->
```json
{
  "timings": [
    {
      "tool": "claude",
      "model": "sonnet",
      "job": "look",
      "runs": 5,
      "failed": 0,
      "average_ms": 9,
      "per_page_ms": 8,
      "last_at": "2026-11-27T03:25:32Z",
      "kinds": {
        "sheet.check": { "runs": 1, "average_ms": 14, "per_page_ms": null },
        "review": { "runs": 4, "average_ms": 8, "per_page_ms": 8 }
      }
    },
    {
      "tool": "claude",
      "model": null,
      "job": "plan",
      "runs": 9,
      "failed": 0,
      "average_ms": 14,
      "per_page_ms": 9,
      "last_at": "2026-11-27T03:25:23Z",
      "kinds": {
        "story.propose": { "runs": 3, "average_ms": 10, "per_page_ms": null },
        "style.define": { "runs": 1, "average_ms": 22, "per_page_ms": null },
        "character.write": { "runs": 2, "average_ms": 6, "per_page_ms": null },
        "pages.breakdown": { "runs": 1, "average_ms": 24, "per_page_ms": 8 },
        "pages.plan": { "runs": 1, "average_ms": 31, "per_page_ms": 10 },
        "entities.derive": { "runs": 1, "average_ms": 10, "per_page_ms": null }
      }
    },
    {
      "tool": "codex",
      "model": null,
      "job": "draw",
      "runs": 7,
      "failed": 0,
      "average_ms": 254,
      "per_page_ms": 313,
      "last_at": "2026-11-27T03:25:31Z",
      "kinds": {
        "sheet": { "runs": 3, "average_ms": 174, "per_page_ms": null },
        "page": { "runs": 4, "average_ms": 313, "per_page_ms": 313 }
      }
    }
  ]
}
```
<!-- /example:settings-timings -->

<!-- example:settings -->
```json
{
  "settings": {
    "language": "en",
    "drivers": { "plan": "claude", "look": "claude", "draw": "codex" },
    "models": { "claude": { "plan": null, "look": "sonnet" }, "codex": { "plan": null, "look": null, "draw": null } },
    "repair_limit": null,
    "chat_auto_run": false
  },
  "tools": {
    "plan": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    },
    "look": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": "sonnet",
      "reason": null
    },
    "draw": {
      "requested": "codex",
      "tool": "codex",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    }
  },
  "installed": {
    "claude": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look"],
      "models": [
        {
          "id": "fake-large",
          "label": "Fake large model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        {
          "id": "fake-fast",
          "label": "Fake fast model",
          "default": false,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        }
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    },
    "codex": {
      "installed": true,
      "version": "fake",
      "fake": true,
      "jobs": ["plan", "look", "draw"],
      "models": [
        {
          "id": "fake-codex",
          "label": "Fake Codex model",
          "default": true,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        },
        {
          "id": "fake-codex-mini",
          "label": "Fake small Codex model",
          "default": false,
          "source": "fake",
          "note": "Fake mode: a placeholder, not a real model.",
          "note_code": "model.note.fake",
          "note_params": {},
          "alias_of": null
        }
      ],
      "models_source": {
        "kind": "fake",
        "where": null,
        "note": "Fake mode: a fixed list of placeholder models.",
        "note_code": "model.source.fake",
        "note_params": {}
      },
      "models_detected_at": "2026-11-27T03:25:07Z"
    }
  },
  "model_status": {
    "claude": { "plan": "default", "look": "custom" },
    "codex": { "plan": "default", "look": "default", "draw": "default" }
  },
  "timings": [
    {
      "tool": "claude",
      "model": null,
      "job": "plan",
      "runs": 3,
      "failed": 0,
      "average_ms": 10,
      "per_page_ms": null,
      "last_at": "2026-11-27T03:25:08Z",
      "kinds": { "story.propose": { "runs": 3, "average_ms": 10, "per_page_ms": null } }
    }
  ],
  "choices": { "plan": ["claude", "codex"], "look": ["claude", "codex"], "draw": ["codex", "manual"] },
  "languages": ["en", "es"]
}
```
<!-- /example:settings -->

### `PUT /api/projects/:id/settings`

Body: any subset of `language`, `drivers`, `models`, `repair_limit`, `chat_auto_run`. Fields
left out keep their value. 400 `bad_settings` names the first invalid field.
A model name that is not in the tool's list is accepted (the person may know
one the tool does not report); the answer's `model_status` marks it
`custom`.

<!-- example:settings-put -->
```json
{
  "settings": {
    "language": "en",
    "drivers": { "plan": "claude", "look": "claude", "draw": "codex" },
    "models": { "claude": { "plan": null, "look": "sonnet" }, "codex": { "plan": null, "look": null, "draw": null } },
    "repair_limit": null,
    "chat_auto_run": false
  },
  "tools": {
    "plan": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    },
    "look": {
      "requested": "claude",
      "tool": "claude",
      "available": true,
      "fallback": false,
      "model": "sonnet",
      "reason": null
    },
    "draw": {
      "requested": "codex",
      "tool": "codex",
      "available": true,
      "fallback": false,
      "model": null,
      "reason": null
    }
  },
  "model_status": {
    "claude": { "plan": "default", "look": "custom" },
    "codex": { "plan": "default", "look": "default", "draw": "default" }
  }
}
```
<!-- /example:settings-put -->

### `GET /api/projects/:id/options`

The general options of the project as a flat form, the choices for each, and
`project.yaml` itself as a text document.

<!-- example:options -->
```json
{
  "options": {
    "title": "The Night Ferry",
    "logline": "TODO: one sentence. Who wants what, and what stands in the way.",
    "genre": "drama",
    "language": "en",
    "comic_format": "paged",
    "publication": "one-shot",
    "reading_direction": "ltr",
    "color_mode": "full_color",
    "lettering_mode": "in_image",
    "rating": "teen",
    "repair_limit": 1,
    "touch_up_warning": 2,
    "page": { "aspect_ratio": "2:3", "width_px": 2000, "height_px": 3000 },
    "page_size": "comic-2-3",
    "image_provider": "codex-cli"
  },
  "choices": {
    "comic_format": ["paged", "webtoon"],
    "reading_direction": ["ltr", "rtl"],
    "color_mode": ["monochrome", "limited", "full_color"],
    "lettering_mode": ["in_image", "overlay"],
    "publication": ["strip", "one-shot", "miniseries", "... 3 more"],
    "rating": ["all-ages", "teen", "mature"],
    "page_size": [
      {
        "id": "comic-2-3",
        "label": "Comic page 2:3",
        "label_code": "page_size.comic-2-3",
        "label_params": {},
        "aspect_ratio": "2:3",
        "width_px": 2000,
        "height_px": 3000,
        "formats": ["paged"]
      },
      {
        "id": "album-3-4",
        "label": "Album page 3:4",
        "label_code": "page_size.album-3-4",
        "label_params": {},
        "aspect_ratio": "3:4",
        "width_px": 2100,
        "height_px": 2800,
        "formats": ["paged"]
      },
      {
        "id": "square",
        "label": "Square 1:1",
        "label_code": "page_size.square",
        "label_params": {},
        "aspect_ratio": "1:1",
        "width_px": 2048,
        "height_px": 2048,
        "formats": ["paged"]
      },
      "... 1 more"
    ]
  },
  "project": {
    "path": "project.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "project",
    "text": "# production/project.yaml: workspace configuration\n# Schema: schemas/project.schema.json\n# Project: THE_NIGHT_FERRY\n# Ev…",
    "parse_error": null,
    "findings": [],
    "etag": "b39-1a21b091094",
    "mtime": "2026-11-27T03:25:08.628Z",
    "url": "/api/projects/the-night-ferry/raw/project.yaml"
  }
}
```
<!-- /example:options -->

### `PUT /api/projects/:id/options`

Body: any subset of the fields below. The file keeps its comments. The change
is committed and logged. `findings` are the schema findings of `project.yaml`
after the change.

| Field | Accepts |
|---|---|
| `title`, `logline`, `genre` | Text. |
| `language` | A language code such as `en`. |
| `comic_format` | `paged` or `webtoon`. 409 `format_locked` once pages are planned. |
| `publication` | `strip`, `one-shot`, `miniseries`, `ongoing`, `graphic-novel`, `webtoon-series`. |
| `reading_direction` | `ltr` or `rtl`. |
| `color_mode` | `monochrome`, `limited`, `full_color`. |
| `lettering_mode` | `in_image` or `overlay`. |
| `rating` | `all-ages`, `teen`, `mature`. |
| `repair_limit` | 0 to 10. Writes `repair_policy.max_cycles`, the scaffold's limit on automatic repairs. |
| `touch_up_warning` | 0 to 10. Writes `repair_policy.touch_up_warning`: how many edits an image takes before a correction warns that more may degrade it and offers a redraw. The person then chooses (`mode` of `page.correct`). The Settings screen shows it with one line on the trade-off. |
| `page_size` | One of the ids in `choices.page_size`. |
| `page` | `{ aspect_ratio, width_px, height_px }` for a size that is not in the list. |

<!-- example:options-put -->
```json
{
  "options": {
    "title": "The Night Ferry",
    "logline": "TODO: one sentence. Who wants what, and what stands in the way.",
    "genre": "drama",
    "language": "en",
    "comic_format": "paged",
    "publication": "one-shot",
    "reading_direction": "ltr",
    "color_mode": "full_color",
    "lettering_mode": "in_image",
    "rating": "teen",
    "repair_limit": 1,
    "touch_up_warning": 2,
    "page": { "aspect_ratio": "2:3", "width_px": 2000, "height_px": 3000 },
    "page_size": "comic-2-3",
    "image_provider": "codex-cli"
  },
  "findings": [],
  "commit": "a4c73e0237ba1305f0d9f2ca74454f0aa28ff340"
}
```
<!-- /example:options-put -->

## Screens

One call per screen. Every screen response ends with `chat_key`, the screen
key, and `screen`: `{ key, label, route }`, what a message sent from that
screen carries (see [Conversation](#conversation)). `label` is a name for
the person in the language of the request, with `label_code` and
`label_params`; `route` is the path of the browser app that shows the
screen.

### `GET /api/projects/:id/story`

| Field | Meaning |
|---|---|
| `written` | `true` once the story bible has a premise and facts. |
| `has_text` | `true` when the person's own text is there: a description or a file under `story/source/`. The project home counts the story screen as done with it, so the person can go on to the style with only their text. |
| `description` | The person's own text: `story/source/description.md` without its heading line, the one place it is kept. The chat and the Story screen's editor write that file, so what they save shows here at once. A project from before the file existed falls back to what was typed at creation. |
| `bible` | `story/story-bible.yaml` as a text document. |
| `series_plan` | `story/series-plan.yaml` as a text document. |
| `sources` | Files under `story/source/`: `[{ name, path, bytes, mtime, url }]`. |
| `blocking_questions` | Open questions marked blocking, which have to be answered before pages are drawn. |
| `characters_named` | Characters the bible lists: `[{ id, has_file }]`. |
| `proposals` | Open proposals, as in [`GET .../proposals`](#get-apiprojectsidproposals). |

Facts the person writes in the story bible directly, through
[`PUT .../file`](#put-apiprojectsidfile), keep the provenance they write:
by the schema, `source` with a `source_ref` for what their text states, and
`user_change` with `replaces` when they change an existing fact. The server
does not rewrite them.

A new project, before anything else:

<!-- example:story-new -->
```json
{
  "written": false,
  "has_text": true,
  "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
  "bible": {
    "path": "story/story-bible.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "story-bible",
    "text": "# production/story/story-bible.yaml: the canon\n# Schema: schemas/story-bible.schema.json\n# Written by /source-analyze an…",
    "data": {
      "title": "The Night Ferry",
      "premise": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
      "tone": "",
      "world_rules": [],
      "facts": [],
      "characters": [],
      "timeline": [],
      "open_questions": []
    },
    "parse_error": null,
    "findings": [],
    "etag": "17e-1a21b090af4",
    "mtime": "2026-11-27T03:25:07.188Z",
    "url": "/api/projects/the-night-ferry/raw/story/story-bible.yaml"
  },
  "series_plan": {
    "path": "story/series-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "series-plan",
    "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written b…",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "178-1a21b090af4",
    "mtime": "2026-11-27T03:25:07.188Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  },
  "sources": [
    {
      "name": "description.md",
      "path": "story/source/description.md",
      "bytes": 115,
      "mtime": "2026-11-27T03:25:07.188Z",
      "url": "/api/projects/the-night-ferry/raw/story/source/description.md"
    }
  ],
  "blocking_questions": [],
  "characters_named": [],
  "chat_key": "story",
  "proposals": [],
  "screen": {
    "key": "story",
    "label": "Story",
    "label_code": "screen_label.story",
    "label_params": {},
    "route": "/p/the-night-ferry/story"
  }
}
```
<!-- /example:story-new -->

After a draft was decided on:

<!-- example:story -->
```json
{
  "written": true,
  "has_text": true,
  "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
  "bible": {
    "path": "story/story-bible.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "story-bible",
    "text": "# production/story/story-bible.yaml: the canon\n# Schema: schemas/story-bible.schema.json\n# Written by /source-analyze an…",
    "data": {
      "title": "The Night Ferry",
      "premise": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
      "tone": "Quiet and tense, with dry humour.",
      "world_rules": [],
      "facts": ["{…}", "... 1 more"],
      "characters": [],
      "timeline": ["{…}"],
      "open_questions": ["{…}"]
    },
    "parse_error": null,
    "findings": [],
    "etag": "3d0-1a21b090ddf",
    "mtime": "2026-11-27T03:25:07.935Z",
    "url": "/api/projects/the-night-ferry/raw/story/story-bible.yaml"
  },
  "series_plan": {
    "path": "story/series-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "series-plan",
    "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written b…",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "178-1a21b090af4",
    "mtime": "2026-11-27T03:25:07.188Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  },
  "sources": [
    {
      "name": "description.md",
      "path": "story/source/description.md",
      "bytes": 115,
      "mtime": "2026-11-27T03:25:07.188Z",
      "url": "/api/projects/the-night-ferry/raw/story/source/description.md"
    }
  ],
  "blocking_questions": [],
  "characters_named": [],
  "chat_key": "story",
  "proposals": [
    {
      "id": "prop_2026112703250859408_7414",
      "kind": "suggest",
      "status": "open",
      "title": "Suggestion",
      "title_code": "proposal.title.suggest",
      "title_params": {},
      "instruction": "Suggest an ending.",
      "summary": "This is the fake assistant. It proposes 3 kind(s) of story text for you to accept or reject.",
      "created_at": "2026-11-27T03:25:08Z",
      "updated_at": "2026-11-27T03:25:08Z",
      "job": "job_2026112703250856507_76aa",
      "tool": "claude",
      "counts": { "parts": 3, "pending": 3, "accepted": 0, "edited": 0, "rejected": 0 }
    },
    "... 1 more"
  ],
  "screen": {
    "key": "story",
    "label": "Story",
    "label_code": "screen_label.story",
    "label_params": {},
    "route": "/p/the-night-ferry/story"
  }
}
```
<!-- /example:story -->

### `GET /api/projects/:id/style`

| Field | Meaning |
|---|---|
| `presets` | As in `GET /api/presets`. |
| `look.id` | The look being defined, or `null` before `style.define`. |
| `look.frozen` | `true` once a look master is approved. From then on the style block cannot be saved and `style.define` is refused. |
| `look.master` | The approved master, or `null`. |
| `look.masters`, `look.candidates`, `look.references` | Every image of the look: masters, look pages waiting for a decision, and reference images the person uploaded. See the asset fields below. |
| `look.packages` | The compiled prompt package of the look page: `prompt`, `references` with their images, `parameters`. |
| `style_bible`, `style_block`, `color_script` | Text documents. `style_block.template` is `true` while the block still has template lines; `style_block.frozen` repeats `look.frozen`. |
| `options`, `choices` | The project options and their choices, as in `GET .../options`. |

Asset fields, used for looks, characters, locations and props:

| Field | Meaning |
|---|---|
| `id` | File stem: `CHAR_MARA_TURN_V01` (candidate), `CHAR_MARA_TURN_MASTER_V01` (master), `CHAR_MARA_REF_V01` (uploaded reference). |
| `sheet` | `look`, `turnaround`, `expressions`, `wardrobe`, `plate`, `prop`, `detail` or `reference`. |
| `version` | The number after `_V`. |
| `image` | Image object. |
| `status` | `candidate` (drawn, not registered), or the registry status: `approved`, `superseded`, `draft`. |
| `role` | The one role the image plays when attached: `style`, `identity`, and so on. |
| `approved_at`, `approved_by`, `notes` | From the registry. |
| `promoted_from`, `superseded_by` | Masters only. |
| `promoted_to` | Candidates only: the master made from it, or `null`. A candidate with `promoted_to: null` can be approved. |
| `generation` | Candidates only: `{ id, path, provider, model, status, created_at, prompt_package, supplied_by_person, summary, notes }` from the generation record. |

<!-- example:style -->
```json
{
  "presets": "[26 items]",
  "look": {
    "id": "LOOK_NOIR_INK",
    "frozen": true,
    "master": {
      "id": "LOOK_NOIR_INK_MASTER_V01",
      "entity": "LOOK_NOIR_INK",
      "sheet": "look",
      "version": 1,
      "path": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
      "image": {
        "path": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
        "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwyf4sul",
        "width": 600,
        "height": 900,
        "bytes": 7997,
        "mtime": "2026-11-27T03:25:13.101Z"
      },
      "status": "approved",
      "role": "style",
      "approved_at": "2026-11-27",
      "approved_by": "person",
      "notes": "This is the look.",
      "promoted_from": "LOOK_NOIR_INK_V01",
      "superseded_by": null
    },
    "masters": "[1 item]",
    "candidates": [
      {
        "id": "LOOK_NOIR_INK_V01",
        "entity": "LOOK_NOIR_INK",
        "sheet": "look",
        "version": 1,
        "path": "references/style/LOOK_NOIR_INK_V01.png",
        "image": {
          "path": "references/style/LOOK_NOIR_INK_V01.png",
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_V01.png?v=665mwyf4sul",
          "width": 600,
          "height": 900,
          "bytes": 7997,
          "mtime": "2026-11-27T03:25:13.101Z"
        },
        "status": "candidate",
        "role": null,
        "approved_at": null,
        "approved_by": null,
        "notes": "",
        "promoted_to": "LOOK_NOIR_INK_MASTER_V01",
        "generation": {
          "id": "GEN_LOOK_NOIR_INK_01",
          "path": "generations/LOOK_NOIR_INK/GEN_LOOK_NOIR_INK_01.yaml",
          "provider": "codex-cli",
          "model": "unreported",
          "status": "succeeded",
          "created_at": "2026-11-27T03:25:12.989Z",
          "prompt_package": "PP_LOOK_NOIR_INK_CODEX-CLI-LOOK",
          "supplied_by_person": false,
          "summary": "Codex saved one 600x900 PNG in 1 s; 1 of 1 reference image(s) passed to the image tool as referenced…",
          "notes": "Codex notes: Placeholder from the fake drawing tool. Not art."
        }
      }
    ],
    "references": [
      {
        "id": "LOOK_NOIR_INK_REF_V01",
        "entity": "LOOK_NOIR_INK",
        "sheet": "reference",
        "version": 1,
        "path": "references/style/LOOK_NOIR_INK_REF_V01.png",
        "image": {
          "path": "references/style/LOOK_NOIR_INK_REF_V01.png",
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_REF_V01.png?v=11dmwyf4r43",
          "width": 200,
          "height": 300,
          "bytes": 1345,
          "mtime": "2026-11-27T03:25:10.851Z"
        },
        "status": "approved",
        "role": "style",
        "approved_at": "2026-11-27",
        "approved_by": "person",
        "notes": "Style reference supplied by the person through the studio. Original file name: style-reference.png. …"
      }
    ],
    "packages": [
      {
        "path": "references/style/prompts/codex-cli.LOOK_NOIR_INK.yaml",
        "id": "PP_LOOK_NOIR_INK_CODEX-CLI-LOOK",
        "provider": "codex-cli",
        "model": "codex-cli",
        "mode": "generate",
        "prompt": "Black-and-white comic book page in a high-contrast ink noir style.\nLine: brush and nib inking, heavy…",
        "negative_prompt": "watermark, signature, page number, photograph",
        "parameters": "{…}",
        "references": "[1 item]",
        "edit_target": null,
        "repair": null,
        "lettering_text": [],
        "stale": []
      }
    ]
  },
  "style_bible": {
    "path": "style/style-bible.md",
    "exists": true,
    "kind": "markdown",
    "schema": null,
    "text": "# Style bible\n\nStatus: draft\nLook: LOOK_NOIR_INK\nLook master: (none yet)\n\n## The look in one paragra…",
    "data": null,
    "parse_error": null,
    "findings": [],
    "etag": "384-1a21b091c76",
    "mtime": "2026-11-27T03:25:11.670Z",
    "url": "/api/projects/the-night-ferry/raw/style/style-bible.md"
  },
  "style_block": {
    "path": "style/style-block.txt",
    "exists": true,
    "kind": "text",
    "schema": null,
    "text": "Black-and-white comic book page in a high-contrast ink noir style.\nLine: brush and nib inking, heavy…",
    "data": null,
    "parse_error": null,
    "findings": [],
    "etag": "2dd-1a21b091c76",
    "mtime": "2026-11-27T03:25:11.670Z",
    "url": "/api/projects/the-night-ferry/raw/style/style-block.txt",
    "template": false,
    "frozen": true
  },
  "color_script": {
    "path": "style/color-script.md",
    "exists": true,
    "kind": "markdown",
    "schema": null,
    "text": "# Color script\n\nOne palette for the whole issue, set by LOOK_NOIR_INK.\n",
    "data": null,
    "parse_error": null,
    "findings": [],
    "etag": "47-1a21b091c76",
    "mtime": "2026-11-27T03:25:11.670Z",
    "url": "/api/projects/the-night-ferry/raw/style/color-script.md"
  },
  "options": "{…}",
  "choices": "{…}",
  "chat_key": "style",
  "screen": {
    "key": "style",
    "label": "Style",
    "label_code": "screen_label.style",
    "label_params": {},
    "route": "/p/the-night-ferry/style"
  }
}
```
<!-- /example:style -->

### `GET /api/projects/:id/characters`

The cast. `image` is the approved master, else the newest candidate, else an
uploaded reference. `has_master` means an approved sheet exists.
`has_identity` means pages can be drawn: the character has an approved
drawn sheet. An uploaded photo does not count, since it is only a likeness
source for the first sheet. `identity` says where the character stands in
the identity chain: `master` (`{ id, kind, path }` of the approved
turnaround or full sheet, or null), `identity` (the asset pages attach),
`photos` (the approved likeness sources), `photos_only`, and `needs_master`
(expressions and wardrobe sheets cannot be drawn yet). `candidates` counts
sheets waiting for a decision.

<!-- example:characters -->
```json
{
  "characters": [
    {
      "id": "CHAR_MARA",
      "name": "Mara",
      "role": "protagonist",
      "summary": "She has a broken nose.",
      "status": "draft",
      "file": "characters/CHAR_MARA/character.yaml",
      "image": {
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png",
        "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png?v=8bpmwyf4v8t",
        "width": 900,
        "height": 900,
        "bytes": 10789,
        "mtime": "2026-11-27T03:25:16.205Z"
      },
      "has_master": true,
      "has_identity": true,
      "identity": {
        "master": {
          "id": "CHAR_MARA_TURN_MASTER_V01",
          "kind": "turnaround",
          "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png"
        },
        "identity": "CHAR_MARA_TURN_MASTER_V01",
        "photos": ["CHAR_MARA_REF_V01"],
        "photos_only": false,
        "needs_master": false
      },
      "candidates": 1,
      "references": 1,
      "chat_key": "character:CHAR_MARA"
    }
  ],
  "look_approved": true,
  "chat_key": "characters",
  "screen": {
    "key": "characters",
    "label": "Characters",
    "label_code": "screen_label.characters",
    "label_params": {},
    "route": "/p/the-night-ferry/characters"
  }
}
```
<!-- /example:characters -->

### `GET /api/projects/:id/characters/:char`

One character: the summary above plus `character` and `wardrobe` (text
documents), `assets` (`masters`, `candidates`, `references`), `sheets` (per
kind: `{ master, candidates }` for `model`, `turnaround`, `expressions`,
`wardrobe`, `detail`), `packages` (compiled sheet prompts), `used_on` (page
IDs where the character appears), `look_approved`, `model_versions` (every
version of the full character sheet, oldest first, a master standing for the
candidate it was made from) and `sheet_plan` (`closeups` and `poses` as the
full sheet would show them now, one line each, and `saved` when they come
from the character file). A candidate drawn from the master carries `check`,
the identity check it had (`verdict`, `master`, `findings`, `redrawn`).

<!-- example:character -->
```json
{
  "id": "CHAR_MARA",
  "name": "Mara",
  "role": "protagonist",
  "summary": "She has a broken nose.",
  "status": "draft",
  "file": "characters/CHAR_MARA/character.yaml",
  "image": {
    "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png",
    "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png?v=8bpmwyf4…",
    "width": 900,
    "height": 900,
    "bytes": 10789,
    "mtime": "2026-11-27T03:25:16.205Z"
  },
  "has_master": true,
  "has_identity": true,
  "identity": {
    "master": {
      "id": "CHAR_MARA_TURN_MASTER_V01",
      "kind": "turnaround",
      "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png"
    },
    "identity": "CHAR_MARA_TURN_MASTER_V01",
    "photos": ["CHAR_MARA_REF_V01"],
    "photos_only": false,
    "needs_master": false
  },
  "candidates": 1,
  "references": 1,
  "chat_key": "character:CHAR_MARA",
  "character": {
    "path": "characters/CHAR_MARA/character.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "character",
    "text": "# Schema: schemas/character.schema.json\n\nid: CHAR_MARA\nname: Mara\naliases: []\nrole: protagonist\ndesc…",
    "data": {
      "id": "CHAR_MARA",
      "name": "Mara",
      "aliases": [],
      "role": "protagonist",
      "description": { "summary": "She has a broken nose.", "distinguishing_features": "[3 items]" },
      "prompt_summary": "She has a broken nose.",
      "visually_adjacent_to": [],
      "personality": "Says what is needed.",
      "...": "5 more"
    },
    "parse_error": null,
    "findings": [],
    "etag": "219-1a21b093433",
    "mtime": "2026-11-27T03:25:17.747Z",
    "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/character.yaml"
  },
  "wardrobe": {
    "path": "characters/CHAR_MARA/wardrobe.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "wardrobe",
    "text": "# Schema: schemas/wardrobe.schema.json\n\ncharacter: CHAR_MARA\noutfits:\n  - id: WARD_MARA_DEFAULT\n    …",
    "data": { "character": "CHAR_MARA", "outfits": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "149-1a21b09289f",
    "mtime": "2026-11-27T03:25:14.783Z",
    "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/wardrobe.yaml"
  },
  "assets": {
    "masters": [
      {
        "id": "CHAR_MARA_TURN_MASTER_V01",
        "entity": "CHAR_MARA",
        "sheet": "turnaround",
        "version": 1,
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png",
        "image": "{…}",
        "status": "approved",
        "role": "identity",
        "approved_at": "2026-11-27",
        "approved_by": "person",
        "notes": "",
        "promoted_from": "CHAR_MARA_TURN_V01",
        "superseded_by": null
      }
    ],
    "candidates": [
      {
        "id": "CHAR_MARA_EXPR_V01",
        "entity": "CHAR_MARA",
        "sheet": "expressions",
        "version": 1,
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png",
        "image": "{…}",
        "status": "candidate",
        "role": null,
        "approved_at": null,
        "approved_by": null,
        "notes": "",
        "promoted_to": null,
        "generation": "{…}",
        "check": "{…}"
      },
      "... 1 more"
    ],
    "references": [
      {
        "id": "CHAR_MARA_REF_V01",
        "entity": "CHAR_MARA",
        "sheet": "reference",
        "version": 1,
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_REF_V01.png",
        "image": "{…}",
        "status": "approved",
        "role": "identity",
        "approved_at": "2026-11-27",
        "approved_by": "person",
        "notes": "Identity reference supplied by the person through the studio. Original file name: mara.png. Licence …"
      }
    ]
  },
  "sheets": {
    "model": { "master": null, "candidates": [] },
    "turnaround": { "master": "{…}", "candidates": "[1 item]" },
    "expressions": { "master": null, "candidates": "[1 item]" },
    "wardrobe": { "master": null, "candidates": [] },
    "detail": { "master": null, "candidates": [] }
  },
  "packages": [
    {
      "path": "characters/CHAR_MARA/refs/prompts/codex-cli.expressions.yaml",
      "id": "PP_CHAR_MARA_CODEX-CLI-EXPR",
      "provider": "codex-cli",
      "model": "codex-cli",
      "mode": "generate",
      "prompt": "Black-and-white comic book page in a high-contrast ink noir style.\nLine: brush and nib inking, heavy…",
      "negative_prompt": "watermark, signature, text, labels, arrows, color swatches, scenery, dramatic lighting, photograph",
      "parameters": "{…}",
      "references": "[2 items]",
      "edit_target": null,
      "repair": null,
      "lettering_text": [],
      "stale": []
    },
    "... 1 more"
  ],
  "used_on": [],
  "look_approved": true,
  "model_versions": [],
  "sheet_plan": {
    "closeups": ["the face of Mara as described", "... 2 more"],
    "poses": ["neutral", "... 3 more"],
    "saved": false
  },
  "screen": {
    "key": "character:CHAR_MARA",
    "label": "Character: Mara",
    "label_code": "screen_label.character",
    "label_params": { "name": "Mara" },
    "route": "/p/the-night-ferry/characters/CHAR_MARA"
  }
}
```
<!-- /example:character -->

### `GET /api/projects/:id/entities`

Locations and props. They are written when pages are planned.

<!-- example:entities -->
```json
{
  "locations": [
    {
      "id": "LOC_MAIN_ROOM",
      "name": "Main room",
      "summary": "A plain room with a door on the left and a window on the right.",
      "status": "draft",
      "file": "locations/LOC_MAIN_ROOM/location.yaml",
      "image": null,
      "has_master": false,
      "candidates": 0,
      "chat_key": "location:LOC_MAIN_ROOM",
      "has_map": true
    }
  ],
  "props": [],
  "chat_key": "places",
  "screen": {
    "key": "places",
    "label": "Places and objects",
    "label_code": "screen_label.places",
    "label_params": {},
    "route": "/p/the-night-ferry/places"
  }
}
```
<!-- /example:entities -->

### `GET /api/projects/:id/locations/:loc`

One location: the summary plus `location` and `map` (text documents),
`assets` and `packages`.

<!-- example:location -->
```json
{
  "id": "LOC_MAIN_ROOM",
  "name": "Main room",
  "summary": "A plain room with a door on the left and a window on the right.",
  "status": "draft",
  "file": "locations/LOC_MAIN_ROOM/location.yaml",
  "image": null,
  "has_master": false,
  "candidates": 0,
  "chat_key": "location:LOC_MAIN_ROOM",
  "assets": { "masters": [], "candidates": [], "references": [] },
  "packages": [],
  "location": {
    "path": "locations/LOC_MAIN_ROOM/location.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "location",
    "text": "# Schema: schemas/location.schema.json\n\nid: LOC_MAIN_ROOM\nname: Main room\ndescription:\n  summary: A …",
    "data": {
      "id": "LOC_MAIN_ROOM",
      "name": "Main room",
      "description": {
        "summary": "A plain room with a door on the left and a window on the right.",
        "architecture": "One level, four walls, a door and a window.",
        "dressing": "A table in the middle.",
        "light": "Daylight from the window."
      },
      "prompt_summary": "A plain room with a door on the left, a table in the middle and a window on the right.",
      "time_of_day_states": ["day"],
      "map_file": "map.yaml",
      "references": [],
      "status": "draft"
    },
    "parse_error": null,
    "findings": [],
    "etag": "1db-1a21b093e18",
    "mtime": "2026-11-27T03:25:20.280Z",
    "url": "/api/projects/the-night-ferry/raw/locations/LOC_MAIN_ROOM/location.yaml"
  },
  "map": {
    "path": "locations/LOC_MAIN_ROOM/map.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "location-map",
    "text": "# Schema: schemas/location-map.schema.json\n\nlocation: LOC_MAIN_ROOM\nlevels:\n  - id: ground\n    descr…",
    "data": {
      "location": "LOC_MAIN_ROOM",
      "levels": ["{…}"],
      "sides": { "convention": "The door is screen left, the window screen right.", "left": "door", "right": "window" },
      "landmarks": ["{…}", "... 2 more"],
      "exits": ["{…}"],
      "connections": []
    },
    "parse_error": null,
    "findings": [],
    "etag": "230-1a21b093e18",
    "mtime": "2026-11-27T03:25:20.280Z",
    "url": "/api/projects/the-night-ferry/raw/locations/LOC_MAIN_ROOM/map.yaml"
  },
  "screen": {
    "key": "location:LOC_MAIN_ROOM",
    "label": "Place: Main room",
    "label_code": "screen_label.location",
    "label_params": { "name": "Main room" },
    "route": "/p/the-night-ferry/places/location/LOC_MAIN_ROOM"
  }
}
```
<!-- /example:location -->

### `GET /api/projects/:id/props/:prop`

One prop: the summary plus `prop` (text document), `assets` and `packages`.
Same shape as a location without `map`.

### `GET /api/projects/:id/issues`

The issues of the series plan and of the workspace.

<!-- example:issues -->
```json
{
  "issues": [
    {
      "id": "ISS_001",
      "number": 1,
      "title": "Crossing",
      "summary": "Mara crosses the river alone at night.",
      "status": "scripting",
      "page_budget": 3,
      "pages": 3,
      "rendered": 3,
      "passed": 3,
      "cover": {
        "exists": false,
        "status": null,
        "approved_render": null,
        "renders": 0,
        "current_render": null,
        "image": null,
        "verdict": null,
        "outcome": null,
        "open_findings": 0,
        "open_notes": 0,
        "accepted_notes": 0,
        "overruled": false,
        "overruled_at": null,
        "overrule_note": null,
        "human_approval": null,
        "passes": false
      }
    }
  ]
}
```
<!-- /example:issues -->

### `POST /api/projects/:id/issues`

Starts the next issue of the series. Body: `title` (required, at most 120
characters), `pages` (a rough page count, 1 to 200, default 4) and
`summary` (optional). It writes two things and nothing else: the entry of
the series plan (`story/series-plan.yaml`) and
`issues/<ISS_ID>/issue.yaml`, with no scene and no page yet. The look, the
characters, the places, the props and the story bible belong to the project,
so the new issue uses them as they are.

`opens_from` points at the continuity state the previous issue ended in,
`continuity/<ISS_ID>.final-state.yaml`. When the scaffold's
`/continuity-review` has written that file, it is used as it is. When it is
not there, the studio derives it from the panel ledger of the previous
issue: the last row of every character (place, position, outfit, state tags,
props in hand) and the last known place of every prop. A derived file says
so in its `notes` and has no open threads. It is derived again when the
previous issue gains pages before the new one has any. An issue after an
issue with no pages opens from nothing (`opens_from: null`).

Answers 201 with `{ issue, number, title, page_budget, previous,
opens_from, state_written, files, commit, screen }`: `state_written` is
`true` when the end state was derived now, and `screen` is the Pages screen
of the new issue. 400 `bad_params` for a missing title or a bad page count;
409 `project_busy` while pages are being planned.

The first `pages.plan` of the new issue reads that state: the prompt names
the file, the plan keeps `opens_from` in `issue.yaml` (the studio puts it
back if a run drops it), and `check-continuity.js` seeds the ledger of the
issue from it, so the first page is checked against where the last issue
ended.

### `GET /api/projects/:id/issues/:issue`

The pages screen of one issue.

| Field | Meaning |
|---|---|
| `issue` | `issues/<ISS_ID>/issue.yaml` as a text document (`exists: false` before the first plan). |
| `planned` | The issue's entry in the series plan. |
| `scenes` | `[{ id, path, summary, location, cast, pages }]`. |
| `pages` | One summary per page, in reading order (fields below). |
| `counts` | `pages`, `planned_budget`, `plan_approved`, `rendered`, `passed` (pass or notes), `with_notes`, `flagged`. |
| `mechanical` | `continuity` (findings of `check-continuity.js`, each with `code`, `severity`, `page`, `panel`, `entity`, `message`, `hint`), `validation` (`errors` and `warnings` of `validate-workspace.js`, each `{ file, code, message }`) and `errors`, their count. Always show the errors. `skipped: true` while a page plan of this issue is being written: then the lists are empty and `planning` says how far the plan is. |
| `planning` | While a `pages.plan` job of this issue runs or waits for an answer: `{ job, status, step, phase, pages, written, current }`. `phase` is `breakdown`, `pages` or `checks`; in `pages`, the screen says "planning page `current` of `pages`" (`written` page files are on disk). Else `null`. The page screen has the same field, and its `findings.skipped`. |
| `added` | What page plans of this issue added: the latest plan's characters, places and props, and those of earlier plans that still need a sheet or a decision about a possible duplicate. `{ job, ended_at, entities: [{ id, kind, name, path, exists, needs_sheet, duplicates, job }] }`, or `null`. See [What a step added](#what-a-step-added). |
| `draw` | `{ available, tool, reason, look_approved }`: whether pages can be drawn now. |
| `repair_limit` | Automatic repair cycles per page. |
| `cover` | Cover summary: `{ exists, status, approved_render, renders, current_render, image, verdict, outcome, open_findings, open_notes, accepted_notes, overruled, overruled_at, overrule_note, human_approval, passes }`. The review fields mean what they mean in a page summary. |

Page summary fields:

| Field | Meaning |
|---|---|
| `id`, `number`, `scene`, `purpose` | From `page.yaml`. |
| `status` | `planned`, `scripted`, `prompted`, `rendered`, `reviewed` or `approved`. |
| `panels` | Panel count. |
| `plan_approved` | `true` when the person approved the plan and it has not changed since. |
| `current_render`, `renders` | The render that counts, and how many versions exist. |
| `image` | The current render. |
| `verdict`, `outcome`, `passes`, `flagged`, `open_findings`, `repair_cycle`, `independent`, `human_approval` | From the review of the current render. `outcome` is `pass`, `notes` or `flagged`, or `null` before a review. |
| `open_notes` | Number of open minor findings in that review: the notes of a page that passes with notes. `0` before a review. |
| `accepted_notes` | Number of minor findings the person accepted, by approving the page or by overruling the review. |
| `overruled`, `overruled_at`, `overrule_note` | `true` when the person approved the current render against a flagged review, with the date (`YYYY-MM-DD`) and the note they gave, or `null`. `false` and `null` otherwise. |
| `blockers` | `[{ code, message, detail }]`: what stops this page from being drawn (a character with no approved sheet, a look that is not approved). `message` is the sentence for the person (`message_code` is `blocker.<code>`), `detail` is the scaffold script's own text, which names the files. Empty for a page that already has a passing render. |
| `budget` | Only on a page whose cast needs more reference images than the drawing tool takes: the same list as `findings.budget` of [the page](#get-apiprojectsidpagespage). |

<!-- example:issue -->
```json
{
  "id": "ISS_001",
  "issue": {
    "path": "issues/ISS_001/issue.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "issue",
    "text": "# Schema: schemas/issue.schema.json\n\nid: ISS_001\nnumber: 1\ntitle: Crossing\nsumma…",
    "data": {
      "id": "ISS_001",
      "number": 1,
      "title": "Crossing",
      "summary": "Mara crosses the river alone at night.",
      "scenes": ["SC_001_01"],
      "page_count": 3,
      "opens_from": null,
      "status": "scripting",
      "...": "1 more"
    },
    "parse_error": null,
    "findings": [],
    "etag": "d1-1a21b09416e",
    "mtime": "2026-11-27T03:25:21.134Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/issue.yaml"
  },
  "planned": { "id": "ISS_001", "number": 1, "title": "Crossing", "page_budget": 3, "status": "planning" },
  "scenes": [
    {
      "id": "SC_001_01",
      "path": "issues/ISS_001/scenes/SC_001_01.yaml",
      "summary": "Mara crosses the river alone at night.",
      "location": "LOC_MAIN_ROOM",
      "cast": ["CHAR_MARA"],
      "pages": ["PG_001_001", "... 2 more"]
    }
  ],
  "pages": [
    {
      "id": "PG_001_001",
      "number": 1,
      "scene": "SC_001_01",
      "purpose": "Mara crosses the river alone at night.",
      "status": "reviewed",
      "panels": 3,
      "plan_approved": true,
      "current_render": "PG_001_001_V01",
      "renders": 1,
      "image": {
        "path": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png?v=73tmwyf51ke",
        "width": 600,
        "height": 900,
        "bytes": 9209,
        "mtime": "2026-11-27T03:25:24.398Z"
      },
      "verdict": "pass",
      "outcome": "pass",
      "passes": true,
      "flagged": false,
      "open_findings": 0,
      "open_notes": 0,
      "accepted_notes": 0,
      "overruled": false,
      "overruled_at": null,
      "overrule_note": null,
      "repair_cycle": 0,
      "independent": true,
      "human_approval": "pending",
      "blockers": []
    },
    "... 2 more"
  ],
  "counts": {
    "pages": 3,
    "planned_budget": 3,
    "plan_approved": 3,
    "rendered": 3,
    "passed": 3,
    "with_notes": 1,
    "flagged": 0
  },
  "mechanical": {
    "note": "These checks read the plan files. They say nothing about a drawing.",
    "note_code": "note.mechanical",
    "note_params": {},
    "continuity": [],
    "validation": { "errors": [], "warnings": [] },
    "errors": 0,
    "skipped": false
  },
  "planning": null,
  "added": {
    "job": "job_202611270325202250x_37e1",
    "ended_at": "2026-11-27T03:25:23Z",
    "entities": [
      {
        "job": "job_202611270325202250x_37e1",
        "id": "LOC_MAIN_ROOM",
        "kind": "location",
        "name": "Main room",
        "path": "locations/LOC_MAIN_ROOM/location.yaml",
        "exists": true,
        "needs_sheet": false,
        "duplicates": []
      }
    ]
  },
  "draw": { "available": true, "tool": "codex", "reason": null, "look_approved": true },
  "repair_limit": 1,
  "cover": {
    "exists": false,
    "status": null,
    "approved_render": null,
    "renders": 0,
    "current_render": null,
    "image": null,
    "verdict": null,
    "outcome": null,
    "open_findings": 0,
    "open_notes": 0,
    "accepted_notes": 0,
    "overruled": false,
    "overruled_at": null,
    "overrule_note": null,
    "human_approval": null,
    "passes": false
  },
  "chat_key": "pages:ISS_001",
  "screen": {
    "key": "pages:ISS_001",
    "label": "Pages of issue 1",
    "label_code": "screen_label.pages",
    "label_params": { "n": 1 },
    "route": "/p/the-night-ferry/pages"
  }
}
```
<!-- /example:issue -->

### `GET /api/projects/:id/pages/:page`

Everything about one page.

| Field | Meaning |
|---|---|
| `page` | `page.yaml` as a text document: layout, panel script, ledger, lettering text. |
| `plan` | The short readable plan: `purpose`, `grid`, `tiers`, `panels[]` (`id`, `number`, `slot`, `size`, `shot`, `moment`, `location`, `cast[]` with `character`, `name`, `off_panel`, `action`, `where`, `side` (the side of the location the character stands on, which a tail from off panel runs to), `holding`, `state`, and `lettering[]` with `id`, `type`, `speaker`, `speaker_name`, `text`) and `text`, the same as plain lines under a heading in the language of the request. |
| `plan.panels[].slot` | Where the panel sits, as the plan says it: `{ tier, tiers, slot, of, placement }`. `tier` of `tiers` counts rows from the top, `slot` of `of` counts panels in the row in reading order, and `placement` is the scaffold's word for it (`full width`, `left`, `center`, `right`). `null` when `layout.tiers` is missing or does not add up to the panels of the page. There is no rectangle: see below. |
| `plan_approval` | `{ approved, at, stale }`. `stale` is `true` when the plan changed after it was approved. |
| `renders` | Every version, oldest first (fields below). |
| `prompts` | The compiled prompt packages of the page: `path`, `id`, `provider`, `model`, `mode` (`generate` or `repair`), `prompt`, `negative_prompt`, `parameters`, `references[]` (`asset_id`, `role`, `path`, `image`), `edit_target`, `repair` (`of_render`, `findings`, `changes`, `locked`), `lettering_text`, and `stale` (reasons the package no longer matches its sources). |
| `reference_plan` | `reference-plan.yaml` as a text document plus `entries[]`: each planned reference with `asset_id`, `entity`, `role`, `priority`, `reason`, `omission_risk`, `required` and its `image`. |
| `findings` | Mechanical findings for this page: `continuity`, `validation` (`errors`, `warnings`), `schema`, `blockers`, and `budget`. The continuity check runs against the provider that will draw, so its `REFERENCE_BUDGET` warnings speak of that tool. |
| `findings.budget` | The `REFERENCE_BUDGET` warnings of the page in plain words: `[{ scope, panel, number, count, capacity, names, fits_per_panel, per_panel, panels_over, message, actions }]`. `scope` is `page` (drawn as one image, the cast needs `count` reference images and the tool takes `capacity`) or `panel` (one panel is over it even on its own). `names` are the look page and the characters by name; `message` says it with its code. `actions` lists what the person can do: `per_panel` ([draw it panel by panel](#post-apiprojectsidpagespagemode), offered when every panel fits) and `staging` (ask for a change of staging, which comes back as a proposal; nothing moves a character off panel on its own). Empty when the page fits. |
| `generation_mode` | `full_page` or `per_panel`. |
| `panel_images` | For a page drawn panel by panel: the newest image of each panel, `[{ panel, record, file, at, image }]`, for the person to put together in the layout and upload as the page (`page.manual` with `upload`). Empty otherwise. |
| `lettering` | `mode` (`in_image` or `overlay`), `geometry` (`lettering.yaml` as a text document), `needs_placement`, and for the plan editor `limits` (`words_per_balloon` and `words_per_panel` from `project.lettering`, else 25 and 50; `per_panel`, the rule's ceiling of 4 balloons and captions), `kinds` (the lettering types in the order the editor offers them) and `spoken` (the kinds that have a speaker). |
| `repair_limit`, `touch_up_warning` | The automatic repair limit, and the edits of one image after which a correction needs the person's choice. |
| `draw` | `{ available, tool, reason }`. |
| `neighbors` | `{ previous, next }` page IDs. |
| `assumptions` | What the planner filled in that the person's text did not say, so the page could be drawn: `[{ panel, text, job, at }]`. `panel` is a panel id or `null` for the whole page; `text` is in the interface language. Show them to the person: each one can be changed in the plan (the page file, a chat message, or a correction). Planning the page again replaces the list. Empty for a page planned before this existed. |

Panels have no `rect`. A page plan says how many tiers the page has and how
many panels sit in each (`layout.tiers`), and a size word per panel
(`size`). It gives no tier heights and no panel widths, and nothing
measures the gutters of the drawn image, so a rectangle in pixels or in
fractions would be a guess that the drawing does not have to follow. `slot`
is what the plan knows. A region a person marks on a page goes into a
change request as fractions of the page (`region` in `page.correct`).

Render fields:

| Field | Meaning |
|---|---|
| `id`, `version`, `current` | `current` marks the page's `current_render`. |
| `image` | The render. |
| `lettered` | The flat lettered image (overlay mode), or `null`. |
| `overlay` | `{ path, url }` of the SVG overlay, or `null`. |
| `review` | `null` before a review. Else `path`, `verdict`, `outcome` (`pass`, `notes` or `flagged`), `passes`, `open_blocking`, `independent`, `reviewer`, `repair_cycle`, `reviewed_at`, `supersedes`, `human_approval` (`status`, `by`, `at`), `gates` (`style_fidelity`, `narrative_continuity`), `checks` (fourteen keys, each `{ result, evidence }`), `findings[]`, `open_findings`, `open_notes`, `accepted_notes`, `change_requests`, `compared_against`, `notes`, and the overrule fields below. |
| `review.open_notes`, `accepted_notes` | Counts of minor findings that are `open`, and of minor findings that are `accepted`. |
| `review.overruled` | `true` when the person approved this render against a flagged review. |
| `review.overruled_at`, `overrule_note` | The date of the overrule (`YYYY-MM-DD`) and the person's note, or `null`. |
| `review.overruled_items` | What was overruled: finding ids, with `!` after one the reviewer had recorded as blocking (`F01!`), and `gate <name>` for a gate that had failed. Empty when nothing was. |
| `review.findings[]` | `id`, `panel`, `check`, `expected`, `visible`, `severity` (`blocking` or `minor`), `repair`, `status` (`open`, `fixed`, `accepted`), `recheck` (`render`, `evidence`) once fixed, and for a person's request `source: "user_request"` and an optional `region` (`x`, `y`, `w`, `h` as fractions of the page). |
| `generation` | The generation record in short. `supplied_by_person` is `true` for an uploaded image. `status: "rejected"` marks a render that was replaced. |

<!-- example:page -->
```json
{
  "id": "PG_001_002",
  "issue": "ISS_001",
  "number": 2,
  "status": "reviewed",
  "current_render": "PG_001_002_V02",
  "page": {
    "path": "issues/ISS_001/pages/PG_001_002/page.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "page",
    "text": "# Schema: schemas/page.schema.json\n\nid: PG_001_002\nissue: ISS_001\nnumber: 2\nscene: SC_001_01\npurpose: FLAG She…",
    "data": {
      "id": "PG_001_002",
      "issue": "ISS_001",
      "number": 2,
      "scene": "SC_001_01",
      "purpose": "FLAG She hears the crates shift and goes down to the deck.",
      "page_turn": "none",
      "layout": { "grid": "two tiers, 1 / 2", "tiers": "[2 items]", "reading_order": "[3 items]", "notes": "" },
      "panels": ["{…}", "... 2 more"],
      "...": "7 more"
    },
    "parse_error": null,
    "findings": [],
    "etag": "ea7-1a21b09633f",
    "mtime": "2026-11-27T03:25:29.791Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/page.yaml"
  },
  "plan": {
    "purpose": "FLAG She hears the crates shift and goes down to the deck.",
    "grid": "two tiers, 1 / 2",
    "tiers": [1, 2],
    "panels": [
      {
        "id": "PN_001_002_01",
        "number": 1,
        "slot": { "tier": 1, "tiers": 2, "slot": 1, "of": 1, "placement": "full width" },
        "size": "wide",
        "shot": "wide",
        "moment": "The place where this happens: FLAG She hears the crates shift and goes down to the deck.",
        "location": "LOC_MAIN_ROOM",
        "cast": [
          {
            "character": "CHAR_MARA",
            "name": "Mara",
            "off_panel": false,
            "action": "Stands and looks across the room.",
            "where": "ground, door",
            "side": "left",
            "holding": [],
            "state": []
          }
        ],
        "lettering": [
          {
            "id": "L01",
            "type": "caption",
            "speaker": null,
            "speaker_name": null,
            "text": "FLAG She hears the crates shift and goes down to the deck."
          }
        ]
      },
      "... 2 more"
    ],
    "text": "Page 2: FLAG She hears the crates shift and goes down to the deck.\n1. The place where this happens: FLAG She h…",
    "text_code": "plan.text",
    "text_params": {
      "n": 2,
      "purpose": "FLAG She hears the crates shift and goes down to the deck.",
      "body": "1. The place where this happens: FLAG She hears the crates shift and goes down to the deck. (Mara)\n   [caption…"
    }
  },
  "plan_approval": { "approved": true, "at": "2026-11-27T03:25:23Z", "stale": false },
  "renders": [
    {
      "id": "PG_001_002_V01",
      "version": 1,
      "current": false,
      "image": {
        "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png?v=74gmwyf53tx",
        "width": 600,
        "height": 900,
        "bytes": 9232,
        "mtime": "2026-11-27T03:25:27.333Z"
      },
      "lettered": null,
      "overlay": null,
      "review": {
        "path": "issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V01.review.yaml",
        "verdict": "flagged",
        "outcome": "flagged",
        "passes": false,
        "independent": true,
        "reviewer": "visual-reviewer",
        "repair_cycle": 0,
        "reviewed_at": "2026-11-27",
        "supersedes": null,
        "human_approval": { "status": "pending", "by": null, "at": null },
        "gates": { "style_fidelity": "pass", "narrative_continuity": "fail" },
        "checks": {
          "identity": {
            "result": "fail",
            "evidence": "Placeholder: the figure in the first panel is drawn as someone else."
          },
          "cast_count": {
            "result": "pass",
            "evidence": "Placeholder evidence for cast count: the fake reviewer does not look at pixels."
          },
          "...": "12 more"
        },
        "findings": [
          {
            "id": "F01",
            "panel": "PN_001_002_01",
            "check": "identity",
            "expected": "The character matches the approved sheet.",
            "visible": "Placeholder finding forced by the word FLAG in the text.",
            "severity": "blocking",
            "repair": "Redraw the figure from the approved sheet and keep everything else as it is.",
            "status": "open"
          }
        ],
        "open_findings": 1,
        "open_blocking": 1,
        "open_notes": 0,
        "accepted_notes": 0,
        "overruled": false,
        "overruled_at": null,
        "overrule_note": null,
        "overruled_items": [],
        "change_requests": 0,
        "compared_against": {
          "references": ["LOOK_NOIR_INK_MASTER_V01", "CHAR_MARA_TURN_MASTER_V01"],
          "neighbors": ["PG_001_001_V01"]
        },
        "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
      },
      "generation": {
        "id": "GEN_PG_001_002_01",
        "path": "generations/PG_001_002/GEN_PG_001_002_01.yaml",
        "provider": "codex-cli",
        "model": "unreported",
        "status": "rejected",
        "created_at": "2026-11-27T03:25:27.207Z",
        "prompt_package": "PP_PG_001_002_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 3 of 3 reference image(s) passed to the image tool as referenced_image_pat…",
        "notes": "Codex notes: Placeholder from the fake drawing tool. Not art. Replaced by PG_001_002_V02 after review."
      }
    },
    {
      "id": "PG_001_002_V02",
      "version": 2,
      "current": true,
      "image": {
        "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png?v=6wjmwyf554f",
        "width": 600,
        "height": 900,
        "bytes": 8947,
        "mtime": "2026-11-27T03:25:29.007Z"
      },
      "lettered": null,
      "overlay": null,
      "review": {
        "path": "issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V02.review.yaml",
        "verdict": "fixed",
        "outcome": "pass",
        "passes": true,
        "independent": true,
        "reviewer": "visual-reviewer",
        "repair_cycle": 1,
        "reviewed_at": "2026-11-27",
        "supersedes": "PG_001_002_V01",
        "human_approval": { "status": "pending", "by": null, "at": null },
        "gates": { "style_fidelity": "pass", "narrative_continuity": "pass" },
        "checks": {
          "identity": {
            "result": "pass",
            "evidence": "Placeholder evidence for identity: the fake reviewer does not look at pixels."
          },
          "cast_count": {
            "result": "pass",
            "evidence": "Placeholder evidence for cast count: the fake reviewer does not look at pixels."
          },
          "...": "12 more"
        },
        "findings": [
          {
            "id": "F01",
            "panel": "PN_001_002_01",
            "check": "identity",
            "expected": "The character matches the approved sheet.",
            "visible": "Placeholder finding forced by the word FLAG in the text.",
            "severity": "blocking",
            "repair": "Redraw the figure from the approved sheet and keep everything else as it is.",
            "status": "fixed",
            "recheck": {
              "render": "PG_001_002_V02",
              "evidence": "Placeholder: the change is present in the new render."
            }
          }
        ],
        "open_findings": 0,
        "open_blocking": 0,
        "open_notes": 0,
        "accepted_notes": 0,
        "overruled": false,
        "overruled_at": null,
        "overrule_note": null,
        "overruled_items": [],
        "change_requests": 0,
        "compared_against": {
          "references": ["LOOK_NOIR_INK_MASTER_V01", "CHAR_MARA_TURN_MASTER_V01"],
          "neighbors": ["PG_001_001_V01"]
        },
        "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
      },
      "generation": {
        "id": "GEN_PG_001_002_02",
        "path": "generations/PG_001_002/GEN_PG_001_002_02.yaml",
        "provider": "codex-cli",
        "model": "unreported",
        "status": "succeeded",
        "created_at": "2026-11-27T03:25:28.784Z",
        "prompt_package": "PP_PG_001_002_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 4 of 4 reference image(s) passed to the image tool as referenced_image_pat…",
        "notes": "Codex notes: Placeholder from the fake drawing tool. Not art."
      }
    }
  ],
  "prompts": [
    {
      "path": "issues/ISS_001/pages/PG_001_002/prompts/codex-cli.yaml",
      "id": "PP_PG_001_002_CODEX-CLI",
      "provider": "codex-cli",
      "model": "codex-cli",
      "mode": "repair",
      "prompt": "Black-and-white comic book page in a high-contrast ink noir style.\nLine: brush and nib inking, heavy variable-…",
      "negative_prompt": "watermark, signature, page number, extra panels, duplicated characters, merged bodies",
      "parameters": "{…}",
      "references": "[3 items]",
      "edit_target": "{…}",
      "repair": "{…}",
      "lettering_text": "[2 items]",
      "stale": []
    }
  ],
  "reference_plan": {
    "path": "issues/ISS_001/pages/PG_001_002/reference-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "reference-plan",
    "text": "page: PG_001_002\nprovider: codex-cli\nbudget: 5\nmode: full_page\nrequired:\n  - asset_id: LOOK_NOIR_INK_MASTER_V0…",
    "data": {
      "page": "PG_001_002",
      "provider": "codex-cli",
      "budget": 5,
      "mode": "full_page",
      "required": ["{…}", "... 1 more"],
      "optional": ["{…}"],
      "exclude": [],
      "created_at": "2026-11-27"
    },
    "parse_error": null,
    "findings": [],
    "etag": "363-1a21b0955fc",
    "mtime": "2026-11-27T03:25:26.396Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/reference-plan.yaml",
    "entries": [
      {
        "asset_id": "LOOK_NOIR_INK_MASTER_V01",
        "entity": "LOOK_NOIR_INK",
        "role": "style",
        "priority": "critical",
        "reason": "Fixed drawing style, attached to every request.",
        "omission_risk": "Line, tone, and rendering drift toward the model default.",
        "required": true,
        "image": {
          "path": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwyf4sul",
          "width": 600,
          "height": 900,
          "bytes": 7997,
          "mtime": "2026-11-27T03:25:13.101Z"
        }
      },
      "... 2 more"
    ]
  },
  "planning": null,
  "findings": {
    "skipped": false,
    "note": "Checks of the plan files. What a review says about the drawing is a separate thing, under each version.",
    "note_code": "note.mechanical.page",
    "note_params": {},
    "continuity": [],
    "validation": { "errors": [], "warnings": [] },
    "schema": [],
    "blockers": [],
    "budget": []
  },
  "generation_mode": "full_page",
  "panel_images": [],
  "lettering": {
    "mode": "in_image",
    "geometry": {
      "path": "issues/ISS_001/pages/PG_001_002/lettering.yaml",
      "exists": false,
      "kind": "yaml",
      "schema": "lettering",
      "text": "",
      "data": null,
      "parse_error": null,
      "findings": [],
      "etag": null,
      "mtime": null,
      "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/lettering.yaml"
    },
    "needs_placement": false,
    "limits": { "words_per_balloon": 25, "words_per_panel": 50, "per_panel": 4 },
    "kinds": ["balloon", "... 8 more"],
    "spoken": ["balloon", "... 4 more"]
  },
  "draw": { "available": true, "tool": "codex", "reason": null },
  "repair_limit": 1,
  "touch_up_warning": 2,
  "neighbors": { "previous": "PG_001_001", "next": "PG_001_003" },
  "assumptions": [
    {
      "panel": "PN_001_002_01",
      "text": "Placeholder: the figures stand left and right of the room and hold nothing, because the text does not say.",
      "job": "job_202611270325202250x_37e1",
      "at": "2026-11-27T03:25:21Z"
    }
  ],
  "chat_key": "page:PG_001_002",
  "screen": {
    "key": "page:PG_001_002",
    "label": "Page 2",
    "label_code": "screen_label.page",
    "label_params": { "n": 2 },
    "route": "/p/the-night-ferry/pages/PG_001_002"
  }
}
```
<!-- /example:page -->

### `GET /api/projects/:id/issues/:issue/cover`

The cover of an issue. `exists` is `false` before `cover.create`. `cover` is
`cover.yaml` as a text document, `renders` has the shape of a page's renders,
and `approved_render` is the version the edition ships. The review fields of
the current render are at the top level, as in a page summary: `verdict`,
`outcome`, `passes`, `open_findings`, `open_notes`, `accepted_notes`,
`overruled`, `overruled_at`, `overrule_note` and `human_approval`.

<!-- example:cover -->
```json
{
  "exists": true,
  "status": "approved",
  "approved_render": "CV_001_V03",
  "renders": [
    {
      "id": "CV_001_V01",
      "version": 1,
      "current": false,
      "image": {
        "path": "issues/ISS_001/cover/renders/CV_001_V01.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V01.png?v=6dwmwyf5de3",
        "width": 600,
        "height": 900,
        "bytes": 8276,
        "mtime": "2026-11-27T03:25:39.723Z"
      },
      "lettered": null,
      "overlay": null,
      "review": {
        "path": "issues/ISS_001/cover/reviews/CV_001_V01.review.yaml",
        "verdict": "pass",
        "outcome": "pass",
        "passes": true,
        "independent": true,
        "reviewer": "visual-reviewer",
        "repair_cycle": 0,
        "reviewed_at": "2026-11-27",
        "supersedes": null,
        "human_approval": { "status": "pending", "by": null, "at": null },
        "gates": { "style_fidelity": "pass", "narrative_continuity": "pass" },
        "checks": {
          "identity": {
            "result": "pass",
            "evidence": "Placeholder evidence for identity: the fake reviewer does not look at pixels."
          },
          "cast_count": {
            "result": "pass",
            "evidence": "Placeholder evidence for cast count: the fake reviewer does not look at pixels."
          },
          "...": "12 more"
        },
        "findings": [],
        "open_findings": 0,
        "open_blocking": 0,
        "open_notes": 0,
        "accepted_notes": 0,
        "overruled": false,
        "overruled_at": null,
        "overrule_note": null,
        "overruled_items": [],
        "change_requests": 0,
        "compared_against": { "references": ["LOOK_NOIR_INK_MASTER_V01", "... 1 more"], "neighbors": [] },
        "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
      },
      "generation": {
        "id": "GEN_CV_001_01",
        "path": "generations/CV_001/GEN_CV_001_01.yaml",
        "provider": "codex-cli",
        "model": "unreported",
        "status": "succeeded",
        "created_at": "2026-11-27T03:25:39.619Z",
        "prompt_package": "PP_CV_001_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 2 of 2 reference image(s) passed to the image tool as referenced…",
        "notes": "Codex notes: Placeholder from the fake drawing tool. Not art."
      }
    },
    "... 2 more"
  ],
  "current_render": "CV_001_V03",
  "image": {
    "path": "issues/ISS_001/cover/renders/CV_001_V03.png",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V03.png?v=6tsmwyf5fqh",
    "width": 600,
    "height": 900,
    "bytes": 8848,
    "mtime": "2026-11-27T03:25:42.761Z"
  },
  "verdict": "fixed",
  "outcome": "pass",
  "open_findings": 0,
  "open_notes": 0,
  "accepted_notes": 0,
  "overruled": false,
  "overruled_at": null,
  "overrule_note": null,
  "human_approval": "approved",
  "passes": true,
  "id": "CV_001",
  "issue": "ISS_001",
  "cover": {
    "path": "issues/ISS_001/cover/cover.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "cover",
    "text": "# Schema: schemas/cover.schema.json\n\nid: CV_001\nissue: ISS_001\nconcept: \"Mara at the wheel at night,…",
    "data": {
      "id": "CV_001",
      "issue": "ISS_001",
      "concept": "Mara at the wheel at night, the river behind her.",
      "composition": "Figures in the lower two thirds, the top third left free for the title.",
      "location": "LOC_MAIN_ROOM",
      "time_of_day": "day",
      "cast": ["{…}"],
      "props": [],
      "...": "4 more"
    },
    "parse_error": null,
    "findings": [],
    "etag": "260-1a21b09993b",
    "mtime": "2026-11-27T03:25:43.611Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/cover.yaml"
  },
  "render_count": 3,
  "prompts": "[1 item]",
  "look_approved": true,
  "chat_key": "cover:ISS_001",
  "screen": {
    "key": "cover:ISS_001",
    "label": "Cover of issue 1",
    "label_code": "screen_label.cover",
    "label_params": { "n": 1 },
    "route": "/p/the-night-ferry/cover"
  }
}
```
<!-- /example:cover -->

### `GET /api/projects/:id/issues/:issue/publish`

| Field | Meaning |
|---|---|
| `formats` | `[{ id, label }]` for `publish.build`. |
| `readiness.final_possible` | `true` when a final edition can be built now. |
| `readiness.draft_possible` | `true` when at least one page has a render. |
| `readiness.blockers` | `[{ page, render, code, message }]`. Codes: `no_render`, `render_missing`, `no_review`, `not_passing` (a flagged review; a page with notes passes), `not_lettered`, `continuity`. `message` is the sentence for the person (`message_code` is `publish.blocker.<code>`). With blockers, a build is a marked draft. |
| `next_edition` | What a build would ship now: `id`, `pages[]` (`page`, `render`, `file`, `lettered_file`, `image`), `cover`, `supersedes`, `changes`, and `reuses` (the id of the latest edition when nothing changed since, in which case a build adds formats to that edition). |
| `lettering` | `mode`, and in overlay mode `pages[]` with `page`, `render`, `lettered_file`, `needs_placement`. |
| `editions` | Newest first: `id`, `path`, `title`, `label`, `status` (`draft`, `reviewed`, `published`), `created_at`, `supersedes`, `changes`, `cover`, `pages` (count) and `exports[]`. |
| `editions[].exports[]` | `format`, `file`, `built_at`, `exists`, `bytes`, `draft` (the file name carries `-DRAFT`), `url`, `download_url` (the same with `?download=1`; `null` for the web reader) and `browsable` (`true` for the web reader, whose `url` opens it). |

<!-- example:publish -->
```json
{
  "issue": "ISS_001",
  "formats": [
    { "id": "pdf", "label": "PDF", "label_code": "format.pdf", "label_params": {} },
    { "id": "cbz", "label": "CBZ (comic reader apps)", "label_code": "format.cbz", "label_params": {} },
    { "id": "web", "label": "Web reader", "label_code": "format.web", "label_params": {} },
    { "id": "images", "label": "Images, one per page", "label_code": "format.images", "label_params": {} },
    { "id": "epub", "label": "EPUB (fixed layout)", "label_code": "format.epub", "label_params": {} }
  ],
  "readiness": {
    "final_possible": true,
    "draft_possible": true,
    "blockers": [],
    "continuity_errors": 0,
    "note": "Final means every page in the edition has a passing review on file. It does not certify the drawings.",
    "note_code": "note.final_edition",
    "note_params": {}
  },
  "next_edition": {
    "id": "ED_001_02",
    "pages": [
      {
        "page": "PG_001_001",
        "render": "PG_001_001_V02",
        "file": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png",
        "lettered_file": null,
        "image": {
          "path": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png",
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png?v=6vqmwyf59cn",
          "width": 600,
          "height": 900,
          "bytes": 8918,
          "mtime": "2026-11-27T03:25:34.487Z"
        }
      },
      {
        "page": "PG_001_002",
        "render": "PG_001_002_V03",
        "file": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png",
        "lettered_file": null,
        "image": {
          "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png",
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png?v=7kwmwyf5b6n",
          "width": 600,
          "height": 900,
          "bytes": 9824,
          "mtime": "2026-11-27T03:25:36.863Z"
        }
      },
      "... 1 more"
    ],
    "cover": {
      "render": "CV_001_V03",
      "file": "issues/ISS_001/cover/renders/CV_001_V03.png",
      "lettered_file": null,
      "image": {
        "path": "issues/ISS_001/cover/renders/CV_001_V03.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V03.png?v=6tsmwyf5fqh",
        "width": 600,
        "height": 900,
        "bytes": 8848,
        "mtime": "2026-11-27T03:25:42.761Z"
      }
    },
    "supersedes": "ED_001_01",
    "changes": [],
    "reuses": "ED_001_01"
  },
  "lettering": { "mode": "in_image", "pages": [] },
  "editions": [
    {
      "id": "ED_001_01",
      "path": "editions/ED_001_01/edition.yaml",
      "title": "The Night Ferry - Crossing",
      "label": "first edition",
      "status": "reviewed",
      "created_at": "2026-11-27",
      "supersedes": null,
      "changes": [],
      "cover": { "render": "CV_001_V03", "file": "issues/ISS_001/cover/renders/CV_001_V03.png", "lettered_file": null },
      "pages": 3,
      "exports": [
        {
          "format": "pdf",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf",
          "built_at": "2026-11-27T03:25:44Z",
          "exists": true,
          "bytes": 24459,
          "draft": false,
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf",
          "download_url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf?download=1",
          "browsable": false
        },
        {
          "format": "cbz",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz",
          "built_at": "2026-11-27T03:25:44Z",
          "exists": true,
          "bytes": 37725,
          "draft": false,
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz",
          "download_url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz?download=1",
          "browsable": false
        },
        {
          "format": "web",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html",
          "built_at": "2026-11-27T03:25:44Z",
          "exists": true,
          "bytes": 4254,
          "draft": false,
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html",
          "download_url": null,
          "browsable": true
        },
        "... 2 more"
      ]
    }
  ],
  "chat_key": "publish:ISS_001",
  "screen": {
    "key": "publish:ISS_001",
    "label": "Publish issue 1",
    "label_code": "screen_label.publish",
    "label_params": { "n": 1 },
    "route": "/p/the-night-ferry/publish"
  }
}
```
<!-- /example:publish -->

## Text files

### `GET /api/projects/:id/file`

`?path=<workspace-relative path>`. Answers `{ file }`, a text document. Only
YAML, Markdown and text files (`.yaml`, `.yml`, `.md`, `.txt`, `.fountain`)
can be read this way; anything else is 415 `not_text`.

<!-- example:file-get -->
```json
{
  "file": {
    "path": "story/series-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "series-plan",
    "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written by /series-plan. An issue is the publication unit: a chapter or a webtoon episode…",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "178-1a21b090af4",
    "mtime": "2026-11-27T03:25:07.188Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  }
}
```
<!-- /example:file-get -->

### `PUT /api/projects/:id/file`

Saves a text file, commits the change and logs it.

| Body field | Meaning |
|---|---|
| `path` | Workspace-relative path, required. |
| `text` | The new raw text. |
| `data` | For YAML, the parsed document to write in place of `text`. Comments inside the file are lost; the comment block at its top is kept. |
| `base_etag` | The `etag` the editor opened. When the file changed since, the answer is 409 `file_changed` with `details.etag`. |

Answer:

| Field | Meaning |
|---|---|
| `saved` | `false` when the text was identical to the file. |
| `file` | The file after the save, as a text document. |
| `findings` | Schema findings of the saved text. A file that breaks its schema is still saved: the findings tell the person what to fix. |
| `continuity` | For a file under `issues/`, the findings of `check-continuity.js` for that page or issue. |
| `commit` | Commit id, or `null` (no change, or no git). |
| `created` | `true` when the file did not exist. |

<!-- example:file-put -->
```json
{
  "saved": true,
  "file": {
    "path": "story/series-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "series-plan",
    "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written b…",
    "data": { "title": "Crossing", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "171-1a21b09121f",
    "mtime": "2026-11-27T03:25:09.023Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  },
  "findings": [],
  "continuity": [],
  "commit": "e39cc5ae3ee3dfe11cd4b7d60f242c28300bad30",
  "created": false
}
```
<!-- /example:file-put -->

YAML that does not parse is refused with 422 and nothing is written:

<!-- example:file-put-yaml-error -->
```json
{
  "error": {
    "code": "yaml_parse",
    "message": "The text is not valid YAML and was not saved. Detail: YAML parse error at line 1: unterminated double-quoted string",
    "params": { "detail": "YAML parse error at line 1: unterminated double-quoted string" },
    "details": { "line": 1 }
  }
}
```
<!-- /example:file-put-yaml-error -->

Findings returned for a file that parses and breaks its schema:

<!-- example:file-put-findings -->
```json
{
  "findings": [{ "path": "$.issues[0].id", "message": "\"ISS_1\" does not match pattern ^ISS_\\d{3}$" }],
  "saved": true
}
```
<!-- /example:file-put-findings -->

Other refusals: 409 `style_frozen` for `style/style-block.txt` once a look
master is approved; 400 `bad_path` for renders, exports, generation records
and hidden files, which the pipeline writes itself.

### `PUT /api/projects/:id/pages/:page/plan`

Saves the plan of a page from its plan review, including its lettering.
Body: `{ data, base_etag? }`, where `data` is the whole `page.yaml` as an
object (as `GET .../pages/:page` sends it in `page.data`, with the edits).
The chat's `page.lettering` action saves through the same code.

Before writing, the lettering is made consistent with
`rules/lettering/`:

- an element keeps its `id`; a new one (no id, or a duplicate) gets the next
  free `L01`..`L99`;
- `order` is renumbered as the reading order of the page: panel by panel,
  and in each panel in the order of the list;
- `caption`, `narration`, `sign` and `sfx` lose their `speaker`; a spoken
  element (`balloon`, `thought`, `whisper`, `shout`, `radio`) needs one, and
  a speaker with no row in that panel's cast gets an off-panel row copied
  from their nearest row on the page (`lettering.added_cast` lists them).

422 `lettering_invalid` when an element cannot be right: a kind that does
not exist, an empty text, a spoken element without a speaker, a speaker who
is in no panel of the page. `details.problems` lists each one. 409
`file_changed` when `base_etag` is stale. The word budgets and the ceiling of
balloons per panel are not refusals: they come back as warnings, and the
screen shows them before saving.

The answer:

| Field | Meaning |
|---|---|
| `saved`, `file`, `commit` | As for `PUT .../file`. The save is one step of the history. |
| `findings` | Schema findings of `page.yaml` after the save. |
| `continuity` | The continuity check of the issue, kept to this page. |
| `lettering.warnings` | `[{ panel, number, code, element, words, count, limit }]` with `code` `balloon_words`, `panel_words` or `panel_count`. A sound effect counts toward the words of its panel, and not as a balloon. |
| `lettering.changes` | Element by element: `{ change, id, panel, number, type, speaker, text, order, before? }` with `change` `added`, `removed`, `changed` or `moved`. |
| `lettering.added_cast` | `[{ panel, character }]`: voices from off panel that got a ledger row. |
| `lettering.limits` | The budgets used. |
| `redraw` | `null`, or `{ render, mode }` when the lettering changed on a page that is already drawn: `mode` is `draw` (in-image lettering: the page has to be drawn again, `pages.generate`) or `reletter` (overlay: `lettering.apply`). The plan editor offers that action. |

The tail is not stored. The rule derives it from the speaker (at the mouth,
or to the panel edge on the speaker's side when they are off panel); the
plan editor says it in words.

<!-- example:page-plan-put -->
```json
{
  "saved": true,
  "file": {
    "path": "issues/ISS_001/pages/PG_001_001/page.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "page",
    "text": "# Schema: schemas/page.schema.json\n\nid: PG_001_001\nissue: ISS_001\nnumber: 1\nscene: SC_001_01\npurpose: Mara cro…",
    "data": {
      "id": "PG_001_001",
      "issue": "ISS_001",
      "number": 1,
      "scene": "SC_001_01",
      "purpose": "Mara crosses the river alone at night.",
      "page_turn": "none",
      "layout": { "grid": "two tiers, 1 / 2", "tiers": "[2 items]", "reading_order": "[3 items]", "notes": "" },
      "panels": ["{…}", "{…}", "... 1 more"],
      "...": "7 more"
    },
    "parse_error": null,
    "findings": [],
    "etag": "ed1-1a21b096f27",
    "mtime": "2026-11-27T03:25:32.839Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/page.yaml"
  },
  "findings": [],
  "continuity": [],
  "lettering": {
    "warnings": [],
    "changes": [
      {
        "change": "added",
        "id": "L03",
        "panel": "PN_001_001_01",
        "number": 1,
        "type": "caption",
        "speaker": null,
        "text": "Later that night.",
        "order": 2
      }
    ],
    "added_cast": [],
    "limits": { "words_per_balloon": 25, "words_per_panel": 50, "per_panel": 4 }
  },
  "redraw": { "render": "PG_001_001_V01", "mode": "draw" },
  "commit": "4cef306bccb82037df653038596f0c738b7ac5ce"
}
```
<!-- /example:page-plan-put -->

### `POST /api/projects/:id/pages/:page/mode`

How a page is drawn. Body `{ "mode": "per_panel" | "full_page" }`. `per_panel`
is for a page whose cast needs more reference images than the drawing tool
takes: each panel is drawn as its own image carrying only its own cast. The
mode is written to `generation.mode` in `page.yaml` and the reference plan
is rebuilt for it in the same step, as one commit, so the next drawing never
meets a plan built for the other mode. Answers `{ page, mode,
reference_plan, commit }`; `reference_plan` is `{ file, mode, budget }`, or
`{ error }` when the plan cannot be built in that mode either. Who is in a
panel never changes here. The conversation does the same with the action
`page.mode`.

<!-- example:page-mode -->
```json
{
  "page": "PG_001_002",
  "mode": "per_panel",
  "reference_plan": { "file": "issues/ISS_001/pages/PG_001_002/reference-plan.yaml", "mode": "per_panel", "budget": 5 },
  "commit": "a9de55f9bffedf769656ff14fbbd37d626d50723"
}
```
<!-- /example:page-mode -->

## Raw files

### `GET /api/projects/:id/raw/*path`

Any file of the workspace, by its workspace-relative path:
`/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png`.
Use the `url` fields of the other responses instead of building these.

- `Range: bytes=...` is honoured (one range), with `206` and `Content-Range`.
- `ETag` and `Last-Modified` are sent, and `If-None-Match` gets a `304`.
- `?download=1` adds `Content-Disposition: attachment`.
- Every file is sent with `X-Content-Type-Options: nosniff` and
  `Cross-Origin-Resource-Policy: same-origin`, with the one exception below.
- An HTML or SVG file is served with `Content-Security-Policy: sandbox
  allow-scripts`. It runs with an opaque origin: it can show itself, and a
  request it makes to the API is a cross-site request, which cannot change
  anything.
- The web reader of an edition (`editions/<edition>/exports/<name>-web/`)
  works both in an `iframe` of the app and in a tab of its own. Its
  `index.html` is sandboxed like any other HTML file, and its page images
  (`png`, `jpg`, `webp`, `gif` under that folder) are sent with
  `Cross-Origin-Resource-Policy: cross-origin`, because the sandboxed reader
  asks for them from an opaque origin and a browser would drop them
  otherwise. Only those images get the wider policy: they are copies of
  pages made to be published. They can be shown by another origin and
  cannot be read by its scripts.
- Hidden files and paths outside the workspace are not served.

A file as it was at an earlier point of the history is served by
[`GET /api/projects/:id/at/:commit/raw/*path`](#get-apiprojectsidatcommitrawpath).

## Uploads

Uploads are staged in `.studio/uploads/`. An operation that takes `uploads`
copies them into the workspace.

### `POST /api/projects/:id/uploads`

`?name=<file name>`, with the file bytes as the body (any `Content-Type`).
The name decides the kind: images (`.png`, `.jpg`, `.jpeg`, `.webp`, at most
25 MB, and the bytes have to be an image of that type) and text sources
(`.txt`, `.md`, `.fountain`, at most 2 MB). Anything else is 415. Answers 201.

```js
await fetch(`/api/projects/${id}/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
```

<!-- example:upload -->
```json
{
  "upload": {
    "id": "up_202611270325090150a_53f0",
    "name": "style-reference.png",
    "kind": "image",
    "bytes": 1345,
    "width": 200,
    "height": 300,
    "at": "2026-11-27T03:25:09Z",
    "url": "/api/projects/the-night-ferry/uploads/up_202611270325090150a_53f0"
  }
}
```
<!-- /example:upload -->

### `GET /api/projects/:id/uploads`

The staged uploads, newest first.

<!-- example:uploads -->
```json
{
  "uploads": [
    {
      "id": "up_202611270325090150a_53f0",
      "name": "style-reference.png",
      "kind": "image",
      "bytes": 1345,
      "width": 200,
      "height": 300,
      "at": "2026-11-27T03:25:09Z",
      "url": "/api/projects/the-night-ferry/uploads/up_202611270325090150a_53f0"
    }
  ]
}
```
<!-- /example:uploads -->

### `GET /api/projects/:id/uploads/:upload`

The bytes of one upload (for a preview).

### `DELETE /api/projects/:id/uploads/:upload`

Removes a staged upload. Answers `{ "deleted": "<upload id>" }`. Copies
already made into the workspace stay. 409 `delete_refused` while a queued or
running job reads it. Uploads are outside the history, so this cannot be
undone. `POST .../delete` does the same for several at once.

## Operations and jobs

Everything that calls the AI or draws is an operation, and an operation runs
as a job. A project runs one job at a time; the others wait in order.

### `POST /api/projects/:id/ops`

Body: `{ "op": "<name>", "params": { ... } }`. The parameters are checked
before the job is created, so a 400 or a 409 comes back at once and no job
exists. Answers 202 with the queued job, whose `steps` are already listed.
Chat messages do not go through this route (see [Conversation](#conversation)).

<!-- example:op-start -->
```json
{
  "job": {
    "id": "job_202611270325124490h_007d",
    "project": "the-night-ferry",
    "op": "style.look",
    "title": "Draw a look page",
    "title_code": "op.style.look.title",
    "title_params": {},
    "params": {},
    "status": "queued",
    "created_at": "2026-11-27T03:25:12Z",
    "started_at": null,
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "compile",
        "label": "Prepare the look page",
        "label_code": "step.style.look.compile",
        "label_params": {},
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "draw",
        "label": "Draw the look page",
        "label_code": "step.style.look.draw",
        "label_params": {},
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      }
    ],
    "questions": [],
    "answers": {},
    "result": null,
    "error": null,
    "tools": {},
    "commits": [],
    "position": 1,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:op-start -->

A refusal that the interface should explain, here drawing pages whose plans
are not approved:

<!-- example:error-plan-not-approved -->
```json
{
  "error": {
    "code": "plan_not_approved",
    "message": "The plan of PG_001_001, PG_001_002, PG_001_003 is not approved, or changed after it was approved.",
    "params": {
      "detail": "The plan of PG_001_001, PG_001_002, PG_001_003 is not approved, or changed after it was. Approve it (POST /approve/plan) or send \"approve_plans\": true…",
      "pages": ["PG_001_001", "PG_001_002", "... 1 more"]
    },
    "details": { "pages": ["PG_001_001", "PG_001_002", "... 1 more"] }
  }
}
```
<!-- /example:error-plan-not-approved -->

### The job object

| Field | Meaning |
|---|---|
| `id` | Sortable by creation time. |
| `op`, `title`, `params` | The operation, its title for the person (with `title_code` and `title_params`), and the checked parameters. |
| `status` | `queued`, `running`, `needs_decision`, `paused`, `done`, `failed` or `cancelled`. `paused`: a tool ran out of its usage quota; see [When a tool runs out of quota](#when-a-tool-runs-out-of-quota). |
| `position` | Place in the queue while `queued` (1 is next), else `null`. |
| `created_at`, `started_at`, `ended_at` | ISO 8601. `ended_at` stays `null` while the job waits for an answer or is paused. |
| `current_step` | Id of the running step, or `null`. |
| `steps` | In order: `{ id, label, status, started_at, ended_at, tool, commit, files, note, changed }`. More steps can appear while the job runs (a repair, for example). `id` is stable; `label` and `note` are sentences in the language of the request, each with its `_code` and `_params`. |
| `steps[].status` | `pending`, `running`, `done`, `failed`, `cancelled`, `waiting` (paused for an answer), `paused` (the step met a tool's usage limit) or `skipped`. |
| `steps[].tool` | `claude`, `codex` or `person` for a step one of them did, else `null`. |
| `steps[].commit`, `files`, `changed` | The commit of what the step wrote, how many files, and their paths. |
| `steps[].note` | A short result or the reason for a failure or a skip. |
| `questions` | While `needs_decision`: `[{ id, question, options }]`. |
| `answers` | Answers given so far: `{ <question id>: { question, answer } }`. |
| `result` | The operation's result once `done` (see the operations reference). A sentence the studio wrote into a result (`reason`, `stopped`, `path_label`) has its `_code` and `_params`; `summary` and `decisions` are the tool's own words. |
| `error` | `{ code, message, message_code, message_params, details? }` once `failed`, or while `paused` (code `tool_quota`, with `details: { tool, resets, said }`). `message_params.detail` is the technical text in English. |
| `paused` | While `paused`: `{ reason: "tool_quota", tool, resets, by, at }`. `tool` is `codex` or `claude`; `resets` is when the tool said the limit resets, in its words, or `null`; `by` is `null` for the job that met the limit and that job's id for a job that paused, without starting, behind it. Else `null`. |
| `tools` | Which tool did each verb in this job: `{ plan?, look?, draw? }`. |
| `commits` | Every commit the job made. |
| `cost_usd` | Sum of the costs Claude Code reported, or `null`. Codex reports none. |
| `read_only` | `true` for a chat turn that ran in the read-only lane, beside another job, and could change no file. |
| `origin` | What started the job when it was not a screen: `{ conversation, card, message }` for an action card of the conversation, else `null`. |
| `story_proposals` | When a run of the job changed the story bible directly: the change was undone, and what it wanted to add waits as a proposal, `[{ id, parts }]`. Else `null`. |
| `added_entities` | The character, place and prop files a step of the job created: `[{ id, kind, name, path, step, duplicates }]`, where `kind` is `character`, `location` or `prop` and `duplicates` lists the known entities it may be the same as, `[{ id, name, source, has_file, proposal, score }]` (`source`: `file`, `bible` or `proposal`). Else `null`. See [What a step added](#what-a-step-added). |

<!-- example:job -->
```json
{
  "job": {
    "id": "job_2026112703252323612_1dc2",
    "project": "the-night-ferry",
    "op": "pages.generate",
    "title": "Draw pages",
    "title_code": "op.pages.generate.title",
    "title_params": {},
    "params": { "pages": ["PG_001_001", "... 2 more"], "approve_plans": false, "regenerate": false },
    "status": "done",
    "created_at": "2026-11-27T03:25:23Z",
    "started_at": "2026-11-27T03:25:23Z",
    "ended_at": "2026-11-27T03:25:32Z",
    "current_step": null,
    "steps": [
      {
        "id": "PG_001_001:prepare",
        "label": "Page 1: references and instruction",
        "label_code": "step.page.prepare",
        "label_params": { "n": 1 },
        "status": "done",
        "started_at": "2026-11-27T03:25:23Z",
        "ended_at": "2026-11-27T03:25:24Z",
        "tool": null,
        "commit": "59e3dac3cf49db54a25ef954558ab99c84eea106",
        "files": 3,
        "note": "2 reference images",
        "note_code": "note.references",
        "note_params": { "n": 2 },
        "changed": [
          "issues/ISS_001/pages/PG_001_001/page.yaml",
          "issues/ISS_001/pages/PG_001_001/prompts/codex-cli.yaml",
          "issues/ISS_001/pages/PG_001_001/reference-plan.yaml"
        ]
      },
      {
        "id": "PG_001_001:draw",
        "label": "Page 1: draw",
        "label_code": "step.page.draw",
        "label_params": { "n": 1 },
        "status": "done",
        "started_at": "2026-11-27T03:25:24Z",
        "ended_at": "2026-11-27T03:25:25Z",
        "tool": "codex",
        "commit": "e5ad61c377148c7294c475e54e69deb6b70510fe",
        "files": 4,
        "note": "PG_001_001_V01",
        "changed": [
          "generations/PG_001_001/GEN_PG_001_001_01.request.json",
          "generations/PG_001_001/GEN_PG_001_001_01.yaml",
          "issues/ISS_001/pages/PG_001_001/page.yaml",
          "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png"
        ]
      },
      {
        "id": "PG_001_001:review",
        "label": "Page 1: check",
        "label_code": "step.page.review",
        "label_params": { "n": 1 },
        "status": "done",
        "started_at": "2026-11-27T03:25:25Z",
        "ended_at": "2026-11-27T03:25:26Z",
        "tool": "claude",
        "commit": "b9178e4f13acf4dd659f503e2ce6a4bc6b8c7ced",
        "files": 2,
        "note": null,
        "changed": [
          "issues/ISS_001/pages/PG_001_001/page.yaml",
          "issues/ISS_001/pages/PG_001_001/reviews/PG_001_001_V01.review.yaml"
        ]
      },
      {
        "id": "PG_001_002:prepare",
        "label": "Page 2: references and instruction",
        "label_code": "step.page.prepare",
        "label_params": { "n": 2 },
        "status": "done",
        "started_at": "2026-11-27T03:25:26Z",
        "ended_at": "2026-11-27T03:25:27Z",
        "tool": null,
        "commit": "94d801760a5244310a90e8ad9361ca216ef8aa45",
        "files": 3,
        "note": "3 reference images",
        "note_code": "note.references",
        "note_params": { "n": 3 },
        "changed": [
          "issues/ISS_001/pages/PG_001_002/page.yaml",
          "issues/ISS_001/pages/PG_001_002/prompts/codex-cli.yaml",
          "issues/ISS_001/pages/PG_001_002/reference-plan.yaml"
        ]
      },
      "... 7 more"
    ],
    "questions": [],
    "answers": {},
    "result": {
      "pages": [
        {
          "page": "PG_001_001",
          "render": "PG_001_001_V01",
          "verdict": "pass",
          "outcome": "pass",
          "passes": true,
          "open_findings": 0,
          "repairs": 0,
          "flagged": false,
          "independent": true,
          "stopped": null
        },
        "... 2 more"
      ],
      "passed": 3,
      "with_notes": 1,
      "flagged": 0,
      "failed": 0,
      "to_assemble": [],
      "tools": { "draw": "codex", "look": "claude" }
    },
    "error": null,
    "tools": { "draw": "codex", "look": "claude" },
    "commits": [
      "59e3dac3cf49db54a25ef954558ab99c84eea106",
      "e5ad61c377148c7294c475e54e69deb6b70510fe",
      "b9178e4f13acf4dd659f503e2ce6a4bc6b8c7ced",
      "94d801760a5244310a90e8ad9361ca216ef8aa45",
      "... 7 more"
    ],
    "position": null,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:job -->

### What a step added

After every step that wrote files, the studio looks for the character,
place and prop files it created and lists them on the job
(`added_entities`). Each one is compared with what the project already
knows: the entity files, the characters of the story bible, and the
characters of story proposals still open. The comparison is a word match in
any language the files use: the words of the new one's name and aliases are
looked for in what is written about the known one (its name, aliases and
description, or the arc a proposal gives it), and the other way round, and
the words of the two IDs count too. Generic words (man, woman, hombre, the,
del) and words a description denies ("no beard", "sin barba") do not count.
A close match is listed in `duplicates`, and the log says so. It is a
question for the person: the Pages screen and the chat offer to merge it
(`POST .../entities/merge`) or give it another ID. Nothing is changed by the
check itself.

The prompts of the steps that may create an entity (story proposals, the
character file, places and objects, the page breakdown and plan, the fix
pass, the cover text, the chat) list the IDs that already exist, with the
same three sources, and ask the model to reuse an ID for the same person,
place or object.

### `GET /api/projects/:id/jobs`

Newest first. `?limit=` (default 50, at most 500) and `?active=1` (only
queued, running and waiting jobs). `running` is the job that runs now, or
`null`.

<!-- example:jobs -->
```json
{
  "jobs": [
    {
      "id": "job_2026112703252323612_1dc2",
      "project": "the-night-ferry",
      "op": "pages.generate",
      "title": "Draw pages",
      "title_code": "op.pages.generate.title",
      "title_params": {},
      "params": { "pages": ["PG_001_001", "... 2 more"], "approve_plans": false, "regenerate": false },
      "status": "done",
      "created_at": "2026-11-27T03:25:23Z",
      "started_at": "2026-11-27T03:25:23Z",
      "ended_at": "2026-11-27T03:25:32Z",
      "current_step": null,
      "steps": [
        {
          "id": "PG_001_001:prepare",
          "label": "Page 1: references and instruction",
          "label_code": "step.page.prepare",
          "label_params": { "n": 1 },
          "status": "done",
          "started_at": "2026-11-27T03:25:23Z",
          "ended_at": "2026-11-27T03:25:24Z",
          "tool": null,
          "commit": "59e3dac3cf49db54a25ef954558ab99c84eea106",
          "files": 3,
          "note": "2 reference images",
          "note_code": "note.references",
          "note_params": { "n": 2 },
          "changed": ["issues/ISS_001/pages/PG_001_001/page.yaml", "... 2 more"]
        },
        "... 10 more"
      ],
      "questions": [],
      "answers": {},
      "result": {
        "pages": [
          {
            "page": "PG_001_001",
            "render": "PG_001_001_V01",
            "verdict": "pass",
            "outcome": "pass",
            "passes": true,
            "open_findings": 0,
            "repairs": 0,
            "flagged": false,
            "independent": true,
            "stopped": null
          },
          "... 2 more"
        ],
        "passed": 3,
        "with_notes": 1,
        "flagged": 0,
        "failed": 0,
        "to_assemble": [],
        "tools": { "draw": "codex", "look": "claude" }
      },
      "error": null,
      "tools": { "draw": "codex", "look": "claude" },
      "commits": ["59e3dac3cf49db54a25ef954558ab99c84eea106", "... 10 more"],
      "position": null,
      "cost_usd": null,
      "read_only": false,
      "origin": null,
      "story_proposals": null,
      "added_entities": null,
      "paused": null
    },
    "... 1 more"
  ],
  "running": null
}
```
<!-- /example:jobs -->

### `GET /api/projects/:id/jobs/:job`

`{ job }`. With `?log=<n>` the answer also carries `log`, the last `n` lines
of the job's log.

### `GET /api/projects/:id/jobs/:job/log`

The log of a job as lines of `<time> <step> <text>`. `?tail=<n>` keeps the
last `n`. Live lines arrive as `log` events.

<!-- example:job-log -->
```json
{
  "job": "job_2026112703252323612_1dc2",
  "lines": [
    "2026-11-27T03:25:32Z PG_001_003:review Page 3: check",
    "2026-11-27T03:25:32Z PG_001_003:review Claude Code started (sonnet)",
    "2026-11-27T03:25:32Z PG_001_003:review reading commands for review",
    "2026-11-27T03:25:32Z PG_001_003:review Claude Code finished in 1 s: The image matches the plan.",
    "2026-11-27T03:25:32Z PG_001_003:review review of PG_001_003_V01: fixed, 1 open finding(s), 0 blocking",
    "2026-11-27T03:25:32Z - Draw pages finished"
  ]
}
```
<!-- /example:job-log -->

### `POST /api/projects/:id/jobs/:job/cancel`

Cancels a queued or waiting job at once. For a running job it stops the tool
(the whole process tree of the CLI) and the job ends as `cancelled` shortly
after; files written before the cancel stay and are committed. 409
`job_finished` for a job that already ended.

<!-- example:job-cancel -->
```json
{
  "job": {
    "id": "job_202611270325386681v_8676",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "title_code": "op.story.update.title",
    "title_params": {},
    "params": { "instruction": "SLOW change that will be cancelled.", "source_upload": null },
    "status": "cancelled",
    "created_at": "2026-11-27T03:25:38Z",
    "started_at": "2026-11-27T03:25:38Z",
    "ended_at": "2026-11-27T03:25:38Z",
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "label_code": "step.story.update.update",
        "label_params": {},
        "status": "cancelled",
        "started_at": "2026-11-27T03:25:38Z",
        "ended_at": "2026-11-27T03:25:38Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
        "label_code": "step.check.files",
        "label_params": {},
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      }
    ],
    "questions": [],
    "answers": {},
    "result": null,
    "error": null,
    "tools": { "plan": "claude" },
    "commits": [],
    "position": null,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:job-cancel -->

### When a tool runs out of quota

A tool that answers that its usage quota or rate limit is reached is not a
failed drawing. The scaffold's providers recognise the answer
(`providers/lib/quota.js`) and record it on the generation record as
`response.error_kind: "tool_quota"` with `response.resets`. Codex said
so in a real run as "Image generation failed because the usage limit was
reached" in its final message, after `item.completed: error` events, and
exited 0. Claude Code prints "Usage limit reached", "You've hit your
limit" or "Claude AI usage limit reached|<time>"; any answer with "usage
limit", "rate limit" or "quota" counts. The reset time shown is the one in
the tool's own answer. Codex keeps `rate_limits` for its text quota in its
session files; nothing there is about images, so the studio does not read
it.

The job that meets it stops at once and pauses where it stopped
(`status: "paused"`, `error.code: "tool_quota"`). The step that met it is
`paused`; the pages after it are not tried. The jobs queued behind it that
need the same tool pause without starting (their `paused.by` names the job
that met it); the others run. A paused job counts as active. Nothing is
counted against the repair or touch-up limits: no image was drawn, so no
review was written. The activity entry of the step says "paused, out of
quota". When the job came from a card, the conversation gets an
`action_result` message with `status: "paused"` and `quota` (see
[Actions of the conversation](#actions-of-the-conversation)).

<!-- example:job-paused -->
```json
{
  "job": {
    "id": "job_202611270326165935x_7a6a",
    "op": "pages.generate",
    "status": "paused",
    "paused": { "reason": "tool_quota", "tool": "codex", "resets": "6:40 PM", "by": null, "at": "2026-11-27T03:26:18Z" },
    "error": {
      "code": "tool_quota",
      "message": "Codex ran out of its usage quota and says the limit resets: 6:40 PM. Nothing is wrong with the work: it waits where it stopped and goes on when you re…",
      "message_code": "error.tool_quota.reset",
      "message_params": {
        "detail": "Codex ran out of its usage quota and says the limit resets: 6:40 PM. Nothing is wrong with the work: it waits where it stopped and goes on when you re…",
        "tool": "Codex",
        "resets": "6:40 PM"
      },
      "details": {
        "tool": "codex",
        "resets": "6:40 PM",
        "said": "Codex ran out of its usage quota and saved no image: Image generation failed because the usage limit was reached. (resets 6:40 PM)"
      }
    },
    "steps": [
      { "id": "PG_001_002:prepare", "status": "done", "note": "3 reference images" },
      {
        "id": "PG_001_002:draw",
        "status": "paused",
        "note": "Codex ran out of its usage quota and says the limit resets: 6:40 PM. Nothing is wrong with the work: it waits where it stopped and goes on when you re…"
      }
    ]
  }
}
```
<!-- /example:job-paused -->

### `POST /api/projects/:id/jobs/:job/resume`

For a job with status `paused`. Body `{}`. The job goes back to the front of
the queue where it stopped, followed by the jobs that paused behind it (or
for the same tool), in the order they were created. Steps that finished do
not run again: a page already drawn is not drawn twice, and a change request
already recorded is not recorded again. Answers `{ job, resumed }`, the job
and every job resumed with it. 409 `job_not_paused` for any other status. A
paused job can also be cancelled. If the quota is still out, the job pauses
again.

<!-- example:job-resume -->
```json
{
  "job": { "id": "job_202611270326165935x_7a6a", "status": "queued", "paused": null },
  "resumed": [{ "id": "job_202611270326165935x_7a6a", "op": "pages.generate", "status": "queued" }]
}
```
<!-- /example:job-resume -->

### `POST /api/projects/:id/jobs/:job/answer`

For a job with status `needs_decision`. Body:
`{ "answers": { "<question id>": "<answer>" } }`, one answer per question
(400 `bad_answers` with `details.missing` otherwise). The job goes back to
the front of the queue. Steps that finished do not run again; the step that
asked runs again with the answers in its prompt.

A job waiting for a decision:

<!-- example:job-needs-decision -->
```json
{
  "job": {
    "id": "job_202611270325381391t_c754",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "title_code": "op.story.update.title",
    "title_params": {},
    "params": { "instruction": "DECIDE whether the patrol knows the boy by name.", "source_upload": null },
    "status": "needs_decision",
    "created_at": "2026-11-27T03:25:38Z",
    "started_at": "2026-11-27T03:25:38Z",
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "label_code": "step.story.update.update",
        "label_params": {},
        "status": "waiting",
        "started_at": "2026-11-27T03:25:38Z",
        "ended_at": "2026-11-27T03:25:38Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
        "label_code": "step.check.files",
        "label_params": {},
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      }
    ],
    "questions": [
      {
        "id": "q1",
        "question": "The text says DECIDE. Which way should this go?",
        "options": ["The first way", "The second way"]
      }
    ],
    "answers": {},
    "result": null,
    "error": null,
    "tools": { "plan": "claude" },
    "commits": [],
    "position": null,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:job-needs-decision -->

The answer to `POST .../answer`:

<!-- example:job-answer -->
```json
{
  "job": {
    "id": "job_202611270325381391t_c754",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "title_code": "op.story.update.title",
    "title_params": {},
    "params": { "instruction": "DECIDE whether the patrol knows the boy by name.", "source_upload": null },
    "status": "queued",
    "created_at": "2026-11-27T03:25:38Z",
    "started_at": "2026-11-27T03:25:38Z",
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "label_code": "step.story.update.update",
        "label_params": {},
        "status": "pending",
        "started_at": "2026-11-27T03:25:38Z",
        "ended_at": "2026-11-27T03:25:38Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
        "label_code": "step.check.files",
        "label_params": {},
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      }
    ],
    "questions": [],
    "answers": { "q1": { "question": "The text says DECIDE. Which way should this go?", "answer": "The second way" } },
    "result": null,
    "error": null,
    "tools": { "plan": "claude" },
    "commits": [],
    "position": 1,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:job-answer -->

### After a restart

A job that was running or queued when the server stopped is marked `failed`
with `error.code` `interrupted` when the server starts again. A job that was
waiting for an answer keeps waiting.

## Events

### `GET /api/projects/:id/events`

A Server-Sent Events stream for one project (`text/event-stream`). Use
`EventSource`. Every event has an `id`, a type and a JSON object as data.
The text in the data is in the language of the stream: `?lang=` when the
stream was opened with one, else the interface language of the project at
the time of the event. Codes and params come with it as in any response.

| Event | When | Data |
|---|---|---|
| `hello` | Once, on connect. | `{ project, at, jobs }`: the active jobs, so a reload in the middle of a job picks it up. |
| `job` | Every change of a job: queued, a step starts or ends, a step is added, the job ends or pauses. | `{ job }`, the full job object. |
| `log` | A progress line of the running job. | `{ job, step, at, line }`. Tool use arrives as short lines such as `reading docs/data-model.md` or `writing story/story-bible.yaml`. |
| `activity` | A history entry was added. | `{ entry }`, as in [History](#history) (image paths, not image objects). |
| `files` | Files of the workspace changed. | `{ paths, job, commit }`. `job` is `null` for a save or an approval by the person. Reload the screens that show those paths. |
| `chat` | A message was added to the project conversation, or an action card changed. | `{ conversation, key, message }`: the conversation id, the screen key the message belongs to, and the message (see [Conversation](#conversation)). A changed card comes as `{ conversation, card }` instead. |
| `heartbeat` | Every 15 seconds. | `{ at }`. |

<!-- example:event-hello -->
```json
{ "project": "the-night-ferry", "at": "2026-11-27T03:25:07Z", "jobs": [] }
```
<!-- /example:event-hello -->

<!-- example:event-job -->
```json
{
  "job": {
    "id": "job_2026112703252323612_1dc2",
    "project": "the-night-ferry",
    "op": "pages.generate",
    "title": "Draw pages",
    "title_code": "op.pages.generate.title",
    "title_params": {},
    "params": { "pages": ["PG_001_001", "PG_001_002", "PG_001_003"], "approve_plans": false, "regenerate": false },
    "status": "running",
    "created_at": "2026-11-27T03:25:23Z",
    "started_at": "2026-11-27T03:25:23Z",
    "ended_at": null,
    "current_step": "PG_001_001:prepare",
    "steps": [
      {
        "id": "PG_001_001:prepare",
        "label": "Page 1: references and instruction",
        "label_code": "step.page.prepare",
        "label_params": { "n": 1 },
        "status": "running",
        "started_at": "2026-11-27T03:25:23Z",
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "PG_001_001:draw",
        "label": "Page 1: draw",
        "label_code": "step.page.draw",
        "label_params": { "n": 1 },
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "PG_001_001:review",
        "label": "Page 1: check",
        "label_code": "step.page.review",
        "label_params": { "n": 1 },
        "status": "pending",
        "started_at": null,
        "ended_at": null,
        "tool": null,
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      "... 6 more"
    ],
    "questions": [],
    "answers": {},
    "result": null,
    "error": null,
    "tools": {},
    "commits": [],
    "position": null,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:event-job -->

<!-- example:event-log -->
```json
{
  "job": "job_202611270325108180e_e3f7",
  "step": "bible",
  "at": "2026-11-27T03:25:11Z",
  "line": "writing style/style-block.txt"
}
```
<!-- /example:event-log -->

<!-- example:event-activity -->
```json
{
  "entry": {
    "id": "act_2026112703252548614_87f2",
    "at": "2026-11-27T03:25:25Z",
    "kind": "step",
    "title": "Draw pages: Page 1: draw",
    "title_code": "activity.step",
    "title_params": { "title": "Draw pages", "label": "Page 1: draw" },
    "actor": "codex",
    "job": "job_2026112703252323612_1dc2",
    "op": "pages.generate",
    "step": "PG_001_001:draw",
    "files": [
      { "path": "generations/PG_001_001/GEN_PG_001_001_01.request.json", "change": "added" },
      { "path": "generations/PG_001_001/GEN_PG_001_001_01.yaml", "change": "added" },
      "... 2 more"
    ],
    "images": ["issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png"],
    "commit": "e5ad61c377148c7294c475e54e69deb6b70510fe"
  }
}
```
<!-- /example:event-activity -->

<!-- example:event-files -->
```json
{
  "paths": [
    "issues/ISS_001/pages/PG_001_001/page.yaml",
    "issues/ISS_001/pages/PG_001_001/prompts/codex-cli.yaml",
    "... 1 more"
  ],
  "job": "job_2026112703252323612_1dc2",
  "commit": "59e3dac3cf49db54a25ef954558ab99c84eea106"
}
```
<!-- /example:event-files -->

<!-- example:event-chat -->
```json
{
  "conversation": "conv_202611270325486752o_ae11",
  "key": "page:PG_001_003",
  "message": {
    "id": "msg_202611270325492132s_eeb3",
    "at": "2026-11-27T03:25:49Z",
    "conversation": "conv_202611270325486752o_ae11",
    "role": "assistant",
    "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
    "job": "job_202611270325486812q_147a",
    "tool": "claude",
    "reply_to": "msg_202611270325486782p_d134",
    "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
    "key": "page:PG_001_003",
    "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
    "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
    "decisions": [],
    "links": [],
    "proposal": null,
    "reverted": [],
    "story_proposal": null,
    "actions": [],
    "dropped": [],
    "read_only": false
  }
}
```
<!-- /example:event-chat -->

<!-- example:event-heartbeat -->
```json
{ "at": "2026-11-27T03:25:07.958Z" }
```
<!-- /example:event-heartbeat -->

## Conversation

One conversation per project, open on every screen. It keeps its messages
when the person moves between screens, and every message carries the screen
it was sent from: `screen: { key, label, route }`. The AI is given the files
of that screen, so "change this" means the thing in front of the person, and
it may change them. Show the screen with each message ("from Style", "from
Page 2"). A turn runs as a job (`chat.turn`) and can be cancelled like one.
When the queue is idle it runs as any job and may change files. When
another job is running it does not wait: it runs at once in a read-only
lane of the queue, answers and proposes, and changes no file (the job has
`read_only: true`, and so does the reply). Two turns never run side by side.

Every prompt carries a short state of the project, read from the workspace
at that moment: the options, the story and its open proposals, the style
and look, each character and whether its sheet is approved, the places, each
issue with its pages (plan approved, drawn, passing, approved), its cover
and editions, the jobs running and the last ones finished (from the screens
or from the conversation), the questions waiting for an answer, the cards
waiting for the person and the uploaded files. So the conversation knows
what was done on the screens, and the screens show what the conversation
did, because both write the same workspace.

A message can carry attachments: images and text files sent through the
[upload store](#uploads) first. The prompt lists each one with its absolute
path and its upload id; images also go to the tool (Codex takes them with
`-i`; Claude Code opens them with its Read tool, since the uploads live
inside the project directory it is given with `--add-dir`).

A reply can propose actions, which become cards the person runs or
dismisses: see [Actions of the conversation](#actions-of-the-conversation).

### Guide mode

A conversation can lead the person from an empty project to a published
comic, one decision at a time. It is a flag of the conversation, turned on
and off with [`POST .../conversation/guide`](#post-apiprojectsidconversationguide)
or offered when a project is created (`"guide": true`). Leaving it keeps
everything; a fresh conversation keeps the mode on.

Where the project stands comes from the same step state as the side
navigation (`next` and `screens` of [`GET /api/projects/:id`](#get-apiprojectsid)),
narrowed to the one decision of now (`studio/server/guide.js`): the story in
the person's words, a style from the gallery, the look page, its approval,
the characters and their sheets, the page plans, their approval, the drawing,
each page, the cover, publishing. A job waiting for an answer or paused for
a tool's quota comes first, and while a job runs the step is `waiting`.

The guide speaks on its own, from the server's templates and with no AI
call: when the mode is turned on, when a card it started is under way (what
is happening, how long it usually takes, what comes after), and when a job
or a decision settles, from a card, a chat reply or a screen (the result,
then the next question). The person never has to send "next". A guide
message is an assistant message with `guide`:

| Field | Meaning |
|---|---|
| `guide.key` | The step: `story.tell`, `style.choose`, `style.look`, `style.approve`, `characters.add`, `characters.approve`, `characters.sheet`, `pages.plan`, `pages.approve_plan`, `pages.draw`, `pages.review`, `cover`, `cover.approve`, `publish`, `done`, `answer`, `paused`, `waiting` or `screen`; `started` for a message about a card under way. |
| `guide.sig` | The step and its subject (the candidate, the pages). A choice is sent with it; a new message comes only when it changes. |
| `guide.lines` | What the message says, in order, each a sentence with its code: the result line, what the step is, why it comes now, a term explained the first time it is used (look page, sheet, plan, check, touch-up, edition), and last what the person decides. |
| `guide.title`, `why`, `decide` | The same parts on their own. |
| `guide.choices` | `[{ id, label, draws, images, preset }]`: what can be clicked. Drawing choices say how many images they draw. |
| `guide.presets` | For `style.choose`: the style gallery, `[{ key, name, intent, preview }]`, each with its sample page. |
| `guide.images` | What to look at before deciding (the look page, a sheet, a page, the cover), as [image objects](#image-objects) with `path` and `label`. |
| `guide.expects` | What an answer in words usually becomes: `{ action, param, params? }`. |
| `guide.terms_explained` | The terms this message explained. |

In guide mode the chat prompt carries the step in English and the guide's
rules: answer a question first and come back to the step as it stands,
one decision at a time, explain a term once, the story and the approvals
are the person's, every action through a card (an answer to the step is an
explicit request and runs at once), and every reply ends with the next step.

Conversations live in `.studio/conversations/` of the project: `index.json`
and one `<conversation id>.jsonl` per conversation. The person can start a
fresh one at any time; the earlier ones stay readable.

Screen keys, and the files the AI gets for each:

| Key | Files in context |
|---|---|
| `story` | The story bible, the series plan, the source files. |
| `style` | The style bible, the style block, the colour script, `project.yaml`. |
| `options` | `project.yaml`. |
| `characters` | Every character and wardrobe file. |
| `character:<CHAR_ID>` | That character's file and wardrobe. |
| `places` | Every location, map and prop file. |
| `location:<LOC_ID>`, `prop:<PROP_ID>` | That entity's files. |
| `pages:<ISS_ID>` | The issue file, the series plan, its scenes and its page files. An issue of the series plan with no directory yet is a screen too. |
| `page:<PAGE_ID>` | The page file, its lettering geometry, the review of its current render, its scene. |
| `cover:<ISS_ID>` | The cover file, the issue file, the story bible. |
| `publish:<ISS_ID>` | The issue file and the latest edition. |

A malformed key is 400 `bad_chat_key`; a key that names something missing is
404 `chat_target_not_found`. `label` and `route` are optional in a message:
the server fills in its own when they are missing. Links in replies may also
point at `home`, `check`, `corrections`, `history` and `settings`, screens
with no files of their own, which cannot send a message.

The routes of the browser app the server uses for `route` (the ones
`studio/web/` has today):

| Key | Route |
|---|---|
| `home` | `/p/:id` |
| `story`, `style`, `characters`, `places`, `check`, `corrections`, `history` | `/p/:id/<key>` |
| `options`, `settings` | `/p/:id/settings` |
| `character:<CHAR_ID>` | `/p/:id/characters/<CHAR_ID>` |
| `location:<LOC_ID>`, `prop:<PROP_ID>` | `/p/:id/places/location/<LOC_ID>`, `/p/:id/places/prop/<PROP_ID>` |
| `pages:<ISS_ID>`, `page:<PAGE_ID>` | `/p/:id/pages`, `/p/:id/pages/<PAGE_ID>` |
| `cover:<ISS_ID>`, `publish:<ISS_ID>` | `/p/:id/cover`, `/p/:id/publish` |

For an issue after the first, the Pages, Cover and Publish routes carry it as
`?issue=<ISS_ID>`, and the screens open on that issue.

Message fields:

| Field | Meaning |
|---|---|
| `id`, `at`, `conversation` | Message id, time, and the conversation it belongs to. |
| `role` | `user`, `assistant`, or `event` for something that happened in the conversation (below). |
| `screen`, `key` | The screen the message was sent from (an assistant message repeats the screen of the message it answers), and its key. |
| `text` | What was said. For an assistant message, the tool's own words; for an event, a sentence of the studio with `text_code` and `text_params`. |
| `job` | The `chat.turn` job, on assistant and event messages. |
| `tool`, `reply_to` | Which tool answered, and the id of the message it answers. |
| `files`, `commit` | The paths the reply changed and the commit of those changes, or `[]` and `null`. |
| `decisions` | What the tool decided on its own. |
| `links` | Screens the reply suggests going to: `[{ key, route, label, screen_label }]`. `label` is the tool's words, else the screen's name; `screen_label` is always the screen's name, with its code. Every link was checked against the real screens of the project; the ones that named no screen were dropped. A link only opens a screen. |
| `proposal` | When the person asked for story text: `{ id, parts }` of the [proposal](#story-proposals) the reply made, else `null`. The story bible itself is never written by a chat. |
| `reverted` | Files the reply wrote that the studio undid: `["story/story-bible.yaml"]` when a reply wrote the story bible directly. Usually empty. |
| `error` | When the turn failed: what went wrong, with an empty `text`. |
| `attachments` | On a person's message: the files sent with it, `[{ id, name, kind, bytes, width, height, url }]`. |
| `actions` | On a reply: the [action cards](#actions-of-the-conversation) it proposed, each in its current state. The transcript file keeps their ids. |
| `dropped` | On a reply: actions it proposed that did not check out, `[{ action, reason }]`, with the reason in the language of the request. The job log says the same. |
| `read_only` | On a reply: `true` when it was written beside another job and could change no file. |
| `story_proposal` | On a reply that wrote the story bible directly: `{ id, parts }` of the proposal made from what it wanted to add, else `null`. |
| `folded_from` | On a message brought in from the conversations per screen of earlier versions: the screen key it came from. |

Event messages (`role: "event"`) say what happened between turns:

| `event` | Meaning |
|---|---|
| `folded` | The conversations per screen of an earlier version were brought into this one (`keys` lists them). |
| `tool_changed` | Another tool answers from here on (`from_tool`, `tool`). It started a session of its own and was given a summary of the conversation so far. |
| `session_restarted` | The same tool could not continue its earlier session, so it started a new one with the summary. |
| `guide_off` | Guide mode was turned off. |
| `action_result` | A job started from a card ended, stopped to ask, or paused because a tool ran out of quota. Fields: `card`, `action`, `job`, `status` (`done`, `failed`, `cancelled`, `needs_decision`, `paused`), `quota` (while paused: `{ tool, tool_label, resets, pages, jobs, lines }`, the tool, when it said the limit resets, the pages not drawn yet, the jobs paused behind it, and the plain sentences to show, with a way to resume), `text` (a sentence of the studio), `summary` (the tool's own words), `error`, `images` (what it drew, as [image objects](#image-objects) with their `path`), `links` (the screens where the result is seen and approved), `proposals` (story proposals it left, `guard: true` on one made from a direct write to the story bible), `questions` (while it waits for an answer) and `reply_to`. |

How the conversation continues: while the same tool answers, each turn
resumes that tool's own session (`--resume <session id>` for Claude Code,
`codex exec resume <session id>` for Codex), so it remembers everything
said. When the plan tool changes in the settings, or falls back to the other
tool, the next turn starts a new session of the new tool and gives it a
summary of the last twelve messages, each with its screen, and the
transcript gets a `tool_changed` event. A fresh conversation starts with no
session and no summary.

The conversations per screen of earlier versions (`.studio/chats/`) are
folded into the first project conversation the first time it is read, in
time order, each message tagged with its screen. Their files stay where
they are.

### `GET /api/projects/:id/conversation`

The current conversation, oldest message first, and the list of
conversations. `conversation.session` is `{ tool }` of the session the next
turn resumes, or `null`; `pending` holds the ids of turns that have not
finished; `guide` is `{ on, step, terms }`, the [guide mode](#guide-mode)
of the conversation with the step the project is at when it is on.

<!-- example:conversation -->
```json
{
  "conversation": {
    "id": "conv_202611270325486752o_ae11",
    "started_at": "2026-11-27T03:25:48Z",
    "current": true,
    "session": { "tool": "codex" },
    "folded": [],
    "messages": [
      {
        "id": "msg_202611270325486782p_d134",
        "at": "2026-11-27T03:25:48Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "user",
        "text": "EDIT bring the last panel closer",
        "job": null,
        "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
        "key": "page:PG_001_003"
      },
      {
        "id": "msg_202611270325492132s_eeb3",
        "at": "2026-11-27T03:25:49Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "assistant",
        "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I also added …",
        "job": "job_202611270325486812q_147a",
        "tool": "claude",
        "reply_to": "msg_202611270325486782p_d134",
        "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
        "key": "page:PG_001_003",
        "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
        "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
        "decisions": [],
        "links": [],
        "proposal": null,
        "reverted": [],
        "story_proposal": null,
        "actions": [],
        "dropped": [],
        "read_only": false
      },
      {
        "id": "msg_202611270325493392x_16d8",
        "at": "2026-11-27T03:25:49Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "assistant",
        "text": "This is the fake assistant. You wrote: \"LINK PROPOSE Where do I add the boy? He is twelve.\". With a real tool installed, the answer comes from Claude Code or Co…",
        "job": "job_202611270325492232v_00fb",
        "tool": "claude",
        "reply_to": "msg_202611270325492212u_ea6a",
        "screen": { "key": "style", "label": "Style", "route": "/p/the-night-ferry/style" },
        "key": "style",
        "files": [],
        "commit": null,
        "decisions": [],
        "links": [
          {
            "key": "characters",
            "route": "/p/the-night-ferry/characters",
            "label": "Characters",
            "screen_label": "Characters",
            "screen_label_code": "screen_label.characters",
            "screen_label_params": {}
          }
        ],
        "proposal": { "id": "prop_202611270325493362w_5120", "parts": 2 },
        "reverted": [],
        "story_proposal": null,
        "actions": [],
        "dropped": [],
        "read_only": false
      },
      {
        "id": "msg_2026112703254936431_195d",
        "at": "2026-11-27T03:25:49Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "event",
        "text": "Codex answers from here on instead of Claude Code. It started a new session and was given a summary of the conversation so far.",
        "text_code": "conversation.tool_changed",
        "text_params": { "from": "Claude Code", "to": "Codex" },
        "job": "job_2026112703254935230_5ec0",
        "event": "tool_changed",
        "tool": "codex",
        "from_tool": "claude"
      }
    ],
    "pending": [],
    "guide": { "on": false, "step": null, "terms": [] }
  },
  "conversations": [
    {
      "id": "conv_202611270325486752o_ae11",
      "started_at": "2026-11-27T03:25:48Z",
      "current": true,
      "messages": 6,
      "last_at": "2026-11-27T03:25:49Z",
      "folded": [],
      "guide": false
    }
  ]
}
```
<!-- /example:conversation -->

### `POST /api/projects/:id/conversation`

Sends a message to the current conversation. Body: `text` (at most 8000
characters), `screen` (`{ key, label?, route? }`, or the key alone) and
`attachments` (optional: at most 12 upload ids, images or text files).
Answers 202 with the stored message, the `chat.turn` job and the
conversation id. The reply arrives as a `chat` event and in the
transcript. 400 `bad_params` without text or screen, 400 `bad_chat_key` for a
key that is malformed or has no files (`home`, `check`...), 404
`chat_target_not_found` for a screen that is not there, 400 `bad_params` for
an attachment that is not an upload of the project.

<!-- example:conversation-post-request -->
```json
{
  "text": "EDIT bring the last panel closer",
  "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" }
}
```
<!-- /example:conversation-post-request -->

<!-- example:conversation-post -->
```json
{
  "conversation": "conv_202611270325486752o_ae11",
  "message": {
    "id": "msg_202611270325486782p_d134",
    "at": "2026-11-27T03:25:48Z",
    "conversation": "conv_202611270325486752o_ae11",
    "role": "user",
    "text": "EDIT bring the last panel closer",
    "job": null,
    "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
    "key": "page:PG_001_003"
  },
  "job": {
    "id": "job_202611270325486812q_147a",
    "project": "the-night-ferry",
    "op": "chat.turn",
    "title": "Chat",
    "title_code": "op.chat.turn.title",
    "title_params": {},
    "params": {
      "key": "page:PG_001_003",
      "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
      "conversation": "conv_202611270325486752o_ae11",
      "text": "EDIT bring the last panel closer",
      "message": "msg_202611270325486782p_d134",
      "attachments": []
    },
    "status": "queued",
    "created_at": "2026-11-27T03:25:48Z",
    "started_at": null,
    "ended_at": null,
    "current_step": null,
    "questions": [],
    "answers": {},
    "result": null,
    "error": null,
    "tools": {},
    "commits": [],
    "position": 1,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:conversation-post -->

### `POST /api/projects/:id/conversation/new`

Starts a fresh conversation, which becomes the current one. The earlier one
stays readable through `GET .../conversations/:conversation`. The body is
ignored; send `{}`. Answers 201 with the new conversation and the list.

<!-- example:conversation-new -->
```json
{
  "conversation": {
    "id": "conv_2026112703254963539_6fea",
    "started_at": "2026-11-27T03:25:49Z",
    "current": true,
    "session": null,
    "folded": [],
    "messages": [],
    "pending": [],
    "guide": { "on": false, "step": null, "terms": [] }
  },
  "conversations": [
    {
      "id": "conv_2026112703254963539_6fea",
      "started_at": "2026-11-27T03:25:49Z",
      "current": true,
      "messages": 0,
      "last_at": null,
      "folded": [],
      "guide": false
    },
    {
      "id": "conv_202611270325486752o_ae11",
      "started_at": "2026-11-27T03:25:48Z",
      "current": false,
      "messages": 8,
      "last_at": "2026-11-27T03:25:49Z",
      "folded": [],
      "guide": false
    }
  ]
}
```
<!-- /example:conversation-new -->

### `POST /api/projects/:id/conversation/guide`

Turns [guide mode](#guide-mode) on or off for the current conversation. Body
`{ "on": true | false }` (400 `bad_params` otherwise). On posts the guide's
first message at once; off adds a `guide_off` event and keeps everything.
Answers `{ conversation, on, message }`.

<!-- example:guide-on -->
```json
{
  "conversation": {
    "id": "conv_2026112703261041552_9304",
    "started_at": "2026-11-27T03:26:10Z",
    "current": true,
    "session": null,
    "folded": [],
    "messages": [
      {
        "id": "msg_2026112703261047753_94d7",
        "at": "2026-11-27T03:26:10Z",
        "conversation": "conv_2026112703261041552_9304",
        "role": "assistant",
        "text": "Pick a style from the samples below, or describe the one you want in words.",
        "text_code": "guide.style.decide",
        "text_params": {},
        "job": null,
        "tool": null,
        "screen": null,
        "key": "style",
        "links": [
          {
            "key": "style",
            "route": "/p/guided/style",
            "label": "Style",
            "label_code": "screen_label.style",
            "label_params": {},
            "screen_label": "Style",
            "screen_label_code": "screen_label.style",
            "screen_label_params": {}
          }
        ],
        "guide": {
          "key": "style.choose",
          "screen": "style",
          "sig": "style.choose:choose",
          "title": "Next, the look of the comic.",
          "title_code": "guide.style.title",
          "title_params": {},
          "why": "Every page and every character sheet is drawn in this style, so it comes before anything is drawn.",
          "why_code": "guide.style.why",
          "why_params": {},
          "decide": "Pick a style from the samples below, or describe the one you want in words.",
          "decide_code": "guide.style.decide",
          "decide_params": {},
          "choices": [
            {
              "id": "preset-adventure-strip",
              "label": "Adventure strip",
              "label_code": "preset.adventure-strip.name",
              "label_params": {},
              "draws": false,
              "images": null,
              "preset": "adventure-strip"
            },
            {
              "id": "preset-charcoal-graphite",
              "label": "Charcoal and graphite",
              "label_code": "preset.charcoal-graphite.name",
              "label_params": {},
              "draws": false,
              "images": null,
              "preset": "charcoal-graphite"
            },
            "... 24 more"
          ],
          "presets": [
            {
              "key": "adventure-strip",
              "name": "Adventure strip",
              "name_code": "preset.adventure-strip.name",
              "name_params": {},
              "intent": "Serial adventure, mystery, or romance told a few panels at a time. Realistic people and places, lit like a film, in black and white that survives chea…",
              "intent_code": "preset.adventure-strip.intent",
              "intent_params": {},
              "preview": { "url": "/api/presets/adventure-strip/preview?v=mwy19ubv7u6q", "width": 768, "height": 1152 }
            },
            {
              "key": "charcoal-graphite",
              "name": "Charcoal and graphite",
              "name_code": "preset.charcoal-graphite.name",
              "name_params": {},
              "intent": "Grief, memory, war, and stories set in fog, snow, or dust. Use it when soft darkness and smudged edges should make the reader lean in.",
              "intent_code": "preset.charcoal-graphite.intent",
              "intent_params": {},
              "preview": { "url": "/api/presets/charcoal-graphite/preview?v=mwy19udh3ok6", "width": 768, "height": 1152 }
            },
            "... 24 more"
          ],
          "images": [],
          "expects": { "action": "style.define", "param": "description" },
          "busy": null,
          "lines": [
            "I will guide you through this comic one decision at a time. Ask me anything along the way, or use the screens: I pick up from wherever the project is.",
            "... 3 more"
          ],
          "terms_explained": []
        }
      },
      "... 1 more"
    ],
    "pending": [],
    "guide": {
      "on": true,
      "step": {
        "key": "style.choose",
        "screen": "style",
        "sig": "style.choose:choose",
        "title": "Next, the look of the comic.",
        "title_code": "guide.style.title",
        "title_params": {},
        "why": "Every page and every character sheet is drawn in this style, so it comes before anything is drawn.",
        "why_code": "guide.style.why",
        "why_params": {},
        "decide": "Pick a style from the samples below, or describe the one you want in words.",
        "decide_code": "guide.style.decide",
        "decide_params": {},
        "choices": [
          {
            "id": "preset-adventure-strip",
            "label": "Adventure strip",
            "label_code": "preset.adventure-strip.name",
            "label_params": {},
            "draws": false,
            "images": null,
            "preset": "adventure-strip"
          },
          {
            "id": "preset-charcoal-graphite",
            "label": "Charcoal and graphite",
            "label_code": "preset.charcoal-graphite.name",
            "label_params": {},
            "draws": false,
            "images": null,
            "preset": "charcoal-graphite"
          },
          "... 24 more"
        ],
        "presets": [
          {
            "key": "adventure-strip",
            "name": "Adventure strip",
            "name_code": "preset.adventure-strip.name",
            "name_params": {},
            "intent": "Serial adventure, mystery, or romance told a few panels at a time. Realistic people and places, lit like a film, in black and white that survives chea…",
            "intent_code": "preset.adventure-strip.intent",
            "intent_params": {},
            "preview": { "url": "/api/presets/adventure-strip/preview?v=mwy19ubv7u6q", "width": 768, "height": 1152 }
          },
          {
            "key": "charcoal-graphite",
            "name": "Charcoal and graphite",
            "name_code": "preset.charcoal-graphite.name",
            "name_params": {},
            "intent": "Grief, memory, war, and stories set in fog, snow, or dust. Use it when soft darkness and smudged edges should make the reader lean in.",
            "intent_code": "preset.charcoal-graphite.intent",
            "intent_params": {},
            "preview": { "url": "/api/presets/charcoal-graphite/preview?v=mwy19udh3ok6", "width": 768, "height": 1152 }
          },
          "... 24 more"
        ],
        "images": [],
        "expects": { "action": "style.define", "param": "description" },
        "busy": null
      },
      "terms": []
    }
  },
  "on": true,
  "message": {
    "id": "msg_2026112703261055954_a859",
    "at": "2026-11-27T03:26:10Z",
    "conversation": "conv_2026112703261041552_9304",
    "role": "assistant",
    "text": "Pick a style from the samples below, or describe the one you want in words.",
    "text_code": "guide.style.decide",
    "text_params": {},
    "job": null,
    "tool": null,
    "screen": null,
    "key": "style",
    "links": [
      {
        "key": "style",
        "route": "/p/guided/style",
        "label": "Style",
        "label_code": "screen_label.style",
        "label_params": {},
        "screen_label": "Style",
        "screen_label_code": "screen_label.style",
        "screen_label_params": {}
      }
    ],
    "guide": {
      "key": "style.choose",
      "screen": "style",
      "sig": "style.choose:choose",
      "title": "Next, the look of the comic.",
      "title_code": "guide.style.title",
      "title_params": {},
      "why": "Every page and every character sheet is drawn in this style, so it comes before anything is drawn.",
      "why_code": "guide.style.why",
      "why_params": {},
      "decide": "Pick a style from the samples below, or describe the one you want in words.",
      "decide_code": "guide.style.decide",
      "decide_params": {},
      "choices": [
        {
          "id": "preset-adventure-strip",
          "label": "Adventure strip",
          "label_code": "preset.adventure-strip.name",
          "label_params": {},
          "draws": false,
          "images": null,
          "preset": "adventure-strip"
        },
        {
          "id": "preset-charcoal-graphite",
          "label": "Charcoal and graphite",
          "label_code": "preset.charcoal-graphite.name",
          "label_params": {},
          "draws": false,
          "images": null,
          "preset": "charcoal-graphite"
        },
        "... 24 more"
      ],
      "presets": [
        {
          "key": "adventure-strip",
          "name": "Adventure strip",
          "name_code": "preset.adventure-strip.name",
          "name_params": {},
          "intent": "Serial adventure, mystery, or romance told a few panels at a time. Realistic people and places, lit like a film, in black and white that survives chea…",
          "intent_code": "preset.adventure-strip.intent",
          "intent_params": {},
          "preview": { "url": "/api/presets/adventure-strip/preview?v=mwy19ubv7u6q", "width": 768, "height": 1152 }
        },
        {
          "key": "charcoal-graphite",
          "name": "Charcoal and graphite",
          "name_code": "preset.charcoal-graphite.name",
          "name_params": {},
          "intent": "Grief, memory, war, and stories set in fog, snow, or dust. Use it when soft darkness and smudged edges should make the reader lean in.",
          "intent_code": "preset.charcoal-graphite.intent",
          "intent_params": {},
          "preview": { "url": "/api/presets/charcoal-graphite/preview?v=mwy19udh3ok6", "width": 768, "height": 1152 }
        },
        "... 24 more"
      ],
      "images": [],
      "expects": { "action": "style.define", "param": "description" },
      "busy": null,
      "lines": [
        "I will guide you through this comic one decision at a time. Ask me anything along the way, or use the screens: I pick up from wherever the project is.",
        "Next, the look of the comic.",
        "... 2 more"
      ],
      "terms_explained": []
    }
  }
}
```
<!-- /example:guide-on -->

### `POST /api/projects/:id/conversation/guide/choose`

A click on one of the choices of the guide's message. Body
`{ "step": "<guide.sig>", "choice": "<choice id>", "screen": { "key": ... } }`.
The server checks that the project is still at that step (409 `guide_moved`
with `details.step`, the step it is at now, when it moved on; 409
`guide_off` when the mode is off), adds a message of the person with the
choice's label, makes the cards of the choice through the same checks as a
chat reply, marks them as the person's request and runs them
(`run_by: "guide"`), with a guide message that says what happens now. A
choice with no action (publish without a cover) moves the guide on. Answers
`{ message, reply, cards, dropped, ran }`.

<!-- example:guide-choose -->
```json
{
  "message": {
    "id": "msg_2026112703261069155_c0cc",
    "at": "2026-11-27T03:26:10Z",
    "conversation": "conv_2026112703261041552_9304",
    "role": "user",
    "text": "Ligne claire",
    "job": null,
    "screen": {
      "key": "style",
      "label": "Style",
      "label_code": "screen_label.style",
      "label_params": {},
      "route": "/p/guided/style"
    },
    "key": "style",
    "guide_choice": { "step": "style.choose", "choice": "preset-ligne-claire" }
  },
  "reply": {
    "id": "msg_2026112703261069256_7de8",
    "at": "2026-11-27T03:26:10Z",
    "conversation": "conv_2026112703261041552_9304",
    "role": "assistant",
    "text": "Define the style: starting now. It usually takes about 3 min. Then I will offer to draw a look page.",
    "text_code": "guide.started.time",
    "text_params": { "title": "Define the style", "minutes": 3, "after": "Then I will offer to draw a look page." },
    "job": null,
    "tool": null,
    "key": "style",
    "screen": null,
    "actions": ["card_2026112703261071257_dad3"],
    "dropped": [],
    "guide": {
      "key": "started",
      "sig": "chosen:msg_2026112703261069256_7de8",
      "lines": ["Define the style: starting now. It usually takes about 3 min. Then I will offer to draw a look page."],
      "choices": [],
      "images": []
    }
  },
  "cards": [
    {
      "id": "card_2026112703261071257_dad3",
      "action": "style.define",
      "kind": "op",
      "params": { "preset": "ligne-claire" },
      "why": "",
      "title": "Define the style",
      "title_code": "op.style.define.title",
      "title_params": {},
      "summary": "Writes the style bible and the style block from a preset, a description, uploaded reference images, or a mix.",
      "summary_code": "op.style.define.summary",
      "summary_params": {},
      "details": [{ "name": "preset", "value": "ligne-claire" }],
      "draws": false,
      "images": null,
      "auto": true,
      "decision": false,
      "tools": [{ "verb": "plan", "tool": "claude", "model": null, "available": true }],
      "typical": { "ms": 152000, "source": "reference", "runs": 0, "pages": null },
      "uploads": [],
      "preview": null,
      "photo_rights": false,
      "requested": true,
      "choice": null,
      "chosen": null,
      "always_confirm": false,
      "status": "started",
      "after": null,
      "waits_for": null,
      "job": "job_2026112703261073659_9f20",
      "result": null,
      "error": null,
      "run_by": "guide",
      "conversation": "conv_2026112703261041552_9304",
      "message": "msg_2026112703261069256_7de8",
      "proposed_by_job": null,
      "created_at": "2026-11-27T03:26:10Z",
      "updated_at": "2026-11-27T03:26:10Z",
      "guided": true,
      "started_at": "2026-11-27T03:26:10Z"
    }
  ],
  "dropped": [],
  "ran": [{ "card": "card_2026112703261071257_dad3", "status": "started", "job": "job_2026112703261073659_9f20" }]
}
```
<!-- /example:guide-choose -->

<!-- example:guide-moved -->
```json
{
  "error": {
    "code": "guide_moved",
    "message": "The project moved on since this choice was shown. The guide shows the step it is at now.",
    "params": { "detail": "The project moved on since this choice was shown: here is the step it is at now." },
    "details": {
      "step": {
        "key": "style.look",
        "screen": "style",
        "sig": "style.look:draw",
        "title": "Now a look page.",
        "title_code": "guide.look.title",
        "title_params": {},
        "why": "Before any real page, one sample page shows the style as the drawing tool understands it.",
        "why_code": "guide.look.why",
        "why_params": {},
        "decide": "Shall I draw it? It takes about 3 min.",
        "decide_code": "guide.look.decide",
        "decide_params": { "minutes": 3 },
        "choices": [
          {
            "id": "draw",
            "label": "Draw the look page (about 3 min)",
            "label_code": "guide.look.draw",
            "label_params": { "minutes": 3 },
            "draws": true,
            "images": 1,
            "preset": null
          }
        ],
        "presets": null,
        "images": [],
        "expects": null,
        "busy": null
      }
    }
  }
}
```
<!-- /example:guide-moved -->

### `GET /api/projects/:id/conversations`

Every conversation of the project, newest first:
`[{ id, started_at, current, messages, last_at, folded }]`. `messages` counts
what the person and the tools said, not the events.

<!-- example:conversations -->
```json
{
  "conversations": [
    {
      "id": "conv_2026112703254963539_6fea",
      "started_at": "2026-11-27T03:25:49Z",
      "current": true,
      "messages": 0,
      "last_at": null,
      "folded": [],
      "guide": false
    },
    {
      "id": "conv_202611270325486752o_ae11",
      "started_at": "2026-11-27T03:25:48Z",
      "current": false,
      "messages": 8,
      "last_at": "2026-11-27T03:25:49Z",
      "folded": [],
      "guide": false
    }
  ]
}
```
<!-- /example:conversations -->

### `GET /api/projects/:id/conversations/:conversation`

One conversation, current or earlier, with the fields of
`GET .../conversation`. 404 `conversation_not_found` for an unknown id.

<!-- example:conversation-old -->
```json
{
  "conversation": {
    "id": "conv_202611270325486752o_ae11",
    "started_at": "2026-11-27T03:25:48Z",
    "current": false,
    "session": { "tool": "claude" },
    "folded": [],
    "messages": [
      {
        "id": "msg_202611270325486782p_d134",
        "at": "2026-11-27T03:25:48Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "user",
        "text": "EDIT bring the last panel closer",
        "job": null,
        "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
        "key": "page:PG_001_003"
      },
      {
        "id": "msg_202611270325492132s_eeb3",
        "at": "2026-11-27T03:25:49Z",
        "conversation": "conv_202611270325486752o_ae11",
        "role": "assistant",
        "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes …",
        "job": "job_202611270325486812q_147a",
        "tool": "claude",
        "reply_to": "msg_202611270325486782p_d134",
        "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
        "key": "page:PG_001_003",
        "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
        "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
        "decisions": [],
        "links": [],
        "proposal": null,
        "reverted": [],
        "story_proposal": null,
        "actions": [],
        "dropped": [],
        "read_only": false
      },
      "... 8 more"
    ],
    "pending": [],
    "guide": { "on": false, "step": null, "terms": [] }
  }
}
```
<!-- /example:conversation-old -->

## Actions of the conversation

The conversation can do what the screens do. The catalog
(`GET /api/actions`) is written into every chat prompt with the parameters
of each action. A reply proposes work in its structured output:
`data.actions: [{ action, params, why }]`. The server checks each one with
the action's own validation, the one the screens' requests go through, and
stores it as a card on the reply. An action that does not check out is left
out, with the reason in `dropped` and in the job log. A reply proposes at
most six.

A card the person's current message asks for in so many words ("draw the
look page", "acepta toda la propuesta") carries `run: true` in the reply
and starts in the same turn, drawing included, with `run_by: "request"`.
A delete or a merge never does: it always waits for a click
(`always_confirm: true`). Anything the model suggests on its own waits.

Cards proposed together are a sequence. A card that its own validation
refuses now only because of the state of the project (a 404 or 409, such as
a plan not approved yet or a character not made yet) is kept when an
earlier card of the same reply may make it possible: it carries
`after: { card, n, title }` and `waits_for` (the reason it would be
refused now), is checked again when it is about to run, and runs after that
card has finished. Run out of order, it waits (`waiting`); when the earlier
card fails, is cancelled or is dismissed, it is `cancelled` with the reason.
So "approve the plan of page 1 and draw it" runs both, in order, from one
message.

Otherwise a card runs when the person
clicks Run (`POST .../actions/:card/run`), or when they confirm it in words
("yes, draw it", "sí, apruébala") and the next reply returns
`data.run_actions: [<card id>]` with the ids of cards that were waiting. An
operation runs as a job through the normal queue, so progress, the commit of
each step, reviews and cancel work as from a screen. A decision (an
approval, a proposal decided, an answer) runs at once through the same code
as the screen's route. Text-only work may run at once when
`settings.chat_auto_run` is on; anything that draws, approves, decides or
answers always waits for a click or a confirmation in words.

The actions:

| Action | Kind | What it does |
|---|---|---|
| `story.update`, `story.draft`, `story.complete`, `story.suggest` | op | The story operations. Text the AI writes is a proposal. |
| `proposal.decide` | direct, decision | Accepts, edits or rejects the parts of a story proposal: `{ proposal, decisions }` as `POST .../proposals/:proposal/decide`, or `{ proposal, all: "accept" \| "reject" }` for every pending part. |
| `proposal.discard` | direct, decision | Drops a proposal. |
| `style.define`, `style.look` | op | The style, and its look page (draws). |
| `approve.asset` | direct, decision | Approves a candidate sheet, plate or look page: `{ candidate, supersede?, note? }`. |
| `options.update` | direct, decision | Changes project options: `{ options: { ... } }` with the body of `PUT .../options`. |
| `character.create`, `character.update`, `character.sheet` | op | Characters, from words and attached photos; the sheet draws. |
| `entities.derive` | op | Places and objects (plates draw). |
| `pages.plan` | op | Plans pages from the person's words. |
| `approve.plan` | direct, decision | Approves page plans: `{ pages, approved? }`. |
| `page.lettering` | direct, decision | Changes the lettering of a page plan: `{ page, panels: [{ panel, lettering: [{ id?, type, speaker?, text }] }] }`, the whole new list of each panel it touches. Saved as `PUT .../pages/:page/plan`. The card carries a `preview` of the change. |
| `pages.generate`, `page.review`, `page.correct`, `page.manual` | op | Drawing, checking, correcting (draws), a page made by hand. |
| `approve.page` | direct, decision | `{ page, render?, overrule?, note? }` as `POST .../approve/page`. |
| `cover.create`, `cover.correct` | op | The cover (draws). |
| `approve.cover` | direct, decision | `{ issue?, render?, overrule?, note? }`. |
| `lettering.apply`, `publish.build` | op | Lettering in overlay mode, and the edition. |
| `issue.create` | direct, decision | The next issue: `{ title, pages?, summary? }` as `POST .../issues`. |
| `story.text` | direct, decision | Saves the person's own story, in their words, as their text (`story/source/description.md`): `{ text, append? }`. Nothing is rewritten. |
| `page.mode` | direct, decision | Draws a page panel by panel or as one image: `{ page, mode }` as [`POST .../pages/:page/mode`](#post-apiprojectsidpagespagemode). |
| `job.answer` | direct, decision | Answers a job waiting for a decision: `{ job, answers }`. |
| `job.resume` | direct, decision | Resumes a job paused because a tool ran out of quota: `{ job }` as [`POST .../jobs/:job/resume`](#post-apiprojectsidjobsjobresume). |
| `job.cancel` | direct, decision | Cancels a job: `{ job }`. |
| `delete` | direct, decision | Deletes what nothing uses: `{ items: [{ id, kind? }], confirm_master? }` as `POST .../delete`. Always waits for a click. |
| `entity.merge` | direct, decision | `{ from, into }` as `POST .../entities/merge`. Always waits for a click. |
| `entity.rename` | direct, decision | `{ from, to }` as `POST .../entities/rename`. |

In overlay lettering mode, turning each overlay into a flat image happens in
the browser on the Publish screen; the conversation can place the lettering
(`lettering.apply`) and link to that screen, and cannot flatten.

A card:

| Field | Meaning |
|---|---|
| `id`, `action`, `kind` | The card, the action and `op` or `direct`. |
| `params`, `why` | What the reply proposed, and its one-line reason. `"@attachments"` in a parameter stands for the ids of the message's attachments (images for `uploads` and `upload`, text files for `source_upload`). |
| `title`, `summary` | What it will do, in the language of the request, with their codes. |
| `details` | The parameters in plain form, `[{ name, value }]`, with upload names in place of ids and the names of characters, places and props in place of their IDs. The screens show a label per parameter and keep the raw names under a details toggle. |
| `uploads` | The uploads the parameters name, with their URLs, for thumbnails. |
| `preview` | For `page.lettering`: `{ page, changes, warnings, drawn }`, what the card will change before it runs. `changes` is one entry per element (`change`, `panel` number, `kind`, `speaker` name, `text`, `before`), `warnings` the budgets it passes, `drawn` whether the page already has a render. `null` for other actions. |
| `choice`, `chosen` | For `page.correct` and `cover.correct` on an image at the touch-up warning: `{ touch_ups, warning, text, options: [{ mode, label }] }` with `touch_up` and `redraw`. Such a card has no Run: it runs with the option the person clicks, never on its own, even when the message asked for the correction. `chosen` is the mode that ran. |
| `photo_rights` | `true` when a photo is used for a character: show the photo-rights notice of the Characters screen. |
| `draws`, `decision`, `auto` | Whether it draws, whether it is the person's decision, and whether `chat_auto_run` may start it. |
| `images` | For a card that draws: how many images it will draw before any automatic repair (one per page, one per panel of a page drawn panel by panel, one per sheet), so batch drawing says it before it runs. Else `null`. |
| `tools` | `[{ verb, tool, model, available }]`: which tool and model will do each part. |
| `typical` | `{ ms, source, runs, pages }`: how long it usually takes. `source` is `measured` (from the finished jobs of the same operation in this project, per page for page work) or `reference` (the run measured in `studio/README.md`). |
| `status` | `pending` (waiting for the person), `waiting` (run, and waiting for the card before it), `started` (its job is queued or running), `running` (a decision being made), `done`, `failed`, `cancelled`, `needs_decision`, `paused` (a tool ran out of quota) or `dismissed`. |
| `job`, `run_by` | The job it started, and how it was started: `click`, `text` (confirmed in words), `request` (the message that proposed it asked for it), `guide` (a choice clicked in a guide message) or `auto`. |
| `requested`, `always_confirm` | Whether the reply asked to run it at once (`run: true`), and whether it is a delete or a merge, which always waits. |
| `after`, `waits_for` | For a card of a sequence: the card it runs after, `{ card, n, title }`, and why it could not run before that card. Else `null`. |
| `result`, `error` | The job's or the decision's result, or why it failed. |
| `conversation`, `message`, `proposed_by_job` | Where it lives, and the chat turn that proposed it. |

When a job started from a card ends or stops to ask, the card takes the
outcome and an `action_result` event message is added to the conversation
that started it, with the images it drew, links to the screens where they
are approved, and in `added` the characters, places and props the job
created (as in [What a step added](#what-a-step-added)). A paused job's questions can be answered there, through
`POST .../jobs/:job/answer`, or by the person replying in the chat, after
which the reply proposes `job.answer`.

### `POST /api/projects/:id/conversation/:conversation/actions/:card/run`

Runs a waiting card. An operation is queued as a job with
`origin: { conversation, card, message }`; a decision is made now. Body:
`{}`, or `{ "choice": "touch_up" | "redraw" }` for a card with a `choice`
(409 `choice_needed` without it). Answers
`{ card, job }` with the card in its new state (`started`, `done` or
`failed`) and the job, or `null`. When the action itself is refused (a
review that is flagged, an approval of something that is not there), the
card is `failed` with the reason; the request still answers 200. 409
`card_not_pending` when the card already ran or was dismissed, 404
`card_not_found` for an unknown card.

### `POST /api/projects/:id/conversation/:conversation/actions/:card/dismiss`

Marks a waiting card as dismissed; nothing is done. Answers `{ card }`. 409
`card_not_pending` when it already ran or was dismissed.

### Conversations per screen (deprecated)

Earlier versions had one conversation per screen. Their three routes still
answer, on top of the project conversation, so an older interface keeps
working. New code uses the routes above.

### `GET /api/projects/:id/chats`

Deprecated. The screens that have messages in the current conversation:
`[{ key, messages, last_at }]`.

<!-- example:chats -->
```json
{
  "chats": [
    { "key": "cover:ISS_001", "messages": 2, "last_at": "2026-11-27T03:25:49Z" },
    { "key": "page:PG_001_003", "messages": 2, "last_at": "2026-11-27T03:25:49Z" },
    "... 1 more"
  ]
}
```
<!-- /example:chats -->

### `GET /api/projects/:id/chats/:key`

Deprecated. The messages of the current conversation sent from one screen,
with the `files` the AI gets for that screen, the `conversation` id and
`pending`, the ids of turns for this screen that have not finished.

<!-- example:chat -->
```json
{
  "key": "page:PG_001_003",
  "screen": "page PG_001_003",
  "files": [
    "issues/ISS_001/pages/PG_001_003/page.yaml",
    "issues/ISS_001/pages/PG_001_003/reviews/PG_001_003_V01.review.yaml",
    "... 1 more"
  ],
  "conversation": "conv_202611270325486752o_ae11",
  "messages": [
    {
      "id": "msg_202611270325486782p_d134",
      "at": "2026-11-27T03:25:48Z",
      "conversation": "conv_202611270325486752o_ae11",
      "role": "user",
      "text": "EDIT bring the last panel closer",
      "job": null,
      "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
      "key": "page:PG_001_003"
    },
    {
      "id": "msg_202611270325492132s_eeb3",
      "at": "2026-11-27T03:25:49Z",
      "conversation": "conv_202611270325486752o_ae11",
      "role": "assistant",
      "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
      "job": "job_202611270325486812q_147a",
      "tool": "claude",
      "reply_to": "msg_202611270325486782p_d134",
      "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
      "key": "page:PG_001_003",
      "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
      "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
      "decisions": [],
      "links": [],
      "proposal": null,
      "reverted": [],
      "story_proposal": null,
      "actions": [],
      "dropped": [],
      "read_only": false
    }
  ],
  "pending": []
}
```
<!-- /example:chat -->

### `POST /api/projects/:id/chats/:key`

Deprecated. Body: `{ "text": "<message>" }`. The same as
`POST .../conversation` with the screen given by the key. Answers 202 with
the stored message and the job.

<!-- example:chat-post -->
```json
{
  "message": {
    "id": "msg_2026112703254949534_2aaa",
    "at": "2026-11-27T03:25:49Z",
    "conversation": "conv_202611270325486752o_ae11",
    "role": "user",
    "text": "Sent the old way.",
    "job": null,
    "screen": {
      "key": "style",
      "label": "Style",
      "label_code": "screen_label.style",
      "label_params": {},
      "route": "/p/the-night-ferry/style"
    },
    "key": "style"
  },
  "job": {
    "id": "job_2026112703254949735_512e",
    "project": "the-night-ferry",
    "op": "chat.turn",
    "title": "Chat",
    "title_code": "op.chat.turn.title",
    "title_params": {},
    "params": {
      "key": "style",
      "screen": {
        "key": "style",
        "label": "Style",
        "label_code": "screen_label.style",
        "label_params": {},
        "route": "/p/the-night-ferry/style"
      },
      "conversation": "conv_202611270325486752o_ae11",
      "text": "Sent the old way.",
      "message": "msg_2026112703254949534_2aaa",
      "attachments": []
    },
    "status": "queued",
    "created_at": "2026-11-27T03:25:49Z",
    "started_at": null,
    "ended_at": null,
    "current_step": null,
    "questions": [],
    "answers": {},
    "result": null,
    "error": null,
    "tools": {},
    "commits": [],
    "position": 1,
    "cost_usd": null,
    "read_only": false,
    "origin": null,
    "story_proposals": null,
    "added_entities": null,
    "paused": null
  }
}
```
<!-- /example:chat-post -->

## Story proposals

The AI writes story text only when the person asks, and what it writes
arrives as a proposal: parts the person accepts, edits or rejects one by one
before any of it becomes canon. Proposals come from
[`story.draft`](#storydraft), [`story.complete`](#storycomplete),
[`story.suggest`](#storysuggest), the deprecated
[`project.setup`](#projectsetup), and chat messages that ask for story text.
They are stored in `.studio/proposals/<proposal id>.json` of the project.

Where the person's text leaves open something the story needs (how a mystery
is explained, how it ends, who holds what), the AI asks instead of deciding:
as a `question` part of the proposal, or, when it cannot go on without the
answer, by pausing the job with `needs_decision`.

A proposal:

| Field | Meaning |
|---|---|
| `id` | `prop_...`. |
| `kind` | `draft`, `complete`, `suggest` or `chat`. |
| `title` | What it is, for the person, with its code. |
| `instruction` | The person's request (`story.suggest`, a chat message), else `null`. |
| `status` | `open` while a part is pending, `closed` once every part is decided, `discarded`. |
| `summary`, `decisions`, `tool`, `job` | What the tool said about it, and the job that made it. |
| `conversation`, `message` | For a proposal made by a chat message, the conversation and the person's message. |
| `parts` | The parts, below. |
| `counts` | `{ parts, pending, accepted, edited, rejected }`. |
| `commits` | The commits that wrote accepted parts. |

A part:

| Field | Meaning |
|---|---|
| `id` | `P01`, `P02`... in order. |
| `type` | `premise`, `tone`, `world_rule`, `fact`, `arc`, `timeline` or `question`. |
| `text` | What the AI proposes, in the project's language. |
| `provenance`, `source_ref`, `affects` | For a fact. `provenance` is `source` (the person's text says it; `source_ref` points into `story/source/`, and a claim without an existing source file becomes `addition`), `user_change` (what the person asked for in a chat message) or `addition` (invented). `affects` lists entity ids. |
| `character`, `role` | For an arc: the character id, and its role or `null`. |
| `issue` | For a timeline event: the issue that shows it, or `null`. |
| `blocking`, `options`, `answer` | For a question: whether it blocks drawing, the options the AI offers, and the person's answer once given. |
| `status` | `pending`, `accepted`, `edited` (accepted with the person's text) or `rejected`. |
| `decided_at`, `final_text` | When it was decided, and the words written (`null` for a rejected part). |
| `written` | What accepting wrote, such as `{ "fact": "FACT_004", "provenance": "source" }`, `{ "order": 3 }` for a timeline event, `{ "character": "CHAR_MARA" }` for an arc, `{ "resolved": true }` for an answered question. `dropped_affects` lists entity ids of a fact that do not exist in the workspace and were left out. |

What accepting writes into `story/story-bible.yaml`:

| Part | Written as |
|---|---|
| `premise`, `tone` | The new value of the field. |
| `world_rule` | Appended to `world_rules`. |
| `fact` | A new fact, `FACT_###` after the highest one, `replaces: null`, `affects` kept to entities that exist. Accepted as proposed it keeps the part's provenance (`source` with its `source_ref`, `user_change`, or `addition`, the schema's provenance for invented facts). Accepted with edited text it is `user_change`: the words are the person's. |
| `arc` | The `arc` of that character's row in `characters`; a row is added when the character is not listed. |
| `timeline` | Appended to `timeline` with the next `order`. |
| `question` | Appended to `open_questions` with its `blocking`; the person's `answer`, when given, becomes its `resolution`. |

The file is changed through the scaffold's comment-keeping helpers
(`scripts/lib/yaml-edit.js`): values are set where they are and list items
are added at the end of their list, so the person's comments stay. When an
edit cannot be placed that way, the file is written from the document and
only its top comment block stays; the answer's `comments_kept` says which
happened. Every decision that writes is one history entry (kind
`proposal`) and one commit.

### `GET /api/projects/:id/proposals`

Every proposal, newest first, without its parts: `id`, `kind`, `status`,
`title`, `instruction`, `summary`, `created_at`, `updated_at`, `job`, `tool`,
`counts`. `?status=open` (or `closed`, `discarded`) filters.

<!-- example:proposals -->
```json
{
  "proposals": [
    {
      "id": "prop_2026112703250859408_7414",
      "kind": "suggest",
      "status": "open",
      "title": "Suggestion",
      "title_code": "proposal.title.suggest",
      "title_params": {},
      "instruction": "Suggest an ending.",
      "summary": "This is the fake assistant. It proposes 3 kind(s) of story text for you to accept or reject.",
      "created_at": "2026-11-27T03:25:08Z",
      "updated_at": "2026-11-27T03:25:08Z",
      "job": "job_2026112703250856507_76aa",
      "tool": "claude",
      "counts": { "parts": 3, "pending": 3, "accepted": 0, "edited": 0, "rejected": 0 }
    },
    {
      "id": "prop_2026112703250854706_b3e1",
      "kind": "complete",
      "status": "discarded",
      "title": "What the story bible lacks",
      "title_code": "proposal.title.complete",
      "title_params": {},
      "instruction": null,
      "summary": "This is the fake assistant. It proposes 2 kind(s) of story text for you to accept or reject.",
      "created_at": "2026-11-27T03:25:08Z",
      "updated_at": "2026-11-27T03:25:08Z",
      "job": "job_2026112703250852505_b7de",
      "tool": "claude",
      "counts": { "parts": 2, "pending": 2, "accepted": 0, "edited": 0, "rejected": 0 }
    },
    {
      "id": "prop_2026112703250792503_9f1e",
      "kind": "draft",
      "status": "open",
      "title": "Draft of the story bible",
      "title_code": "proposal.title.draft",
      "title_params": {},
      "instruction": null,
      "summary": "This is the fake assistant. It proposes 6 kind(s) of story text for you to accept or reject.",
      "created_at": "2026-11-27T03:25:07Z",
      "updated_at": "2026-11-27T03:25:08Z",
      "job": "job_2026112703250784802_ea4e",
      "tool": "claude",
      "counts": { "parts": 9, "pending": 2, "accepted": 5, "edited": 1, "rejected": 1 }
    }
  ]
}
```
<!-- /example:proposals -->

### `GET /api/projects/:id/proposals/:proposal`

One proposal with its parts. 404 `proposal_not_found`.

<!-- example:proposal -->
```json
{
  "proposal": {
    "id": "prop_2026112703250792503_9f1e",
    "kind": "draft",
    "title": "Draft of the story bible",
    "title_code": "proposal.title.draft",
    "title_params": {},
    "instruction": null,
    "status": "open",
    "created_at": "2026-11-27T03:25:07Z",
    "updated_at": "2026-11-27T03:25:07Z",
    "job": "job_2026112703250784802_ea4e",
    "tool": "claude",
    "summary": "This is the fake assistant. It proposes 6 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "conversation": null,
    "message": null,
    "parts": [
      {
        "id": "P01",
        "type": "premise",
        "text": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
        "status": "pending",
        "decided_at": null,
        "final_text": null,
        "written": null
      },
      {
        "id": "P02",
        "type": "tone",
        "text": "Plain and direct.",
        "status": "pending",
        "decided_at": null,
        "final_text": null,
        "written": null
      },
      {
        "id": "P03",
        "type": "world_rule",
        "text": "Placeholder rule from the fake assistant: nothing happens that the text does not say.",
        "status": "pending",
        "decided_at": null,
        "final_text": null,
        "written": null
      },
      {
        "id": "P04",
        "type": "fact",
        "text": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
        "provenance": "source",
        "source_ref": "story/source/description.md#p1",
        "affects": [],
        "status": "pending",
        "decided_at": null,
        "final_text": null,
        "written": null
      },
      "... 5 more"
    ],
    "commits": [],
    "counts": { "parts": 9, "pending": 9, "accepted": 0, "edited": 0, "rejected": 0 }
  }
}
```
<!-- /example:proposal -->

### `POST /api/projects/:id/proposals/:proposal/decide`

Decides parts. Body: `decisions`, a list of
`{ part, decision, text?, answer? }`:

| Field | Meaning |
|---|---|
| `part` | Part id. |
| `decision` | `accept`, `edit` (accept with the person's `text`) or `reject`. |
| `text` | Required with `edit`: the words to write instead. |
| `answer` | For a question part that is accepted or edited: the person's answer, written as its `resolution`. |

Parts left out stay pending, so a screen can send one decision at a time.
The answer has the proposal after the change, `accepted` and `rejected`
(counts of this request), `comments_kept`, `findings` (schema findings of
the story bible after the write) and `commit` (`null` when nothing was
written, such as a request that only rejects). Refusals: 400 `bad_params`
(no decisions, an unknown decision, an edit without text, a part twice),
404 `part_not_found`, 409 `part_decided` for a part decided before, 409
`proposal_closed` for a proposal that is closed or discarded.

<!-- example:proposal-decide-request -->
```json
{
  "decisions": [
    { "part": "P01", "decision": "accept" },
    { "part": "P02", "decision": "edit", "text": "Quiet and tense, with dry humour." },
    "... 5 more"
  ]
}
```
<!-- /example:proposal-decide-request -->

<!-- example:proposal-decide -->
```json
{
  "proposal": {
    "id": "prop_2026112703250792503_9f1e",
    "kind": "draft",
    "title": "Draft of the story bible",
    "title_code": "proposal.title.draft",
    "title_params": {},
    "instruction": null,
    "status": "open",
    "created_at": "2026-11-27T03:25:07Z",
    "updated_at": "2026-11-27T03:25:08Z",
    "job": "job_2026112703250784802_ea4e",
    "tool": "claude",
    "summary": "This is the fake assistant. It proposes 6 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "conversation": null,
    "message": null,
    "parts": [
      {
        "id": "P01",
        "type": "premise",
        "text": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
        "status": "accepted",
        "decided_at": "2026-11-27T03:25:07Z",
        "final_text": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
        "written": {}
      },
      {
        "id": "P02",
        "type": "tone",
        "text": "Plain and direct.",
        "status": "edited",
        "decided_at": "2026-11-27T03:25:07Z",
        "final_text": "Quiet and tense, with dry humour.",
        "written": {}
      },
      "... 7 more"
    ],
    "commits": ["433b014ed3c6daac0b707d82aeb1f376dd40eff4"],
    "counts": { "parts": 9, "pending": 2, "accepted": 5, "edited": 1, "rejected": 1 }
  },
  "accepted": 6,
  "rejected": 1,
  "comments_kept": true,
  "findings": [],
  "commit": "433b014ed3c6daac0b707d82aeb1f376dd40eff4"
}
```
<!-- /example:proposal-decide -->

### `DELETE /api/projects/:id/proposals/:proposal`

Discards an open proposal: its pending parts are never written. Parts
accepted before stay in the story bible. The proposal stays readable with
`status: "discarded"`. 409 `proposal_closed` when it is already closed or
discarded.

<!-- example:proposal-discard -->
```json
{
  "proposal": {
    "id": "prop_2026112703250854706_b3e1",
    "kind": "complete",
    "title": "What the story bible lacks",
    "title_code": "proposal.title.complete",
    "title_params": {},
    "instruction": null,
    "status": "discarded",
    "created_at": "2026-11-27T03:25:08Z",
    "updated_at": "2026-11-27T03:25:08Z",
    "job": "job_2026112703250852505_b7de",
    "tool": "claude",
    "summary": "This is the fake assistant. It proposes 2 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "conversation": null,
    "message": null,
    "parts": [
      {
        "id": "P01",
        "type": "world_rule",
        "text": "Placeholder rule from the fake assistant.",
        "status": "pending",
        "decided_at": null,
        "final_text": null,
        "written": null
      },
      "... 1 more"
    ],
    "commits": [],
    "discarded_at": "2026-11-27T03:25:08Z",
    "counts": { "parts": 2, "pending": 2, "accepted": 0, "edited": 0, "rejected": 0 }
  }
}
```
<!-- /example:proposal-discard -->

## History

Every finished step, save, approval, decision on a proposal, chat turn and restore is an entry in the
project's activity log, and every entry that changed files links to a git
commit of the project directory.

### Commits

A commit holds the files of its own step or action and nothing else. A job
step commits the files that changed while it ran; a save, an approval, a
delete or a merge commits the files it wrote, named by the action itself.
Whatever else is changing in the workspace at that moment (a page plan
writing character files while the person approves a sheet) stays out, and
what the person's action wrote is left out of the step's commit. The commit
is made from a temporary index seeded from the last commit, so nothing
staged elsewhere is swept in. Undoing an approval from History takes back the
approval alone.

### `GET /api/projects/:id/history`

Newest first. `?limit=` (default 100, at most 1000) and `?before=<entry id>`
for the next page.

| Field | Meaning |
|---|---|
| `entries[].id`, `at` | Entry id and time. |
| `entries[].kind` | `project`, `step`, `save`, `approval`, `proposal` (a decision on a story proposal), `lettering`, `restore`. |
| `entries[].title` | What happened, for the person, with `title_code` and `title_params` beside it. An entry is stored with the code, so the title follows the language of the request. |
| `entries[].actor` | `person`, `claude`, `codex`, or `studio` for a mechanical step. |
| `entries[].job`, `op`, `step` | For a job step. |
| `entries[].files` | `[{ path, change }]` with `change` one of `added`, `modified`, `deleted` (at most 200). |
| `entries[].images` | Image objects of the images the entry added or changed. An image that no longer exists comes as `{ path, url: null, missing: true }`. |
| `entries[].commit` | Commit id, or `null`. |
| `entries[].restorable` | `true` when the project can be restored to the state right after this entry. |
| `total`, `more` | Number of entries, and whether more follow. |
| `restore` | `{ available, reason }`. Without git, `available` is `false` and `reason` says so (`reason_code` is `reason.no_git` or `reason.no_repository`); the log itself still works. |

<!-- example:history -->
```json
{
  "entries": [
    {
      "id": "act_202611270325492082r_c54e",
      "at": "2026-11-27T03:25:49Z",
      "kind": "step",
      "title": "Chat: Answer the message",
      "title_code": "activity.step",
      "title_params": { "title": "Chat", "label": "Answer the message" },
      "actor": "claude",
      "job": "job_202611270325486812q_147a",
      "op": "chat.turn",
      "step": "reply",
      "files": [{ "path": "issues/ISS_001/pages/PG_001_003/page.yaml", "change": "modified" }],
      "images": [],
      "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
      "restorable": true
    },
    {
      "id": "act_202611270325486702n_dc4b",
      "at": "2026-11-27T03:25:48Z",
      "kind": "entity",
      "title": "Merged CHAR_TEODORO_TWIN into CHAR_TEODORO",
      "title_code": "activity.entity_merged",
      "title_params": { "from": "CHAR_TEODORO_TWIN", "into": "CHAR_TEODORO" },
      "actor": "person",
      "job": null,
      "op": null,
      "step": null,
      "files": [
        { "path": "characters/CHAR_TEODORO/character.yaml", "change": "modified" },
        { "path": "characters/CHAR_TEODORO_TWIN/character.yaml", "change": "deleted" },
        "... 1 more"
      ],
      "images": [],
      "commit": "a701d8b7d9c80258fc337c79c70d3a680bc86734",
      "restorable": true
    },
    "... 1 more"
  ],
  "total": 68,
  "more": true,
  "restore": { "available": true, "reason": null }
}
```
<!-- /example:history -->

### `POST /api/projects/:id/history/restore`

Body: `{ "entry": "<entry id>" }` or `{ "commit": "<commit id>" }`. Brings the
workspace back to the state right after that entry, as a new commit on top of
the history. Files added later leave the workspace and stay in git, so the
later state can be restored again. Changes not yet committed are committed
first. The activity log, the chats, the settings and the uploads are not part
of the history and are not touched.

Refusals: 409 `project_busy` while a job is queued or running, 409
`history_unavailable` without git, 409 `entry_not_restorable` for an entry
that changed no files, 404 for an unknown entry or commit.

<!-- example:restore -->
```json
{
  "commit": "7f631fc6a35a712efbc5d66b5bf8cfe82bba8e2a",
  "restored": "2f28ad7fccbe450ff30596111a74f28a2bbfb42e",
  "unchanged": false,
  "saved_first": null,
  "files": 17,
  "activity": {
    "id": "act_202611270325506643a_4369",
    "at": "2026-11-27T03:25:50Z",
    "kind": "restore",
    "title": "Went back to an earlier point: Approved the cover of ISS_001",
    "title_code": "activity.restore",
    "title_params": { "what": "Approved the cover of ISS_001" },
    "actor": "person",
    "job": null,
    "op": null,
    "step": null,
    "files": [
      { "path": "characters/CHAR_TEODORO/character.yaml", "change": "deleted" },
      { "path": "characters/CHAR_TEODORO/wardrobe.yaml", "change": "deleted" },
      "... 15 more"
    ],
    "images": [],
    "commit": "7f631fc6a35a712efbc5d66b5bf8cfe82bba8e2a",
    "restored_from": "2f28ad7fccbe450ff30596111a74f28a2bbfb42e"
  }
}
```
<!-- /example:restore -->

### `GET /api/projects/:id/diff`

What a point of the history changed. Read-only: the server asks git and
writes nothing.

- `?commit=<id>`: the changes of that commit, compared with the commit
  before it. This is the `commit` of a history entry.
- `?from=<id>&to=<id>`: the changes between two commits, in that direction.
- `?limit=` caps the number of files (default and maximum 100).

A commit id is 7 to 40 hexadecimal digits. Names such as `HEAD` are not
accepted.

| Field | Meaning |
|---|---|
| `from`, `to` | The full ids of the two commits. `from` is `null` for the first commit of a project, which has nothing before it. |
| `files[].path` | Workspace-relative path. Only files of the workspace are listed, and no hidden files. |
| `files[].status` | `added`, `modified` or `deleted`. A renamed file is listed as one deleted and one added. |
| `files[].kind` | `text` (`.yaml`, `.yml`, `.md`, `.txt`, `.fountain`, `.json`, `.svg`, `.html`, `.xml`, `.css`), `image` (`.png`, `.jpg`, `.jpeg`, `.webp`) or `other`. |
| `files[].before`, `after` | For a text file: `{ text, bytes, truncated }`. `text` holds at most 204,800 characters; `truncated` is `true` when the file is longer, and `bytes` is its full size. A file over 1.6 MB comes with an empty `text` and `truncated: true`. `null` on the side where the file does not exist, and for images and other files. |
| `files[].before_url`, `after_url` | The file at each commit, through the route below. `null` on the side where the file does not exist. For an image these are the two pictures to compare. |
| `total`, `more` | Number of changed files, and whether the list was cut by `limit`. |

Refusals: 409 `history_unavailable` when git is not installed or the project
has no repository, 404 `commit_not_found` for an id that is not a commit of
this project, 400 `bad_params` when neither `commit` nor both `from` and
`to` are given.

A saved text file:

<!-- example:diff -->
```json
{
  "from": "a4c73e0237ba1305f0d9f2ca74454f0aa28ff340",
  "to": "e39cc5ae3ee3dfe11cd4b7d60f242c28300bad30",
  "files": [
    {
      "path": "story/series-plan.yaml",
      "status": "modified",
      "kind": "text",
      "before": {
        "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written by /series-plan. An issue is the publicat…",
        "bytes": 376,
        "truncated": false
      },
      "after": {
        "text": "# production/story/series-plan.yaml: the story divided into issues\n# Schema: schemas/series-plan.schema.json\n# Written by /series-plan. An issue is the publicat…",
        "bytes": 369,
        "truncated": false
      },
      "before_url": "/api/projects/the-night-ferry/at/a4c73e0237ba1305f0d9f2ca74454f0aa28ff340/raw/story/series-plan.yaml",
      "after_url": "/api/projects/the-night-ferry/at/e39cc5ae3ee3dfe11cd4b7d60f242c28300bad30/raw/story/series-plan.yaml"
    }
  ],
  "total": 1,
  "more": false
}
```
<!-- /example:diff -->

A step that drew a page:

<!-- example:diff-image -->
```json
{
  "from": "a4b63e542de918dcf46d77f8c25beedf993e413f",
  "to": "e91e6d8aa8b959891f787c7a86929f841773aa2c",
  "files": [
    {
      "path": "generations/PG_001_003/GEN_PG_001_003_01.request.json",
      "status": "added",
      "kind": "text",
      "before": null,
      "after": {
        "text": "{\n  \"provider\": \"codex-cli\",\n  \"kind\": \"image\",\n  \"model\": \"codex-cli\",\n  \"endpoint\": null…",
        "bytes": 7383,
        "truncated": false
      },
      "before_url": null,
      "after_url": "/api/projects/the-night-ferry/at/e91e6d8aa8b959891f787c7a86929f841773aa2c/raw/generations/…"
    },
    {
      "path": "generations/PG_001_003/GEN_PG_001_003_01.yaml",
      "status": "added",
      "kind": "text",
      "before": null,
      "after": {
        "text": "id: GEN_PG_001_003_01\npage: PG_001_003\nasset: null\nprovider: codex-cli\nmodel: unreported\nk…",
        "bytes": 825,
        "truncated": false
      },
      "before_url": null,
      "after_url": "/api/projects/the-night-ferry/at/e91e6d8aa8b959891f787c7a86929f841773aa2c/raw/generations/…"
    },
    {
      "path": "issues/ISS_001/pages/PG_001_003/page.yaml",
      "status": "modified",
      "kind": "text",
      "before": {
        "text": "# Schema: schemas/page.schema.json\n\nid: PG_001_003\nissue: ISS_001\nnumber: 3\nscene: SC_001_…",
        "bytes": 3703,
        "truncated": false
      },
      "after": {
        "text": "# Schema: schemas/page.schema.json\n\nid: PG_001_003\nissue: ISS_001\nnumber: 3\nscene: SC_001_…",
        "bytes": 3713,
        "truncated": false
      },
      "before_url": "/api/projects/the-night-ferry/at/a4b63e542de918dcf46d77f8c25beedf993e413f/raw/issues/ISS_0…",
      "after_url": "/api/projects/the-night-ferry/at/e91e6d8aa8b959891f787c7a86929f841773aa2c/raw/issues/ISS_0…"
    },
    {
      "path": "issues/ISS_001/pages/PG_001_003/renders/PG_001_003_V01.png",
      "status": "added",
      "kind": "image",
      "before": null,
      "after": null,
      "before_url": null,
      "after_url": "/api/projects/the-night-ferry/at/e91e6d8aa8b959891f787c7a86929f841773aa2c/raw/issues/ISS_0…"
    }
  ],
  "total": 4,
  "more": false
}
```
<!-- /example:diff-image -->

### `GET /api/projects/:id/at/:commit/raw/*path`

A file of the workspace as it was at a commit, by its workspace-relative
path. Read-only, through `git show`. `:commit` is 7 to 40 hexadecimal
digits. Use the `before_url` and `after_url` of a diff instead of building
these.

- The response can be cached for good (`Cache-Control: private,
  max-age=31536000, immutable`): a file at a commit never changes.
- `?download=1` adds `Content-Disposition: attachment`.
- The headers of the raw route apply: `nosniff`, `Cross-Origin-Resource-Policy:
  same-origin`, the sandbox for HTML and SVG, and the wider policy for the
  page images of a web reader.
- `Range` is not honoured.

Refusals: 409 `history_unavailable` without git, 404 `commit_not_found`,
404 `not_found` for a path the commit does not have, for hidden files, and
for anything outside the workspace, 413 `too_large` over 64 MB.

## Approvals

Decisions only the person makes. They are plain calls, not jobs, and each is
committed and logged. They work while a job is running: the commit of an
approval holds the approval's own files and nothing a running job is
writing at the same moment, and the job's step leaves them out of its own
commit. See [Commits](#commits).

### `POST /api/projects/:id/approve/asset`

Promotes a candidate (a look page or a sheet) to a master through
`approve-asset.js`: the candidate is copied to its `_MASTER` name, registered
as approved, and listed in the entity's references. Approving a look page
also freezes the style block (`style_frozen: true` in the answer).

| Body field | Meaning |
|---|---|
| `candidate` | Candidate id (`CHAR_MARA_TURN_V01`, `LOOK_NOIR_INK_V01`) or its workspace path. Required. |
| `note` | Stored in the registry. |
| `supersede` | `true` to replace the approved master of the same sheet. Without it a second approval is 409 `master_exists`. |

<!-- example:approve-asset -->
```json
{
  "asset_id": "LOOK_NOIR_INK_MASTER_V01",
  "file": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
  "entity": "LOOK_NOIR_INK",
  "role": "style",
  "superseded": null,
  "kind": "look",
  "candidate": "references/style/LOOK_NOIR_INK_V01.png",
  "sha256": "0f94b7edfcf14eda298698ae27c15687565f42d21cf21413eb461d68c78bc710",
  "generation_record": "GEN_LOOK_NOIR_INK_01",
  "approved_by": "person",
  "approved_at": "2026-11-27",
  "updated": ["references/style/LOOK_NOIR_INK_MASTER_V01.png", "references/manifest.yaml", "project.yaml"],
  "stale": [],
  "style_block": "style/style-block.txt",
  "warnings": [],
  "image": {
    "path": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
    "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwyf4sul",
    "width": 600,
    "height": 900,
    "bytes": 7997,
    "mtime": "2026-11-27T03:25:13.101Z"
  },
  "style_frozen": true,
  "commit": "aff632b4af39a6a9f9feba4b59a66e2decc891f1"
}
```
<!-- /example:approve-asset -->

### `POST /api/projects/:id/approve/plan`

Body: `{ "pages": ["PG_001_001", ...] }`. Records that the person read and
approved those page plans. `"approved": false` withdraws it. An approval
holds for the plan as it is now: editing the page makes it stale, and
`pages.generate` then asks for it again.

<!-- example:approve-plan -->
```json
{
  "pages": [
    { "page": "PG_001_001", "approved": true },
    { "page": "PG_001_002", "approved": true },
    { "page": "PG_001_003", "approved": true }
  ]
}
```
<!-- /example:approve-plan -->

### `POST /api/projects/:id/approve/page`

Body: `{ "page": "PG_001_001" }`, with an optional `render` (default: the
current render). Sets the page to `approved` and records the approval on the
review. Approving a page that passed with notes accepts them: its open minor
findings become `accepted`, and their ids come back in `accepted_notes`.

<!-- example:approve-page -->
```json
{
  "page": "PG_001_001",
  "render": "PG_001_001_V02",
  "verdict": "fixed",
  "overruled": false,
  "accepted_notes": [],
  "status": "approved",
  "commit": "9d8f4e844a64b3801b605dcefdedd38b5b3d6ec7"
}
```
<!-- /example:approve-page -->

When the review of that render is flagged the answer is 409 `review_flagged`
with the open findings:

<!-- example:error-review-flagged -->
```json
{
  "error": {
    "code": "review_flagged",
    "message": "The check of PG_001_002_V03 is flagged with one open finding. Ask for a correction, or approve it anyway.",
    "params": {
      "detail": "The check of PG_001_002_V03 is flagged with 1 open finding(s). Ask for a correction, or approve it anyway with \"overrule\": true.",
      "render": "PG_001_002_V03",
      "n": 1
    },
    "details": {
      "findings": [
        {
          "id": "F01",
          "severity": "blocking",
          "expected": "The character matches the approved sheet.",
          "visible": "Placeholder finding forced by the word FLAG in the text."
        }
      ]
    }
  }
}
```
<!-- /example:error-review-flagged -->

The person can then ask for a correction, or approve anyway with
`"overrule": true` and an optional `note`. The open findings are recorded as
accepted by the person, a gate that had failed is set to pass, and the
reviewer's evidence stays in the file. 409 `review_incomplete` when nobody
has checked the render yet.

The overrule is data. The review object and the page and cover summaries
carry `overruled`, `overruled_at` and `overrule_note` (see
[`GET /api/projects/:id/pages/:page`](#get-apiprojectsidpagespage)). In the
review file it is kept in `notes`, the one free field the visual-review
schema has, as a tag followed by a sentence in the interface language:

```
[overruled 2026-11-26: F01!, gate narrative_continuity; note: "It reads fine to me."] Accepted by the person as drawn, against the review.
```

The tag lists what was overruled: finding ids, with `!` after a finding the
reviewer had recorded as blocking, and `gate <name>` for each gate that had
failed. The note is a JSON string, at most 300 characters. A review
overruled by an earlier version of the studio, which wrote a plain sentence,
is read the same way.

<!-- example:approve-page-overrule -->
```json
{
  "page": "PG_001_002",
  "render": "PG_001_002_V03",
  "verdict": "fixed",
  "overruled": true,
  "accepted_notes": [],
  "status": "approved",
  "commit": "cdff757b1687b6d4f6dbe6c69c6d1945e59a18e0"
}
```
<!-- /example:approve-page-overrule -->

The review of that render afterwards, and the summary of the page in
`GET .../issues/:issue`:

<!-- example:review-overruled -->
```json
{
  "path": "issues/ISS_001/pages/PG_001_002/reviews/PG_001_002_V03.review.yaml",
  "verdict": "fixed",
  "outcome": "pass",
  "passes": true,
  "independent": true,
  "reviewer": "visual-reviewer",
  "repair_cycle": 2,
  "reviewed_at": "2026-11-27",
  "supersedes": "PG_001_002_V02",
  "human_approval": { "status": "approved", "by": "person", "at": "2026-11-27" },
  "gates": { "style_fidelity": "pass", "narrative_continuity": "pass" },
  "checks": {
    "identity": {
      "result": "pass",
      "evidence": "Placeholder evidence for identity: the fake reviewer does not look at pixels."
    },
    "cast_count": {
      "result": "pass",
      "evidence": "Placeholder evidence for cast count: the fake reviewer does not look at pixels."
    },
    "...": "12 more"
  },
  "findings": [
    {
      "id": "F01",
      "panel": "PN_001_002_01",
      "check": "identity",
      "expected": "The character matches the approved sheet.",
      "visible": "Placeholder finding forced by the word FLAG in the text.",
      "severity": "minor",
      "repair": "Redraw the figure from the approved sheet and keep everything else as it is.",
      "status": "accepted"
    }
  ],
  "open_findings": 0,
  "open_blocking": 0,
  "open_notes": 0,
  "accepted_notes": 1,
  "overruled": true,
  "overruled_at": "2026-11-27",
  "overrule_note": "It reads fine to me.",
  "overruled_items": ["F01!"],
  "change_requests": 0,
  "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee. [overruled 2026-11-27: F01!; note: \"It reads fine to …"
}
```
<!-- /example:review-overruled -->

<!-- example:page-summary-overruled -->
```json
{
  "id": "PG_001_002",
  "number": 2,
  "scene": "SC_001_01",
  "purpose": "FLAGALWAYS Nobody answers.",
  "status": "approved",
  "panels": 3,
  "plan_approved": true,
  "current_render": "PG_001_002_V03",
  "renders": 3,
  "image": {
    "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png",
    "url": "/api/projects/overlay-letters/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png?v=7gcmwyf5tae",
    "width": 600,
    "height": 900,
    "bytes": 9660,
    "mtime": "2026-11-27T03:26:00.326Z"
  },
  "verdict": "fixed",
  "outcome": "pass",
  "passes": true,
  "flagged": false,
  "open_findings": 0,
  "open_notes": 0,
  "accepted_notes": 1,
  "overruled": true,
  "overruled_at": "2026-11-27",
  "overrule_note": "It reads fine to me.",
  "repair_cycle": 2,
  "independent": true,
  "human_approval": "approved",
  "blockers": []
}
```
<!-- /example:page-summary-overruled -->

### `POST /api/projects/:id/approve/cover`

Body: `{ "issue": "ISS_001" }`, with an optional `render` (default: the newest
cover render) and the same `overrule` and `note` as a page. Sets `cover.yaml`
to `approved` with that render, which then ships as the first page of every
edition.

<!-- example:approve-cover -->
```json
{
  "issue": "ISS_001",
  "cover": "CV_001",
  "render": "CV_001_V03",
  "previous": null,
  "verdict": "fixed",
  "overruled": false,
  "accepted_notes": [],
  "status": "approved",
  "commit": "2f28ad7fccbe450ff30596111a74f28a2bbfb42e"
}
```
<!-- /example:approve-cover -->

## Deleting, merging and renaming

Each of these is one history commit, so History can bring back what it
removed or changed. The workspace checks (validate-workspace.js and
check-continuity.js) run before and after; the answer's `check` says
whether the edit added an error: `{ ok, new_errors: [{ check, code, file,
message }], errors }`. Errors that were there before do not count. These are
checks of the files, never of a drawing.

What can be deleted, and when it is refused:

| Kind | IDs | Removed with it | Refused when |
|---|---|---|---|
| `asset` | A sheet candidate or master, a look page, a reference photo filed for an entity (`CHAR_MARA_TURN_V02`, `LOOK_NOIR_INK_V03`, `CHAR_MARA_REF_V01`) | The image, its registry entry, its generation record and request, the references in the entity file, its outfits and `project.yaml`, its identity check. A master takes the try it was approved from. | Pages or a cover were drawn from it (`drawn_from`); a planned page lists it (`planned_reference`); it is the try a master was approved from (`promoted`). |
| `render` | A page version (`PG_001_004_V02`) or a cover version (`CV_001_V01`) | The image, its lettered versions, its review, its generation record. A current version that goes sends the page back to the newest one left, or to not drawn. | An edition ships it (`in_edition`, `in_draft_edition`); it is the approved page or cover; another page uses it as its previous page (`render_reference`); the lettering is placed on it. |
| `upload` | `up_...` | The file and its index entry. Uploads are outside the history: this cannot be undone. | A queued or running job reads it. |
| `edition` | `ED_001_02` | The edition directory with its exports. | It is not a draft; a later edition builds on it. |
| `entity` | `CHAR_MARA`, `LOC_DOCK`, `PROP_FLARE_GUN` | Its directory, registry entries and generation records; mentions in other characters' `visually_adjacent_to` and in maps' `leads_to`. The story bible is left to the person. | A page, scene or cover still names it (`entity_in_use`). |
| `page` | The last page of an issue | Its directory and generation records; the page before it ends the chain, scenes and beats drop it, `page_count`, `panel_count` and the series plan follow. | It is not the last page, so numbers would have gaps (`page_not_last`); an edition ships it. |

Deleting an approved master, a whole entity with approved sheets, or a page
with drawn versions asks twice: the first request answers 409
`delete_confirm_twice` with what depends on it in `details.items[].dependents`,
and the same request with `"confirm_master": true` deletes. A thing a job is
working on right now is refused with `job_running`.

### `POST /api/projects/:id/delete/check`

Body: `{ "items": [{ "id": "<ID>", "kind": "<kind>" }] }` (`kind` is read
from the ID when left out). Writes nothing. Answers, per item, what a delete
would remove (`files`), whether it is `deletable`, the reason when it is
`refused` (`{ code, message }`), `confirm_twice` with the `dependents`,
notes, and `undo`: `history`, or `none` for an upload. `label`,
`entity`, `sheet`, `version` and `owner` let a screen name the thing.

<!-- example:delete-check -->
```json
{
  "items": [
    {
      "kind": "asset",
      "id": "CHAR_MARA_EXPR_V02",
      "label": "Mara",
      "image": {
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V02.png",
        "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V02.png?v=8bpmwyf5hue",
        "width": 900,
        "height": 900,
        "bytes": 10789,
        "mtime": "2026-11-27T03:25:45.494Z"
      },
      "status": "candidate",
      "entity": "CHAR_MARA",
      "sheet": "expressions",
      "version": 2,
      "owner": null,
      "deletable": true,
      "refused": null,
      "confirm_twice": false,
      "dependents": [],
      "notes": [],
      "files": [
        "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V02.png",
        "generations/CHAR_MARA/GEN_CHAR_MARA_03.yaml",
        "generations/CHAR_MARA/GEN_CHAR_MARA_03.request.json"
      ],
      "undo": "history"
    },
    {
      "kind": "asset",
      "id": "CHAR_MARA_TURN_MASTER_V01",
      "label": "Mara",
      "image": {
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png",
        "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png?v=8bpmwyf4v8t",
        "width": 900,
        "height": 900,
        "bytes": 10789,
        "mtime": "2026-11-27T03:25:16.205Z"
      },
      "status": "approved",
      "entity": "CHAR_MARA",
      "sheet": "turnaround",
      "version": 1,
      "owner": null,
      "deletable": false,
      "refused": {
        "code": "drawn_from",
        "message": "Pages were drawn from it (CV_001, PG_001_001, PG_001_002, PG_001_003). Those pages keep what they were drawn from, so it stays.",
        "message_code": "delete.refused.drawn_from",
        "message_params": { "pages": "CV_001, PG_001_001, PG_001_002, PG_001_003" }
      },
      "confirm_twice": false,
      "dependents": [],
      "notes": [],
      "files": [],
      "undo": "history"
    }
  ]
}
```
<!-- /example:delete-check -->

### `POST /api/projects/:id/delete`

Body: as above, plus `confirm_master`. Deletes every item in one commit, or
none: when one item is refused the answer is 409 `delete_refused` with
each refusal in `details.items`. Answers `{ deleted, files, check, commit,
can_undo }`.

<!-- example:delete -->
```json
{
  "deleted": [{ "kind": "asset", "id": "CHAR_MARA_EXPR_V02", "label": "Mara", "files": 3, "undo": "history" }],
  "files": [
    "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V02.png",
    "generations/CHAR_MARA/GEN_CHAR_MARA_03.request.json",
    "generations/CHAR_MARA/GEN_CHAR_MARA_03.yaml"
  ],
  "check": { "ok": true, "new_errors": [], "errors": 0 },
  "commit": "bbb6528b377aa7764fcb759feee4334710e1aef9",
  "can_undo": true
}
```
<!-- /example:delete -->

A refusal:

<!-- example:delete-refused -->
```json
{
  "error": {
    "code": "delete_refused",
    "message": "It cannot be deleted. Pages, scenes or covers still use it (CV_001, PG_001_001, PG_001_002, PG_001_003, SC_001_01). Take it out of them first, or merg…",
    "params": {
      "detail": "CHAR_MARA: Pages, scenes or covers still use it (CV_001, PG_001_001, PG_001_002, PG_001_003, SC_001_01). Take it out of them first, or merge it into a…",
      "reasons": [
        "Pages, scenes or covers still use it (CV_001, PG_001_001, PG_001_002, PG_001_003, SC_001_01). Take it out of them first, or merge it into another one."
      ]
    },
    "details": {
      "items": [
        {
          "kind": "entity",
          "id": "CHAR_MARA",
          "label": "Mara",
          "image": null,
          "status": null,
          "entity": null,
          "sheet": null,
          "version": null,
          "owner": null,
          "deletable": false,
          "refused": {
            "code": "entity_in_use",
            "message": "Pages, scenes or covers still use it (CV_001, PG_001_001, PG_001_002, PG_001_003, SC_001_01). Take it out of them first, or merge it into another one.",
            "message_code": "delete.refused.entity_in_use",
            "message_params": { "users": "CV_001, PG_001_001, PG_001_002, PG_001_003, SC_001_01" }
          },
          "confirm_twice": false,
          "dependents": [],
          "notes": [],
          "files": [],
          "undo": "history"
        }
      ]
    }
  }
}
```
<!-- /example:delete-refused -->

### `GET /api/projects/:id/cleanup`

`?scope=` one of `characters`, `places`, `style`, `character:<ID>`,
`location:<ID>`, `prop:<ID>`, `pages:<ISS_ID>` (also `check:`,
`corrections:`), `cover:<ISS_ID>`, `publish:<ISS_ID>`. Lists the unused
tries of that screen that can go now, each as in `delete/check` with a
`reason`: candidates of a sheet that has an approved master, older tries of
a sheet still waiting for a decision (the newest stays), superseded masters,
page and cover versions that are not current and nothing ships or cites,
draft editions a later edition replaced. Deleting them is one
`POST .../delete`.

<!-- example:cleanup -->
```json
{
  "scope": "character:CHAR_MARA",
  "items": [
    {
      "kind": "asset",
      "id": "CHAR_MARA_EXPR_V01",
      "label": "Mara",
      "image": {
        "path": "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png",
        "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png?v=8bpmwyf4xrs",
        "width": 900,
        "height": 900,
        "bytes": 10789,
        "mtime": "2026-11-27T03:25:19.480Z"
      },
      "status": "candidate",
      "entity": "CHAR_MARA",
      "sheet": "expressions",
      "version": 1,
      "owner": null,
      "deletable": true,
      "refused": null,
      "confirm_twice": false,
      "dependents": [],
      "notes": [],
      "files": ["characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png", "... 2 more"],
      "undo": "history",
      "reason": "an older try of a sheet still waiting for a decision",
      "reason_code": "cleanup.reason.older_try",
      "reason_params": {}
    }
  ]
}
```
<!-- /example:cleanup -->

### `POST /api/projects/:id/entities/merge`

Body: `{ "from": "CHAR_ORANGE_GREY", "into": "CHAR_GREY_HAIRED_MAN" }`.
`from` is the same person, place or object as `into`. Every reference to
`from` in the workspace and in the open story proposals names `into`;
`into` keeps its file and its sheets; the directory, registry entries and
generation records of `from` go; outfits of `from` that pages use become
the default outfit of `into` (or move into its wardrobe when it has none);
a panel, scene or bible list that names `into` twice keeps one entry; the
name of `from` becomes an alias of `into`. Undrawn pages that cited a
sheet of `from` lose their reference plan and prompt, which are built again
before drawing. When `into` has no file yet (the story bible or a proposal
names it), the merge is a rename and the answer says `renamed: true`.
Refused with 409 `merge_refused` when pages were drawn from a sheet of
`from`, and with 409 `project_busy` while a job runs.

<!-- example:entities-merge -->
```json
{
  "from": "CHAR_TEODORO_TWIN",
  "into": "CHAR_TEODORO",
  "renamed": false,
  "files": ["characters/CHAR_TEODORO/character.yaml"],
  "removed": ["characters/CHAR_TEODORO_TWIN"],
  "check": { "ok": true, "new_errors": [], "errors": 0 },
  "commit": "a701d8b7d9c80258fc337c79c70d3a680bc86734"
}
```
<!-- /example:entities-merge -->

### `POST /api/projects/:id/entities/rename`

Body: `{ "from": "CHAR_TEO", "to": "CHAR_TEODORO" }`. Every file name,
directory, asset ID and reference follows, in the workspace and in the open
story proposals and planner notes. Page plans that were approved stay
approved. 409 `entity_exists` when `to` already has a file (merge
instead), 404 `id_not_found` when `from` is used nowhere, 409
`project_busy` while a job runs.

<!-- example:entities-rename -->
```json
{
  "from": "CHAR_TEO",
  "to": "CHAR_TEODORO",
  "merged": false,
  "files": ["characters/CHAR_TEO/character.yaml", "characters/CHAR_TEO/wardrobe.yaml"],
  "moved": [["characters/CHAR_TEO", "characters/CHAR_TEODORO"]],
  "check": { "ok": true, "new_errors": [], "errors": 0 },
  "commit": "563f3809b00c99877ec65ec0814e24ccfe2b86a6"
}
```
<!-- /example:entities-rename -->

## Overlay lettering

Only for projects whose `lettering_mode` is `overlay`. The pages are drawn
without text. `lettering.apply` places the balloons and builds an SVG overlay
per page; the browser turns each overlay into a flat image and sends it back.

### `GET /api/projects/:id/pages/:page/lettering`

The overlay of a page as SVG text with the render embedded as a data URI, so
it can be drawn on a canvas without a second request. `?render=` picks a
render other than the current one.

| Field | Meaning |
|---|---|
| `ok` | `false` when the overlay cannot be built yet (no geometry, or a text that differs from `page.yaml`). `errors` says why. |
| `svg` | The SVG document, or `null`. |
| `width`, `height` | Canvas size in pixels (the project's page size). |
| `render` | The render the overlay sits on. |
| `elements` | Number of balloons, captions and sound effects. |
| `errors`, `warnings` | `[{ code, message }]` from `letter-pages.js`. A warning with code `overflow` means a text does not fit its balloon. |

```js
const { svg, width, height, render } = await (await fetch(`${base}/pages/${page}/lettering`)).json();
const img = new Image();
img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
await img.decode();
const canvas = Object.assign(document.createElement('canvas'), { width, height });
canvas.getContext('2d').drawImage(img, 0, 0, width, height);
const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
await fetch(`${base}/pages/${page}/lettered?render=${render}`, { method: 'POST', body: png });
```

<!-- example:lettering-get -->
```json
{
  "page": "PG_001_001",
  "render": "PG_001_001_V01",
  "ok": true,
  "svg": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"2000\" height=\"3000\" viewBox=\"0 0 2000 3000\">\n  <title>PG_001_001 lettering overlay on PG_001_001_V01</title>\n  <image x=\"0\" y=\"0\" w…",
  "width": 2000,
  "height": 3000,
  "elements": 2,
  "errors": [],
  "warnings": [],
  "note": "Draw this SVG on a canvas at its width and height, export a PNG, and send it back to store the lettered page.",
  "note_code": "note.lettering_svg",
  "note_params": {}
}
```
<!-- /example:lettering-get -->

### `POST /api/projects/:id/pages/:page/lettered`

`?render=<render id>`, with the PNG or JPEG bytes as the body (at most 60 MB).
Stores the lettered page next to its render through `registerLetteredFile`
and lists it in every draft edition that ships that render. Answers 201.

<!-- example:lettered-post -->
```json
{
  "page": "PG_001_001",
  "render": "PG_001_001_V01",
  "path": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png",
  "image": {
    "path": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png",
    "url": "/api/projects/overlay-letters/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png?v=39hmwyf5v2c",
    "width": 400,
    "height": 600,
    "bytes": 4229,
    "mtime": "2026-11-27T03:26:02.628Z"
  },
  "editions": [],
  "commit": "579b1790244d1d926b0ce6a029975a69d503d811"
}
```
<!-- /example:lettered-post -->

## Operations reference

Start any of these with `POST /api/projects/:id/ops`. Each section gives the
parameters, the steps the job lists, and the `result` of a finished job.
The examples have three parts: `params` (as stored on the job, after
checking), `steps`, and `result`.

Which tool runs a step depends on the settings: `plan` steps go to the plan
driver, `look` steps to the look driver, `draw` steps to Codex through the
scaffold's `codex-cli` provider.

### `project.setup`

Deprecated: use [`story.draft`](#storydraft). It is kept for older clients
and is queued by `POST /api/projects` only with `"setup": true`. It no longer
writes the story: it saves the description as `story/source/description.md`
(and, when the story bible is still the template or the empty starter, writes
the starter story files as `POST /api/projects` does), then asks for a draft
of the story bible as a proposal, exactly like `story.draft`.

| Param | Type | Meaning |
|---|---|---|
| `description` | string, required | What the comic is about. Saved as `story/source/description.md`, the person's source text. |
| `pages` | integer 1 to 200 | Page budget of the first issue, for the starter series plan. Default 4. |

Steps: `source`, `story` (plan, read-only: the draft), `check`. Result:
`summary`, `decisions`, `tool`, `proposal` (the id), `parts`, `files`
(always empty: the AI wrote nothing) and `problems`, what
`validate-workspace.js` reports.

<!-- example:op.project.setup -->
```json
{
  "params": { "description": "A lighthouse keeper finds a bottle with a map in it.", "pages": 1 },
  "steps": [
    { "id": "source", "label": "Save the description", "status": "done" },
    { "id": "story", "label": "Draft a story bible for you to review", "status": "done" },
    { "id": "check", "label": "Check the files", "status": "done" }
  ],
  "result": {
    "summary": "This is the fake assistant. It proposes 6 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "files": [],
    "tool": "claude",
    "proposal": "prop_202611270326035684b_9ff6",
    "parts": 7,
    "problems": []
  }
}
```
<!-- /example:op.project.setup -->

### `story.draft`

Reads the person's own text (the description and every text file under
`story/source/`) and proposes a story bible: premise, tone, world rules,
facts, character arcs, timeline events, and questions about what the text
leaves open. It writes no file: the run is read-only, and what comes back is
stored as a [proposal](#story-proposals). Facts the text states come with
provenance `source` and a `source_ref`; the AI is told not to add events,
explanations or endings the text does not state, and to ask instead.
Commands, for the method: source-analyze, story-bible.

| Param | Type | Meaning |
|---|---|---|
| `source` | string | One file under `story/source/` to draft from. Default: every text file there, the description first. |

409 `no_story_text` when the project has no text of the person's yet. Step:
`propose` (plan). It may pause with `needs_decision` when the AI cannot go on
without an answer. Result: `proposal` (the id), `parts`, `questions` (how
many parts are questions), `summary`, `decisions`, `tool`.

<!-- example:op.story.draft -->
```json
{
  "params": { "source": null },
  "steps": [{ "id": "propose", "label": "Read your text and draft a proposal", "status": "done" }],
  "result": {
    "proposal": "prop_2026112703250792503_9f1e",
    "parts": 9,
    "questions": 1,
    "summary": "This is the fake assistant. It proposes 6 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "tool": "claude"
  }
}
```
<!-- /example:op.story.draft -->

### `story.complete`

Proposes only what the story bible still lacks: an empty tone, no world
rules, no facts, characters with no arc, no timeline, and questions about
what the person's text leaves open. What is already there is not proposed
again. Read-only, like `story.draft`. No parameters. Step: `propose` (plan).
Result as in `story.draft`.

<!-- example:op.story.complete -->
```json
{
  "params": {},
  "steps": [{ "id": "propose", "label": "Propose what the story bible lacks", "status": "done" }],
  "result": {
    "proposal": "prop_2026112703250854706_b3e1",
    "parts": 2,
    "questions": 1,
    "summary": "This is the fake assistant. It proposes 2 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "tool": "claude"
  }
}
```
<!-- /example:op.story.complete -->

### `story.suggest`

A free request for story text, such as "suggest an ending". What the AI
proposes for it is invented, so its facts come with provenance `addition`;
it is a proposal like the others and nothing is written until the person
accepts it. Read-only.

| Param | Type | Meaning |
|---|---|---|
| `instruction` | string, required | What to propose, in the person's words. |

Step: `propose` (plan). Result as in `story.draft`.

<!-- example:op.story.suggest -->
```json
{
  "params": { "instruction": "Suggest an ending." },
  "steps": [{ "id": "propose", "label": "Write a proposal for your request", "status": "done" }],
  "result": {
    "proposal": "prop_2026112703250859408_7414",
    "parts": 3,
    "questions": 1,
    "summary": "This is the fake assistant. It proposes 3 kind(s) of story text for you to accept or reject.",
    "decisions": [],
    "tool": "claude"
  }
}
```
<!-- /example:op.story.suggest -->

### `story.update`

Applies a change the person states to the canon, or folds in a source text
they uploaded. It writes the story bible directly, because the words are the
person's: a change is a `user_change` fact, what a source states is a
`source` fact. The AI is told to add no `addition` fact here; where the
change would need invented story it adds an open question or pauses with
`needs_decision`. For story text the AI should write, use the proposal
operations below. Commands: source-analyze (with a source), story-bible,
series-plan.

| Param | Type | Meaning |
|---|---|---|
| `instruction` | string | What to change. |
| `source_upload` | string | Id of an uploaded text file. It is copied to `story/source/`. |

One of the two is required. Steps: `source` (only with an upload), `update`
(plan), `check`.

<!-- example:op.story.update -->
```json
{
  "params": { "instruction": "DECIDE whether the patrol knows the boy by name.", "source_upload": null },
  "steps": [
    { "id": "update", "label": "Update the story bible", "status": "done" },
    { "id": "check", "label": "Check the files", "status": "done" }
  ],
  "result": {
    "summary": "Updated the story bible with the change.",
    "decisions": ["Went with the answer given: The second way."],
    "files": ["story/story-bible.yaml"],
    "tool": "claude",
    "source": null,
    "problems": [],
    "continuity": []
  }
}
```
<!-- /example:op.story.update -->

### `style.define`

Writes the style bible, the colour script and the style block, and names the
look. Commands: ingest-references (with images), style-bible. Refused with
409 `style_frozen` once a look master is approved.

| Param | Type | Meaning |
|---|---|---|
| `preset` | string | `key` of a preset. Its style block is copied to `style/style-block.txt` and its colour mode set in `project.yaml`, as `templates/looks/README.md` describes. |
| `description` | string | The style in words. Where it differs from the preset, it wins. |
| `uploads` | string[] | Ids of uploaded reference images. They are filed under `references/style/` and registered. |
| `attach_references` | boolean | Default `true`: the uploaded images are attached to the look page as style references. `false`: they only inform the written style. |

At least one of `preset`, `description`, `uploads`. Steps: `prepare`, `bible`
(plan), `check`.

<!-- example:op.style.define -->
```json
{
  "params": {
    "preset": "noir-ink",
    "description": "Heavy ink and wet streets.",
    "uploads": ["up_202611270325090150a_53f0"],
    "attach_references": true
  },
  "steps": [
    { "id": "prepare", "label": "Apply the preset and file the reference images", "status": "done" },
    { "id": "bible", "label": "Write the style bible and the style block", "status": "done" },
    { "id": "check", "label": "Check the files", "status": "done" }
  ],
  "result": {
    "summary": "Wrote the style bible and the style block for LOOK_NOIR_INK.",
    "decisions": [],
    "files": ["style/style-block.txt", "style/style-bible.md", "... 1 more"],
    "tool": "claude",
    "look_id": "LOOK_NOIR_INK",
    "references": [{ "id": "LOOK_NOIR_INK_REF_V01", "path": "references/style/LOOK_NOIR_INK_REF_V01.png" }],
    "problems": []
  }
}
```
<!-- /example:op.style.define -->

### `style.look`

Compiles the look sheet and draws one look page candidate. No parameters.
409 `style_missing` before `style.define`. Steps: `compile`, `draw` (draw).
Approve the result with `POST .../approve/asset` and `result.candidate_id`.

<!-- example:op.style.look -->
```json
{
  "params": {},
  "steps": [
    { "id": "compile", "label": "Prepare the look page", "status": "done" },
    { "id": "draw", "label": "Draw the look page", "status": "done" }
  ],
  "result": {
    "look_id": "LOOK_NOIR_INK",
    "candidate": "references/style/LOOK_NOIR_INK_V01.png",
    "candidate_id": "LOOK_NOIR_INK_V01",
    "record": "GEN_LOOK_NOIR_INK_01",
    "tool": "codex"
  }
}
```
<!-- /example:op.style.look -->

### `character.create`

Writes a character and its wardrobe, then draws a turnaround candidate.
Commands: ingest-references (with photos), character-bible. 409
`character_exists` when the name is taken (`details.character` has the id).

| Param | Type | Meaning |
|---|---|---|
| `name` | string, required | The character id is `CHAR_` plus the name in capitals. |
| `description` | string | Who they are and what they look like. |
| `uploads` | string[] | Photos or drawings. They are filed under the character's `refs/` and registered as identity references. |
| `draw` | boolean | Default `true`: draw the turnaround sheet afterwards. |

`description` or `uploads` is required. Steps: `photos` (only with uploads),
`write` (plan), `sheet-compile`, `sheet-draw` (draw). Before a look master is
approved, or with no drawing tool, the two sheet steps are skipped and
`result.sheet` is `{ skipped: true, reason }`.

<!-- example:op.character.create -->
```json
{
  "params": {
    "name": "Mara",
    "description": "Ferry pilot in her fifties, grey cropped hair.",
    "uploads": ["up_202611270325142290l_24e7"],
    "draw": true,
    "character": "CHAR_MARA"
  },
  "steps": [
    { "id": "photos", "label": "File the photos", "status": "done" },
    { "id": "write", "label": "Write the character", "status": "done" },
    { "id": "sheet-compile", "label": "Prepare the turnaround sheet", "status": "done" },
    { "id": "sheet-draw", "label": "Draw the turnaround sheet", "status": "done" }
  ],
  "result": {
    "character": "CHAR_MARA",
    "summary": "Wrote the character file of Mara.",
    "decisions": [],
    "files": ["characters/CHAR_MARA/character.yaml", "characters/CHAR_MARA/wardrobe.yaml", "... 1 more"],
    "tool": "claude",
    "references": [{ "id": "CHAR_MARA_REF_V01", "path": "characters/CHAR_MARA/refs/CHAR_MARA_REF_V01.png" }],
    "sheet": {
      "candidate": "characters/CHAR_MARA/refs/CHAR_MARA_TURN_V01.png",
      "candidate_id": "CHAR_MARA_TURN_V01",
      "record": "GEN_CHAR_MARA_01",
      "kind": "turnaround"
    }
  }
}
```
<!-- /example:op.character.create -->

### `character.update`

Changes an existing character.

| Param | Type | Meaning |
|---|---|---|
| `character` | string, required | Character id. |
| `instruction` | string | What to change. |
| `uploads` | string[] | New photos or drawings. |
| `draw` | boolean | Default `false`. `true` draws a new turnaround candidate. |

Steps: `photos` (only with uploads), `write` (plan), and the two sheet steps
with `draw`.

<!-- example:op.character.update -->
```json
{
  "params": { "character": "CHAR_MARA", "instruction": "She has a broken nose.", "uploads": [], "draw": false },
  "steps": [{ "id": "write", "label": "Change the character", "status": "done" }],
  "result": {
    "character": "CHAR_MARA",
    "summary": "Updated the character file of Mara.",
    "decisions": [],
    "files": ["characters/CHAR_MARA/character.yaml", "story/story-bible.yaml"],
    "tool": "claude",
    "references": [],
    "sheet": null
  }
}
```
<!-- /example:op.character.update -->

### `character.sheet`

Draws one more sheet of a character, or the next version of its full
character sheet. The result is a candidate.

| Param | Type | Meaning |
|---|---|---|
| `character` | string, required | Character id. |
| `sheet` | string | `turnaround` (default), `model` (the full character sheet), `expressions` or `wardrobe`. |
| `outfit` | string | Wardrobe id, for a wardrobe sheet. Default: the character's default outfit. |
| `closeups` | string[] | `model` only. The labelled close-ups, one per line, `label: what it shows`. At most 8. Saved in the character file's `sheet` block. |
| `poses` | string[] | `model` only. The labelled expressions and poses. At most 8. Saved in the character file. |
| `revise` | string | `model` only. The version of the full sheet to change (`CHAR_MARA_MODEL_V01`, or `latest`). |
| `text` | string | With `revise`: what to change, in the person's words. |
| `region` | object | With `revise` and `text`: `{ x, y, w, h }` as fractions of the sheet, the part the change is about. |
| `changes` | object[] | With `revise`: several changes, each `{ text, region? }`. |
| `uploads` | string[] | With `revise`: new photos for this round, used for likeness only. |
| `update_file` | boolean | With `revise`. Default `true`: the character file is updated to match the changes first. |

The identity chain decides what each sheet is drawn from. Photos and
drawings the person uploaded are likeness sources: they go to the first
turnaround or full sheet only, while no drawn sheet is approved. The
approved turnaround or full sheet is the identity master (a full sheet
outranks a turnaround), and expressions and wardrobe sheets are drawn from
it. Without one they are refused with `409 master_required`.

Steps: `sheet-compile`, `sheet-draw` (draw), and `plan` first when
`closeups` or `poses` are given. A sheet drawn from the master is then
compared with it: `sheet-check` (look). When the check finds a different
person, `sheet-redraw` draws it once more with what the check found and
`sheet-recheck` compares again. The result carries `identity_check` (`pass`,
`flagged` or `not_checked`, with the findings) and, if the second drawing
still differs, a `warning`; `first_candidate` names the drawing that failed.

A revision has the steps `photos` (with uploads), `write` (plan, the
character file follows the change; a story fact the run tries to add
becomes a proposal), `sheet-compile` and `sheet-draw`. The previous version
is the edit target, and everything the changes do not name is locked. The
result names the version it came `from`.

Unlike `character.create`, a sheet that cannot be drawn fails the job
(`sheet_blocked`). `revise` names a version that does not exist: `409
revise_target_missing`.

<!-- example:op.character.sheet -->
```json
{
  "params": {
    "character": "CHAR_MARA",
    "sheet": "expressions",
    "outfit": null,
    "closeups": null,
    "poses": null,
    "revise": null,
    "changes": [],
    "uploads": [],
    "update_file": true
  },
  "steps": [
    { "id": "sheet-compile", "label": "Prepare the expressions sheet", "status": "done" },
    { "id": "sheet-draw", "label": "Draw the expressions sheet", "status": "done" },
    { "id": "sheet-check", "label": "Compare the new sheet with the approved one", "status": "done" }
  ],
  "result": {
    "character": "CHAR_MARA",
    "sheet": {
      "candidate": "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png",
      "candidate_id": "CHAR_MARA_EXPR_V01",
      "record": "GEN_CHAR_MARA_02",
      "kind": "expressions",
      "identity_check": {
        "verdict": "pass",
        "master": "CHAR_MARA_TURN_MASTER_V01",
        "findings": [],
        "redrawn": false,
        "at": "2026-11-27"
      }
    }
  }
}
```
<!-- /example:op.character.sheet -->

### `entities.derive`

Writes location and prop files for what the planned pages need. Commands:
location-bible, prop-bible. `pages.plan` already does this for the pages it
plans; use this operation to fill gaps or to draw plates.

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Limit the scope to one issue. |
| `text` | string | What happens, when the pages are not written yet. |
| `plates` | boolean | Default `false`. `true` draws a plate candidate for each location without an approved one; two steps per location are added, `<LOC_ID>:sheet-compile` and `<LOC_ID>:sheet-draw`. |

Steps: `write` (plan), then the plate steps.

<!-- example:op.entities.derive -->
```json
{
  "params": { "issue": "ISS_001", "text": "", "plates": false },
  "steps": [{ "id": "write", "label": "Write the places and objects", "status": "done" }],
  "result": {
    "summary": "Every place the pages use already has a file.",
    "decisions": [],
    "files": [],
    "tool": "claude",
    "locations": ["LOC_MAIN_ROOM"],
    "props": [],
    "plates": []
  }
}
```
<!-- /example:op.entities.derive -->

### `pages.plan`

From a text of what happens to planned pages. Commands: issue-breakdown, then
smart-page (layout, panel script, lettering text, ledger). The new pages are
appended after the issue's existing ones. The AI turns the person's text
into panels and is told to add no story event, line or reveal the text does
not have. What it has to fill in to make a page drawable (where figures
stand, who holds what, a background, a time of day) is listed in
`result.assumptions` as `[{ page, panel, text }]` (`panel` may be `null`),
and the page detail shows the same list as `assumptions`, so the person can
read it and change any of it.

| Param | Type | Meaning |
|---|---|---|
| `text` | string, required | What happens on these pages. |
| `pages` | integer 1 to 24 | How many pages to spend. Default 1. |
| `issue` | string | Default `ISS_001`. |

Steps: `breakdown` (plan), `pages` (plan), `gates` (the two mechanical
checks), `fix` (plan, only when the gates report errors), `recheck`, `ready`.

Result: `pages[]` with `id`, `number`, `purpose`, `panels` and `blockers`
(what each page still needs before it can be drawn), `fix_pass` (whether the
automatic fix ran), `continuity` and `validation` (what the gates report
after it) and `mechanical_errors`, their error count. Reference plans and
prompt packages are not written here; `pages.generate` builds them right
before it draws.

<!-- example:op.pages.plan -->
```json
{
  "params": {
    "issue": "ISS_001",
    "text": "Mara crosses the river alone at night. FLAG She hears the crates shift and goes down to the deck. NOTE She finds the boy and decides to hide him.",
    "pages": 3
  },
  "steps": [
    { "id": "breakdown", "label": "Break the text into scenes", "status": "done" },
    { "id": "pages", "label": "Write the page plans", "status": "done" },
    { "id": "gates", "label": "Check continuity and structure", "status": "done" },
    { "id": "fix", "label": "Fix what the checks found", "status": "skipped" },
    { "id": "recheck", "label": "Check again", "status": "skipped" },
    { "id": "ready", "label": "See what each page still needs", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "pages": [
      {
        "id": "PG_001_001",
        "number": 1,
        "purpose": "Mara crosses the river alone at night.",
        "panels": 3,
        "blockers": []
      },
      "... 2 more"
    ],
    "summary": "Planned 3 page(s) with three panels each.",
    "decisions": [],
    "tool": "claude",
    "assumptions": [
      {
        "page": "PG_001_001",
        "panel": null,
        "text": "Placeholder: the scene happens by day, because the text does not say when."
      },
      {
        "page": "PG_001_001",
        "panel": "PN_001_001_01",
        "text": "Placeholder: the figures stand left and right of the room and hold nothing, because the text does not say."
      },
      {
        "page": "PG_001_002",
        "panel": "PN_001_002_01",
        "text": "Placeholder: the figures stand left and right of the room and hold nothing, because the text does not say."
      },
      {
        "page": "PG_001_003",
        "panel": "PN_001_003_01",
        "text": "Placeholder: the figures stand left and right of the room and hold nothing, because the text does not say."
      }
    ],
    "fix_pass": false,
    "opens_from": null,
    "continuity": [],
    "validation": { "errors": [], "warnings": [] },
    "mechanical_errors": 0
  }
}
```
<!-- /example:op.pages.plan -->

### `pages.generate`

Draws pages in order. Per page: reference plan, prompt package, drawing,
review, and automatic repair while the review is flagged by a blocking
finding or a failed gate, says a repair can fix it, and the repair limit
allows. A page whose review has only minor findings passes with notes and is
not repaired. Commands: reference-plan, generate-pages,
visual-review, repair-page.

| Param | Type | Meaning |
|---|---|---|
| `pages` | string[] | Page IDs. Default: every page of `issue` without a passing render. |
| `issue` | string | Used when `pages` is absent. Default `ISS_001`. |
| `approve_plans` | boolean | Default `false`: plans have to be approved first (409 `plan_not_approved` with `details.pages`). `true` records the approval as part of this call. |
| `regenerate` | boolean | Default `false`: pages with a passing render are skipped. `true` draws a fresh version of them. |

Refused with 409 `no_draw_tool` when nothing can draw (use `page.manual`),
`look_not_approved` before a look master exists, `nothing_to_draw` when every
page already passed.

Steps, per page: `<PAGE_ID>:prepare`, `<PAGE_ID>:draw` (draw),
`<PAGE_ID>:review` (look). A repair adds `<PAGE_ID>:repair-<n>` (draw) and
`<PAGE_ID>:review-<n>` (look) after them. A page drawn panel by panel
(`generation.mode: per_panel`, see [`POST .../pages/:page/mode`](#post-apiprojectsidpagespagemode))
adds one `<PAGE_ID>:panel-<PANEL_ID>` step (draw) per panel after
`prepare`, each package carrying only that panel's references, and skips
`draw` and `review`: the scaffold has no compositor, so the page waits for
the person to put the panels together and upload the page with
`page.manual`, which is then reviewed.

When the drawing tool runs out of its usage quota, the job stops at the page
that met it and pauses (see [When a tool runs out of quota](#when-a-tool-runs-out-of-quota)):
the pages after it are not tried, and resuming draws only what is left.

Result: `pages[]`, one per page, with `render` (the last version), `verdict`,
`outcome` (`pass`, `notes` or `flagged`), `passes`, `flagged`, `repairs` (how many were tried), `open_findings`,
`independent` and `stopped` (why the repairs stopped, or `null`; its
`stopped_code` is `stopped.limit`, `stopped.upstream`,
`stopped.request_open`, `stopped.gate_no_finding` or `stopped.incomplete`).
A page that could not be drawn has `error: { code, message }` and the queue
goes on. A
page skipped because it already passed has `skipped: true`. `passed`,
`with_notes`, `flagged` and `failed` count them (`with_notes` is part of
`passed`). `to_assemble` lists the pages drawn panel by panel, whose
`pages[]` entry has `per_panel: true` and `panels: [{ panel, file, record }]`.

<!-- example:op.pages.generate -->
```json
{
  "params": { "pages": ["PG_001_001", "PG_001_002", "... 1 more"], "approve_plans": false, "regenerate": false },
  "steps": [
    { "id": "PG_001_001:prepare", "label": "Page 1: references and instruction", "status": "done" },
    { "id": "PG_001_001:draw", "label": "Page 1: draw", "status": "done" },
    { "id": "PG_001_001:review", "label": "Page 1: check", "status": "done" },
    { "id": "PG_001_002:prepare", "label": "Page 2: references and instruction", "status": "done" },
    { "id": "PG_001_002:draw", "label": "Page 2: draw", "status": "done" },
    { "id": "PG_001_002:review", "label": "Page 2: check", "status": "done" },
    { "id": "PG_001_002:repair-1", "label": "Page 2: repair 1", "status": "done" },
    { "id": "PG_001_002:review-1", "label": "Page 2: check repair 1", "status": "done" },
    { "id": "PG_001_003:prepare", "label": "Page 3: references and instruction", "status": "done" },
    { "id": "PG_001_003:draw", "label": "Page 3: draw", "status": "done" },
    { "id": "PG_001_003:review", "label": "Page 3: check", "status": "done" }
  ],
  "result": {
    "pages": [
      {
        "page": "PG_001_001",
        "render": "PG_001_001_V01",
        "verdict": "pass",
        "outcome": "pass",
        "passes": true,
        "open_findings": 0,
        "repairs": 0,
        "flagged": false,
        "independent": true,
        "stopped": null
      },
      {
        "page": "PG_001_002",
        "render": "PG_001_002_V02",
        "verdict": "fixed",
        "outcome": "pass",
        "passes": true,
        "open_findings": 0,
        "repairs": 1,
        "flagged": false,
        "independent": true,
        "stopped": null
      },
      "... 1 more"
    ],
    "passed": 3,
    "with_notes": 1,
    "flagged": 0,
    "failed": 0,
    "to_assemble": [],
    "tools": { "draw": "codex", "look": "claude" }
  }
}
```
<!-- /example:op.pages.generate -->

A page that still fails at the repair limit is left flagged, with every
version and review on disk:

<!-- example:result-flagged-page -->
```json
{
  "page": "PG_001_002",
  "render": "PG_001_002_V03",
  "verdict": "flagged",
  "outcome": "flagged",
  "passes": false,
  "open_findings": 1,
  "repairs": 2,
  "flagged": true,
  "independent": true,
  "stopped": "The repair limit of 2 was reached.",
  "stopped_code": "stopped.limit",
  "stopped_params": { "limit": 2 }
}
```
<!-- /example:result-flagged-page -->

### `page.review`

Runs the review again for one render of a page or a cover. A person's open
change requests on that render are kept.

| Param | Type | Meaning |
|---|---|---|
| `render` | string | Render id (`PG_001_002_V01` or `CV_001_V01`). |
| `page` | string | Page id: reviews its current render. Used when `render` is absent. |

Step: `review` (look). Result: `render`, `verdict`, `outcome`, `passes`,
`findings`, `open`, `open_blocking`, `independent`, `repair_cycle`, `file`,
`tool`, and `repairable` with `not_repaired_because` (whether an automatic
repair would run for this review, and why not).

<!-- example:op.page.review -->
```json
{
  "params": { "render": "PG_001_003_V01" },
  "steps": [{ "id": "review", "label": "Check the image against the plan", "status": "done" }],
  "result": {
    "render": "PG_001_003_V01",
    "verdict": "fixed",
    "outcome": "notes",
    "passes": true,
    "repairable": false,
    "not_repaired_because": null,
    "findings": 1,
    "open": 1,
    "open_blocking": 0,
    "independent": true,
    "file": "issues/ISS_001/pages/PG_001_003/reviews/PG_001_003_V01.review.yaml",
    "tool": "claude",
    "repair_cycle": 0
  }
}
```
<!-- /example:op.page.review -->

### `page.correct`

A change the person asks for on a drawn page. The request is recorded as a
finding (`source: user_request`) on the review of that render, and a new
version is made and reviewed.

| Param | Type | Meaning |
|---|---|---|
| `page` | string, required | Page id. |
| `text` | string, required | What to change. |
| `render` | string | The render the request is about. Default: the current render. |
| `panel` | string | Panel id the request is about. |
| `region` | object | `{ x, y, w, h }` as fractions of the page from its top-left corner, each between 0 and 1. |
| `lettering` | boolean | `true` when the request changes text in the image. |
| `mode` | string | `touch_up` or `redraw`: the person's choice once the image has reached the touch-up warning. |

Every edit of an image counts toward its `repair_cycle`, and each one
regenerates the whole image, so it wears a little more each round. Below the
project's touch-up warning (`repair_policy.touch_up_warning`, default 2) a
request is a touch-up. Once the render's `repair_cycle` has reached it, the
person chooses: without `mode` the request is refused with 409
`touch_up_choice`, whose `details` carry `render`, `touch_ups`, `warning`
and `modes`, so the screen can say what more edits may cost and offer both.
A touch-up the person chose may go past `repair_policy.max_cycles`: that
limit stops only the automatic repairs, and the automatic repairs after the
touch-up still keep it, so no loop runs on its own. `project.yaml` is not
changed. The job takes one of two paths, and says which in `result.path`
and in its steps:

- `edit` (`path_label_code`: `path.edit`). Steps: `request`,
  `compile`, `draw` (draw), `review` (look). The existing image is edited
  into the next version, with everything the request does not name locked.
- `redraw` (`path_label_code`: `path.redraw`). The person chose a redraw
  (`mode: "redraw"`). Steps: `request`, `plan` (plan),
  `compile`, `draw` (draw), `review` (look). The change is written into
  `page.yaml`, a fresh prompt is compiled, and the page is drawn again. The
  new render starts a new lineage (`repair_cycle` 0, `supersedes` null) and
  its review checks the requested change. The composition may differ from
  the earlier version, which the interface should tell the person.

`steps` are listed for the path that applies when the job is created.

Result: `page`, `from` (the render that was corrected), `finding` (id of the
recorded request), `path`, `path_label` (the path as a sentence for the
person), and the fields of a `pages.generate`
page (`render`, `verdict`, `outcome`, `passes`, `flagged`, `repairs`, `open_findings`,
`independent`, `stopped`).

<!-- example:op.page.correct -->
```json
{
  "params": {
    "page": "PG_001_001",
    "text": "The lamp over the wheel must be lit.",
    "render": "PG_001_001_V01",
    "panel": "PN_001_001_02",
    "region": { "x": 0.1, "y": 0.5, "w": 0.3, "h": 0.2 },
    "lettering": false,
    "path": "edit"
  },
  "steps": [
    { "id": "request", "label": "Record your request", "status": "done" },
    { "id": "compile", "label": "Prepare the correction", "status": "done" },
    { "id": "draw", "label": "Edit the existing page", "status": "done" },
    { "id": "review", "label": "Check the corrected page", "status": "done" }
  ],
  "result": {
    "page": "PG_001_001",
    "from": "PG_001_001_V01",
    "finding": "F01",
    "path": "edit",
    "path_label": "The existing image was edited.",
    "path_label_code": "path.edit",
    "path_label_params": {},
    "render": "PG_001_001_V02",
    "verdict": "fixed",
    "outcome": "pass",
    "passes": true,
    "open_findings": 0,
    "repairs": 0,
    "flagged": false,
    "independent": true,
    "stopped": null
  }
}
```
<!-- /example:op.page.correct -->

The same operation when the person chose a redraw (`mode: "redraw"`):

<!-- example:op.page.correct.redraw -->
```json
{
  "params": {
    "page": "PG_001_002",
    "text": "The boy must wear his hood up.",
    "render": "PG_001_002_V02",
    "panel": null,
    "region": null,
    "lettering": false,
    "mode": "redraw",
    "path": "redraw"
  },
  "steps": [
    { "id": "request", "label": "Record your request", "status": "done" },
    { "id": "plan", "label": "Redraw chosen: put the change into the plan of the page", "status": "done" },
    { "id": "compile", "label": "Prepare a new drawing", "status": "done" },
    { "id": "draw", "label": "Draw the page again from the changed plan", "status": "done" },
    { "id": "review", "label": "Check the new page", "status": "done" }
  ],
  "result": {
    "page": "PG_001_002",
    "from": "PG_001_002_V02",
    "finding": "F02",
    "path": "redraw",
    "path_label": "It was drawn again from the changed plan.",
    "path_label_code": "path.redraw",
    "path_label_params": {},
    "render": "PG_001_002_V03",
    "verdict": "fixed",
    "outcome": "pass",
    "passes": true,
    "open_findings": 0,
    "repairs": 0,
    "flagged": false,
    "independent": true,
    "stopped": null
  }
}
```
<!-- /example:op.page.correct.redraw -->

### `page.manual`

The handoff for an image the person makes outside the studio, for a page, a
cover or a reference sheet. It is the way to work with no drawing tool.

It is also how a page drawn panel by panel becomes a page: the person puts
the panel images together in the layout of the plan and uploads the result.
For such a page the package of the upload lists every reference of the page
with no budget, since no tool receives them, so the review compares the page
with all of them.

| Param | Type | Meaning |
|---|---|---|
| `page` | string | Page id. Exactly one of `page`, `cover`, `entity`. |
| `cover` | string | Issue id whose cover this is about. |
| `entity` | string | Entity id, with `sheet`. |
| `sheet` | string | `turnaround`, `expressions`, `wardrobe`, `plate`, `prop` or `look`. |
| `outfit` | string | Wardrobe id, for a wardrobe sheet. |
| `repair` | boolean | Page or cover: prepare a repair of the current render from its open findings. |
| `upload` | string | Id of the uploaded image to store. |

Without `upload` the job has one step, `prepare`, and `result.handoff` holds
what the person needs: `prompt`, `negative_prompt`, `aspect_ratio`,
`resolution`, `images[]` (the references to attach, in order, each with
`position`, `role`, `asset_id`, `path` and `image`), `instructions`,
`output_path`, and the paths of the `package`, the `record` and the `request`
file.

<!-- example:op.page.manual -->
```json
{
  "params": {
    "page": "PG_001_001",
    "cover": null,
    "entity": null,
    "sheet": null,
    "outfit": null,
    "repair": false,
    "upload": null
  },
  "steps": [{ "id": "prepare", "label": "Prepare the instruction and the references for page 1", "status": "done" }],
  "result": {
    "handoff": {
      "target": { "page": "PG_001_001", "cover": null, "entity": null, "sheet": null },
      "mode": "generate",
      "prompt": "Comic book page, ink line and flat colour, paged layout.\nLine: even contour of medium weight, closed shapes.\nBlacks and shadow: small areas of solid black, hard shadow edges, no hatching.\nTone: none.\nColor: flat colour, a limited palette.\nR…",
      "negative_prompt": "watermark, signature, page number, extra panels, duplicated characters, merged bodies",
      "aspect_ratio": "2:3",
      "resolution": "2000x3000",
      "images": [
        {
          "position": 1,
          "role": "style",
          "asset_id": "LOOK_SOFT_PENCIL_WARM_MASTER_V01",
          "path": "references/style/LOOK_SOFT_PENCIL_WARM_MASTER_V01.png",
          "image": {
            "path": "references/style/LOOK_SOFT_PENCIL_WARM_MASTER_V01.png",
            "url": "/api/projects/by-hand/raw/references/style/LOOK_SOFT_PENCIL_WARM_MASTER_V01.png?v=34omwyf5wvg",
            "width": 400,
            "height": 600,
            "bytes": 4056,
            "mtime": "2026-11-27T03:26:04.972Z"
          }
        },
        {
          "position": 2,
          "role": "identity",
          "asset_id": "CHAR_NELL_TURN_MASTER_V01",
          "path": "characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png",
          "image": {
            "path": "characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png",
            "url": "/api/projects/by-hand/raw/characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png?v=2dtmwyf5y95",
            "width": 400,
            "height": 400,
            "bytes": 3089,
            "mtime": "2026-11-27T03:26:06.761Z"
          }
        }
      ],
      "instructions": "Manual generation. 1) Upload the images in body.images in the listed order; the prompt calls them Image 1, Image 2, and so on, and each has one role. If the tool takes fewer images than listed, stop and rebuild the reference plan for a smal…",
      "output_path": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png",
      "package": "issues/ISS_001/pages/PG_001_001/prompts/manual.yaml",
      "record": "generations/PG_001_001/GEN_PG_001_001_01.yaml",
      "request": "generations/PG_001_001/GEN_PG_001_001_01.request.json"
    }
  }
}
```
<!-- /example:op.page.manual -->

With `upload` the steps are `prepare`, `store` and, for a page or a cover,
`review` (look). The image becomes the next render or candidate version
through the same naming as a generated one. Its generation record has
provider `manual` and says a person supplied it. `result.reviewed` is `false`
when no tool is installed to check it.

<!-- example:op.page.manual.upload -->
```json
{
  "params": {
    "page": "PG_001_001",
    "cover": null,
    "entity": null,
    "sheet": null,
    "outfit": null,
    "repair": false,
    "upload": "up_202611270326089874w_c176"
  },
  "steps": [
    { "id": "prepare", "label": "Prepare page 1", "status": "done" },
    { "id": "store", "label": "Store the uploaded image", "status": "done" },
    { "id": "review", "label": "Check the image", "status": "done" }
  ],
  "result": {
    "page": "PG_001_001",
    "cover": null,
    "record": "GEN_PG_001_001_02",
    "supplied_by": "person",
    "reviewed": true,
    "render": "PG_001_001_V01",
    "verdict": "pass",
    "outcome": "pass",
    "passes": true,
    "repairable": false,
    "not_repaired_because": null,
    "findings": 0,
    "open": 0,
    "open_blocking": 0,
    "independent": true,
    "file": "issues/ISS_001/pages/PG_001_001/reviews/PG_001_001_V01.review.yaml",
    "tool": "claude",
    "repair_cycle": 0
  }
}
```
<!-- /example:op.page.manual.upload -->

The refusal that points to this operation:

<!-- example:error-no-draw-tool -->
```json
{
  "error": {
    "code": "no_draw_tool",
    "message": "Codex is not installed, and it is the only tool here that draws. You can make the image yourself: the studio prepares the instruction and the referenc…",
    "params": {
      "detail": "Codex is not installed, and it is the only tool here that draws. You can make the image yourself: the studio prepares the instruction and the referenc…",
      "reason": "Codex is not installed, and it is the only tool here that draws."
    }
  }
}
```
<!-- /example:error-no-draw-tool -->

### `cover.create`

The optional cover of an issue. Command: cover. What the job does depends on
whether the issue already has a `cover.yaml` and on `description`:

| `cover.yaml` | `description` | What happens |
|---|---|---|
| missing | given | The cover is written from the description, then drawn and checked. |
| missing | empty | The AI proposes a cover and writes it, then it is drawn and checked. |
| exists | given | `cover.yaml` is rewritten from the description, then drawn and checked. |
| exists | empty | The cover is drawn as it is written and checked. The job has no `write` step and no planning tool runs, so a cover edited by hand is drawn as the person left it. |

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Default `ISS_001`. |
| `description` | string | What the cover shows. See the table above for an empty one. |
| `draw` | boolean | Default `true`. `false` writes `cover.yaml` only. |

Steps: `write` (plan), `compile`, `draw` (draw), `review` (look), with repair
steps `repair-<n>` and `review-<n>` as for a page. The `write` step is left
out when the existing cover is drawn as written. The drawing steps are
skipped, with `result.drawn: false` and a `reason`, before a look master
exists or with no drawing tool. Approve the result with
`POST .../approve/cover`.

`result.written` says whether this job wrote `cover.yaml`. 409
`nothing_to_do` when the cover exists, no description is given and `draw`
is `false`.

<!-- example:op.cover.create -->
```json
{
  "params": {
    "issue": "ISS_001",
    "description": "Mara at the wheel at night, the river behind her.",
    "draw": true,
    "write": true
  },
  "steps": [
    { "id": "write", "label": "Write the cover", "status": "done" },
    { "id": "compile", "label": "Prepare the cover", "status": "done" },
    { "id": "draw", "label": "Draw the cover", "status": "done" },
    { "id": "review", "label": "Check the cover", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "written": true,
    "summary": "Wrote the cover of ISS_001.",
    "decisions": [],
    "drawn": true,
    "render": "CV_001_V01",
    "verdict": "pass",
    "outcome": "pass",
    "passes": true,
    "open_findings": 0,
    "repairs": 0,
    "flagged": false,
    "independent": true,
    "stopped": null
  }
}
```
<!-- /example:op.cover.create -->

The same operation with no parameters, once the cover exists:

<!-- example:op.cover.create.existing -->
```json
{
  "params": { "issue": "ISS_001", "description": "", "draw": true, "write": false },
  "steps": [
    { "id": "compile", "label": "Prepare the cover", "status": "done" },
    { "id": "draw", "label": "Draw the cover", "status": "done" },
    { "id": "review", "label": "Check the cover", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "written": false,
    "summary": null,
    "decisions": [],
    "drawn": true,
    "render": "CV_001_V02",
    "verdict": "pass",
    "outcome": "pass",
    "passes": true,
    "open_findings": 0,
    "repairs": 0,
    "flagged": false,
    "independent": true,
    "stopped": null
  }
}
```
<!-- /example:op.cover.create.existing -->

### `cover.correct`

A change the person asks for on a drawn cover. Same two paths and the same
result as `page.correct`; on the `redraw` path the change is written into
`cover.yaml`. A request on an approved cover withdraws its approval.

Steps on the `edit` path: `request`, `compile`, `draw` (draw), `review`
(look). On the `redraw` path: `request`, `plan` (plan), `compile`, `draw`
(draw), `review` (look).

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Default `ISS_001`. |
| `text` | string, required | What to change. |
| `render` | string | Default: the newest cover render. |
| `region` | object | `{ x, y, w, h }` as fractions of the image. |
| `lettering` | boolean | `true` when the request changes text in the image. |
| `mode` | string | `touch_up` or `redraw`, as for `page.correct`: required once the cover has reached the touch-up warning. |

<!-- example:op.cover.correct -->
```json
{
  "params": {
    "issue": "ISS_001",
    "render": "CV_001_V02",
    "text": "Make the title larger.",
    "region": null,
    "lettering": true,
    "path": "edit"
  },
  "steps": [
    { "id": "request", "label": "Record your request", "status": "done" },
    { "id": "compile", "label": "Prepare the correction", "status": "done" },
    { "id": "draw", "label": "Edit the existing cover", "status": "done" },
    { "id": "review", "label": "Check the corrected cover", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "from": "CV_001_V02",
    "finding": "F01",
    "path": "edit",
    "path_label": "The existing image was edited.",
    "path_label_code": "path.edit",
    "path_label_params": {},
    "render": "CV_001_V03",
    "verdict": "fixed",
    "outcome": "pass",
    "passes": true,
    "open_findings": 0,
    "repairs": 0,
    "flagged": false,
    "independent": true,
    "stopped": null
  }
}
```
<!-- /example:op.cover.correct -->

### `lettering.apply`

Overlay lettering. Command: lettering. 409 `not_overlay` for a project that
letters in the image.

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Default `ISS_001`. |
| `pages` | string[] | Default: every page of the issue that has a render. |

Steps: `place` (plan; skipped when every page already has its geometry for
its current render), `overlay`. Result: `pages[]` with `page`, `ok`,
`render`, `svg` (path of the overlay), `elements`, `errors`, `warnings`.
Then the browser rasterizes each overlay (see
[Overlay lettering](#overlay-lettering)).

<!-- example:op.lettering.apply -->
```json
{
  "params": { "issue": "ISS_001", "pages": ["PG_001_001", "... 1 more"] },
  "steps": [
    { "id": "place", "label": "Place the balloons and captions", "status": "done" },
    { "id": "overlay", "label": "Build the lettering layers", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "pages": [
      {
        "page": "PG_001_001",
        "ok": true,
        "render": "PG_001_001_V01",
        "svg": "issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.svg",
        "elements": 2,
        "errors": [],
        "warnings": []
      },
      "... 1 more"
    ],
    "failed": 0
  }
}
```
<!-- /example:op.lettering.apply -->

### `publish.build`

Writes the edition of an issue from its current state and builds the chosen
formats with `build-edition.js`. Commands: continuity-review (its mechanical
gate), build-edition.

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Default `ISS_001`. |
| `formats` | string[] | Any of `pdf`, `cbz`, `epub`, `web`, `images`. Default `["pdf", "cbz"]`. |
| `mode` | string | `auto` (default): final when nothing blocks it, else a marked draft. `draft`: always a draft. `final`: fails with `not_ready` and `details.blockers` when something blocks it. |

Steps: `edition`, `gate`, `build`. When the issue ships exactly what its
latest edition ships, that edition is reused and only the missing formats are
built (`reused: true`); an existing export is never overwritten (`skipped`).
A final build marks the edition `reviewed`. Publishing stays the person's
decision.

Result: `edition`, `reused`, `draft`, `formats`, `written[]` and `skipped[]`
(`format`, `file`), `shipped[]` (`page`, `render`, `verdict`), `warnings`,
`blockers`. Fetch the files through `GET .../issues/:issue/publish`.

<!-- example:op.publish.build -->
```json
{
  "params": { "issue": "ISS_001", "formats": ["pdf", "cbz", "epub", "web", "images"], "mode": "auto" },
  "steps": [
    { "id": "edition", "label": "Write the edition", "status": "done" },
    { "id": "gate", "label": "Check continuity and reviews", "status": "done" },
    { "id": "build", "label": "Build the files", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "edition": "ED_001_01",
    "reused": false,
    "draft": false,
    "formats": ["pdf", "cbz", "epub", "web", "images"],
    "written": [
      { "format": "pdf", "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf" },
      { "format": "cbz", "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz" },
      { "format": "web", "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html" },
      { "format": "images", "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01-images.zip" },
      { "format": "epub", "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.epub" }
    ],
    "skipped": [],
    "shipped": [
      { "page": "CV_001", "render": "CV_001_V03", "verdict": "fixed" },
      { "page": "PG_001_001", "render": "PG_001_001_V02", "verdict": "fixed" },
      { "page": "PG_001_002", "render": "PG_001_002_V03", "verdict": "fixed" },
      { "page": "PG_001_003", "render": "PG_001_003_V01", "verdict": "fixed" }
    ],
    "warnings": [],
    "blockers": []
  }
}
```
<!-- /example:op.publish.build -->

### `chat.turn`

One message of the project conversation. It is started by
`POST .../conversation` (or the deprecated `POST .../chats/:key`), which
stores the person's message first; `POST .../ops` refuses it. Its parameters,
which that route fills in: `screen` (`{ key, label, route }`), `text` (the
message), `conversation` (the conversation id), `attachments` (upload ids
sent with the message), and `key`, the screen key again, kept for older
clients. Step: `reply` (plan). The reply may change the files of the
screen, never the story bible: story text comes back as a proposal, and a
reply that wrote the story bible anyway is undone inside the step and listed
in `reverted`. It may propose actions (`data.actions`) and run cards the
person confirmed (`data.run_actions`). When another job runs, the turn runs
in the read-only lane and changes nothing. Result:
`{ conversation, key, message, ran, read_only }` with the assistant's
message, its cards, and the cards it ran.

<!-- example:op.chat.turn -->
```json
{
  "params": {
    "key": "page:PG_001_003",
    "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
    "conversation": "conv_202611270325486752o_ae11",
    "text": "EDIT bring the last panel closer",
    "message": "msg_202611270325486782p_d134",
    "attachments": []
  },
  "steps": [{ "id": "reply", "label": "Answer the message", "status": "done" }],
  "result": {
    "conversation": "conv_202611270325486752o_ae11",
    "key": "page:PG_001_003",
    "message": {
      "id": "msg_202611270325492132s_eeb3",
      "at": "2026-11-27T03:25:49Z",
      "conversation": "conv_202611270325486752o_ae11",
      "role": "assistant",
      "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
      "job": "job_202611270325486812q_147a",
      "tool": "claude",
      "reply_to": "msg_202611270325486782p_d134",
      "screen": { "key": "page:PG_001_003", "label": "Page 3", "route": "/p/the-night-ferry/pages/PG_001_003" },
      "key": "page:PG_001_003",
      "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
      "commit": "24d5b776ee77eb5906bd7fbd500ee63502a1daaf",
      "decisions": [],
      "links": [],
      "proposal": null,
      "reverted": [],
      "story_proposal": null,
      "actions": [],
      "dropped": [],
      "read_only": false
    },
    "ran": [],
    "read_only": false,
    "guide": null
  }
}
```
<!-- /example:op.chat.turn -->

## Fake mode

With `STUDIO_FAKE_AI=1` (or `--fake`) no CLI is called. Every operation runs
its real path and finishes at once with placeholder texts and images, which
`validate-workspace.js` accepts. `GET /api/health` answers `fake: true`.
Words in the person's text change what the fake does, which makes every state
of the interface reachable:

| Word | Where | Effect |
|---|---|---|
| `DECIDE` | Any text that reaches a plan step | The step stops with `needs_decision` and one question, until answered. |
| `FAILAI` | Any text that reaches a plan step | The step reports a failure (`ai_reported_failure`). |
| `SLOW` | Any text that reaches a plan step | The step takes `STUDIO_FAKE_SLOW_MS` (default 3000 ms), long enough to cancel. |
| `FLAG` | The text of a page or a cover | Its first review is flagged with one blocking finding; the repair passes. |
| `FLAGALWAYS` | The text of a page or a cover | Every review is flagged, repairs included, up to the repair limit. |
| `UPSTREAM` | With `FLAG` | The flagged review says a repair cannot fix it, so none is tried. |
| `NOTE` | The text of a page or a cover | Its first review lists one minor finding. The page passes with a note (`outcome: notes`) and no repair is tried. |
| `FAILDRAW` | The text of a page | Drawing that page fails. |
| `SLOWDRAW` | The text of a page | Drawing that page takes `STUDIO_FAKE_SLOW_MS` (default 4000 ms). |
| `EDIT` | A chat message | The reply also changes the first file of the screen, never the story bible. |
| `PROPOSE` | A chat message | The reply comes with a proposal of one fact (`user_change`) and one question. |
| `LINK` | A chat message | The reply suggests three screens: Characters, and two that do not exist, which the server drops. |
| `SHEETFLAG` | A character's description | The first comparison of a sheet drawn from the approved sheet finds a different face, so the sheet is drawn once more. `SHEETFLAGALWAYS` fails every comparison. |
| `WRITEBIBLE` | A chat message, or a character's description | The run writes the story bible directly (a chat note, or an invented fact for a character), and the studio undoes it. A fact becomes a proposal. |
| `ACTION:<name> {params}` | A chat message | The reply proposes that action, with the JSON object that follows as its params. Several may follow one another. The words inside the params steer the action, not the chat turn. |
| `RUN` | A chat message | The reply runs every card waiting in the conversation, as a confirmation in words would. |
| `STATE` | A chat message | The reply repeats the project state it was given, which shows what the conversation knows. |
| (guide mode) | A chat message with no `ACTION` words that does not end with "?" | The reply takes it as the answer to the guide's step: it proposes the action the step expects, with the message as its text, and runs it. A character's name is the words before the first comma or colon. A message ending with "?" is a detour: it is answered and the step stays. `NOGUIDE` turns this off for one message. |
| `QUOTAAI` | Any text that reaches a plan or chat step | The writing tool answers with Claude Code's usage-limit wording and a reset time; the job pauses (`tool_quota`). |
| `QUOTADRAW` | The text of a page | Drawing it meets the drawing tool's usage limit, the way Codex answered in a real run. |
| `CROWD` | The text of `pages.plan` | Panel 1 draws three characters, panel 2 the next two, panel 3 the first two. With five characters the page needs more reference images than `codex-cli` takes, while each panel fits (`REFERENCE_BUDGET`). |

The proposal operations return placeholder parts built from the person's
text: a draft proposes a premise, a tone, a world rule, the first sentences
of the description as `source` facts, one `addition`, timeline events and a
question. When a chat turn starts a new session, the fake reply says how
many earlier messages its summary held.

The model lists of fake mode are fixed and marked `source: "fake"`: Claude
Code offers `fake-large` (the default) and `fake-fast`, Codex offers
`fake-codex` (the default) and `fake-codex-mini`.

`STUDIO_FAKE_TOOLS` lists the tools the fake reports as installed, for
example `STUDIO_FAKE_TOOLS=claude` to see the interface with no drawing tool.

The fake drawing tool runs out of quota while the file named by
`STUDIO_FAKE_QUOTA_FILE` exists (fake mode sets it to `.fake-quota` in the
studio home): create the file to run out, delete it to get the quota back. A
number in the file lets that many drawings through first, so a job can run
out in the middle.

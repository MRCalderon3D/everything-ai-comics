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
- [Chat](#chat)
- [History](#history)
- [Approvals](#approvals)
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

Every error has the same body. `details` is present only where a route
documents it.

<!-- example:error-404 -->
```json
{ "error": { "code": "page_not_found", "message": "PG_001_099 does not exist in this project." } }
```
<!-- /example:error-404 -->

| Status | Meaning |
|---|---|
| 400 | The request is malformed: a missing or invalid parameter (`bad_params`, `bad_path`, `bad_json`, `bad_settings`, `bad_options`, `bad_chat_key`, `unknown_operation`). |
| 403 | The `Host` or `Origin` check failed (`bad_host`, `bad_origin`). |
| 404 | The project, page, job, file, upload or other thing named in the request does not exist. |
| 405 | The method is not allowed on this route. |
| 409 | The request is well formed and the current state does not allow it. The code says why: `plan_not_approved`, `style_frozen`, `no_draw_tool`, `look_not_approved`, `review_flagged`, `job_finished`, `project_busy`, `file_changed`, and the refusal codes of the scaffold scripts such as `master_exists`. |
| 413 | The body is larger than the route allows (`too_large`). |
| 415 | The body is of a type the route does not take (`unsupported_media_type`, `unsupported_file`, `not_an_image`, `not_text`). |
| 422 | A YAML text does not parse (`yaml_parse`, `yaml_empty`, with `details.line`), or a workspace file read by a screen does not parse (`workspace_yaml`). |
| 500 | Something unexpected (`internal`). |
| 501 | The scaffold lacks a function the route needs (`scaffold_missing`). |

A 400 and a 409, as they come back:

<!-- example:error-400 -->
```json
{ "error": { "code": "bad_params", "message": "\"pages\" must be a whole number from 1 to 24." } }
```
<!-- /example:error-400 -->

<!-- example:error-409 -->
```json
{
  "error": {
    "code": "style_frozen",
    "message": "The look is approved and its style block is frozen: every page depends on it. A different style means a new project, or a new look defined by hand in …"
  }
}
```
<!-- /example:error-409 -->

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
  "reviewed_at": "2026-11-26",
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
  "change_requests": 0,
  "compared_against": { "references": ["LOOK_NOIR_INK_MASTER_V01", "CHAR_MARA_TURN_MASTER_V01"], "neighbors": ["PG_001_002_V02"] },
  "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
}
```
<!-- /example:review-notes -->

## Studio

### `GET /api/health`

Which tools are installed and what the server can do. `?refresh=1` looks for
the tools again instead of using the cached answer (the cache lasts one
minute).

| Field | Meaning |
|---|---|
| `version` | Version of the scaffold. |
| `fake` | `true` in fake mode: no AI tool is called. |
| `home` | The studio home, where projects live. |
| `git` | `{ installed, version }`. Without git, history is recorded and cannot be restored. |
| `tools.claude`, `tools.codex` | `{ installed, version }`. In fake mode `version` is `"fake"` and `fake` is `true`. |
| `draw.available` | `true` when Codex is installed and the scaffold has its `codex-cli` provider. `draw.manual` says the manual handoff exists. |
| `formats` | Export formats `publish.build` accepts. |
| `languages` | Interface languages the settings accept. |

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
    "claude": { "installed": true, "version": "fake", "fake": true },
    "codex": { "installed": true, "version": "fake", "fake": true }
  },
  "draw": { "available": true, "provider": "codex-cli", "manual": true },
  "formats": ["pdf", "cbz", "web", "images", "epub"],
  "languages": ["en", "es"]
}
```
<!-- /example:health -->

### `GET /api/ops`

The operations a job can run, with their parameters. The
[operations reference](#operations-reference) describes each one.

<!-- example:ops -->
```json
{
  "operations": [
    {
      "name": "project.setup",
      "title": "Set up the project",
      "summary": "Fills the project metadata and writes the story bible and the series plan from a description.",
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
      "summary": "Applies a change the person describes, or analyses an uploaded source text, and updates the story bible.",
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
    "... 16 more"
  ]
}
```
<!-- /example:ops -->

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
`lettering_style`, `palette`) and its `style_block`.

<!-- example:presets -->
```json
{
  "presets": [
    {
      "key": "ligne-claire",
      "file": "templates/looks/ligne-claire.yaml",
      "id": "LOOK_LIGNE_CLAIRE_V01",
      "look_id": "LOOK_LIGNE_CLAIRE",
      "name": "Ligne claire",
      "intent": "Adventure and travel stories where the setting matters as much as the cast. Everything is drawn with the same …",
      "color_mode": "full_color",
      "line": "One even line weight for figures and backgrounds alike. Contours always close. No line variation for depth.",
      "inking": "No hatching and almost no solid black. Black appears as flat local color (hair, a coat), never as shadow.",
      "tone": "None. Form comes from contour and flat color.",
      "rendering": "Cartoon-simplified faces on correctly proportioned bodies, set against detailed and accurate architecture, veh…",
      "lettering_style": "Upper case in rectangular balloons with slightly rounded corners and a thin outline. Captions in pale yellow b…",
      "palette": ["local colors, slightly muted, one flat value per object", "... 1 more"],
      "pairs_with": {
        "comic_formats": ["paged"],
        "publications": ["one-shot", "... 3 more"],
        "typical_genres": ["adventure", "... 3 more"]
      },
      "style_block": "Full-color comic book page in a ligne claire style.\nLine: a single even line weight for figures and background…"
    },
    "... 5 more"
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
        "aspect_ratio": "2:3",
        "width_px": 2000,
        "height_px": 3000,
        "formats": ["paged"]
      },
      {
        "id": "album-3-4",
        "label": "Album page 3:4",
        "aspect_ratio": "3:4",
        "width_px": 2100,
        "height_px": 2800,
        "formats": ["paged"]
      },
      {
        "id": "square",
        "label": "Square 1:1",
        "aspect_ratio": "1:1",
        "width_px": 2048,
        "height_px": 2048,
        "formats": ["paged"]
      },
      {
        "id": "scroll-9-16",
        "label": "Scroll segment 9:16",
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
      "logline": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
      "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
      "comic_format": "paged",
      "language": "en",
      "created_at": "2026-11-26",
      "updated_at": "2026-11-26T18:08:47.454Z",
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
a git repository in the project directory, and, when a description is given,
a `project.setup` job.

| Body field | Type | Meaning |
|---|---|---|
| `title` | string, required | At most 120 characters. The project id is its slug; a second project with the same title gets `-2`. |
| `description` | string | What the comic is about. With it, `project.setup` starts at once. |
| `format` | `paged` (default) or `webtoon` | Sets `comic_format`. A webtoon gets a 9:16 scroll segment. |
| `language` | string | Language of the comic, such as `en` or `es`. |
| `pages` | integer 1 to 200 | Page budget of the first issue. Default 4. |
| `options` | object | Any field of [`PUT .../options`](#put-apiprojectsidoptions) except `title` and `comic_format`. |
| `interface_language` | `en` or `es` | Language of the interface for this project. Default: the comic's language when it is one of the two, else `en`. |
| `setup` | boolean | `false` creates the project without starting `project.setup`. |

Answers 201 with the project card and the job (or `job: null`).

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
    "created_at": "2026-11-26",
    "updated_at": "2026-11-26T18:08:47.034Z",
    "image": null,
    "counts": { "pages": 0, "rendered": 0, "passed": 0 },
    "busy": true
  },
  "job": {
    "id": "job_2026112618084703102_f9d2",
    "project": "the-night-ferry",
    "op": "project.setup",
    "title": "Set up the project",
    "params": {
      "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
      "pages": 3
    },
    "status": "queued",
    "created_at": "2026-11-26T18:08:47Z",
    "started_at": null,
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "source",
        "label": "Save the description",
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
        "id": "story",
        "label": "Write the story bible and the series plan",
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
        "id": "check",
        "label": "Check the files",
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
    "cost_usd": null
  }
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
| `screens[].summary` | One sentence for the person. |
| `screens[].blockers` | `[{ code, message, page? }]`: what has to happen first. |
| `screens[].counts` | Numbers for the screen (pages planned, drawn, flagged, and so on). |
| `screens[].next` | `true` on the screen `next` points at. |
| `next` | `{ screen, summary }`: the first required screen that is not done, or `null` when everything is. |
| `issues` | The issues, as in `GET .../issues`. `first_issue` is the id to open by default. |
| `look` | `{ id, approved }`. |
| `repair_limit` | Repair cycles the studio spends on its own before it leaves a page flagged. |
| `history.git` | `true` when earlier states can be restored. |
| `active_jobs` | Jobs that are queued, running, or waiting for an answer. |

<!-- example:overview -->
```json
{
  "project": {
    "id": "the-night-ferry",
    "title": "The Night Ferry",
    "logline": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
    "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
    "comic_format": "paged",
    "language": "en",
    "created_at": "2026-11-26",
    "updated_at": "2026-11-26T18:08:59.587Z",
    "image": {
      "path": "issues/ISS_001/cover/renders/CV_001_V02.png",
      "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V02.png?v=6xgmwxv9fvw",
      "width": 600,
      "height": 900,
      "bytes": 8980,
      "mtime": "2026-11-26T18:08:57.260Z"
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
    "repair_limit": null
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
      "blockers": [],
      "counts": { "facts": 3 }
    },
    {
      "key": "style",
      "status": "done",
      "summary": "The look is approved and the style is frozen.",
      "blockers": [],
      "counts": { "candidates": 1 }
    },
    "... 7 more"
  ],
  "next": null,
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
        "approved_render": "CV_001_V02",
        "renders": 2,
        "current_render": "CV_001_V02",
        "image": {
          "path": "issues/ISS_001/cover/renders/CV_001_V02.png",
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V02.png?v=6xgmwxv9fvw",
          "width": 600,
          "height": 900,
          "bytes": 8980,
          "mtime": "2026-11-26T18:08:57.260Z"
        },
        "verdict": "fixed",
        "outcome": "pass",
        "open_findings": 0,
        "passes": true
      }
    }
  ],
  "first_issue": "ISS_001",
  "look": { "id": "LOOK_NOIR_INK", "approved": true },
  "repair_limit": 1,
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
  "trash": ".trash/overlay-letters-20261126180905",
  "note": "The project was moved to the trash folder of the studio home. Nothing was erased."
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
| `settings.models` | Model per driver and verb, or `null` for the tool's default: `claude.plan`, `claude.look`, `codex.plan`, `codex.look`, `codex.draw`. |
| `settings.repair_limit` | `null`, or a number from 0 to 10 that stops the automatic repairs earlier than the project's own limit. It never raises that limit. |
| `tools` | The resulting assignment, as in the project home. |
| `installed` | `{ claude, codex }` as in `GET /api/health`. |
| `choices`, `languages` | What each field accepts. |

<!-- example:settings -->
```json
{
  "settings": {
    "language": "en",
    "drivers": { "plan": "claude", "look": "claude", "draw": "codex" },
    "models": { "claude": { "plan": null, "look": "sonnet" }, "codex": { "plan": null, "look": null, "draw": null } },
    "repair_limit": null
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
    "claude": { "installed": true, "version": "fake", "fake": true },
    "codex": { "installed": true, "version": "fake", "fake": true }
  },
  "choices": { "plan": ["claude", "codex"], "look": ["claude", "codex"], "draw": ["codex", "manual"] },
  "languages": ["en", "es"]
}
```
<!-- /example:settings -->

### `PUT /api/projects/:id/settings`

Body: any subset of `language`, `drivers`, `models`, `repair_limit`. Fields
left out keep their value. 400 `bad_settings` names the first invalid field.

<!-- example:settings-put -->
```json
{
  "settings": {
    "language": "en",
    "drivers": { "plan": "claude", "look": "claude", "draw": "codex" },
    "models": { "claude": { "plan": null, "look": "sonnet" }, "codex": { "plan": null, "look": null, "draw": null } },
    "repair_limit": null
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
    "logline": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
    "genre": "drama",
    "language": "en",
    "comic_format": "paged",
    "publication": "one-shot",
    "reading_direction": "ltr",
    "color_mode": "full_color",
    "lettering_mode": "in_image",
    "rating": "teen",
    "repair_limit": 1,
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
        "aspect_ratio": "2:3",
        "width_px": 2000,
        "height_px": 3000,
        "formats": ["paged"]
      },
      {
        "id": "album-3-4",
        "label": "Album page 3:4",
        "aspect_ratio": "3:4",
        "width_px": 2100,
        "height_px": 2800,
        "formats": ["paged"]
      },
      {
        "id": "square",
        "label": "Square 1:1",
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
    "etag": "a7d-1a2190bb58a",
    "mtime": "2026-11-26T18:08:47.498Z",
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
| `repair_limit` | 0 to 10. Writes `repair_policy.max_cycles`, the scaffold's own limit. |
| `page_size` | One of the ids in `choices.page_size`. |
| `page` | `{ aspect_ratio, width_px, height_px }` for a size that is not in the list. |

<!-- example:options-put -->
```json
{
  "options": {
    "title": "The Night Ferry",
    "logline": "A ferry pilot finds a stowaway the harbour patrol is hunting.",
    "genre": "drama",
    "language": "en",
    "comic_format": "paged",
    "publication": "one-shot",
    "reading_direction": "ltr",
    "color_mode": "full_color",
    "lettering_mode": "in_image",
    "rating": "teen",
    "repair_limit": 1,
    "page": { "aspect_ratio": "2:3", "width_px": 2000, "height_px": 3000 },
    "page_size": "comic-2-3",
    "image_provider": "codex-cli"
  },
  "findings": [],
  "commit": "ba1e780a303375a9d1c619ac11cdb2e37e1e9ba2"
}
```
<!-- /example:options-put -->

## Screens

One call per screen. Every screen response ends with `chat_key`, the key of
that screen's conversation (see [Chat](#chat)).

### `GET /api/projects/:id/story`

| Field | Meaning |
|---|---|
| `written` | `true` once the story bible has a premise and facts. |
| `description` | What the person wrote when creating the project. |
| `bible` | `story/story-bible.yaml` as a text document. |
| `series_plan` | `story/series-plan.yaml` as a text document. |
| `sources` | Files under `story/source/`: `[{ name, path, bytes, mtime, url }]`. |
| `blocking_questions` | Open questions marked blocking, which have to be answered before pages are drawn. |
| `characters_named` | Characters the bible lists: `[{ id, has_file }]`. |

<!-- example:story -->
```json
{
  "written": true,
  "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
  "bible": {
    "path": "story/story-bible.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "story-bible",
    "text": "# Schema: schemas/story-bible.schema.json\n\ntitle: The Night Ferry\npremise: A ferry pilot finds a stowaway the harbour pa…",
    "data": {
      "title": "The Night Ferry",
      "premise": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
      "tone": "Plain and direct.",
      "world_rules": [],
      "facts": ["{…}", "... 1 more"],
      "characters": [],
      "timeline": ["{…}"],
      "open_questions": []
    },
    "parse_error": null,
    "findings": [],
    "etag": "2af-1a2190bb464",
    "mtime": "2026-11-26T18:08:47.204Z",
    "url": "/api/projects/the-night-ferry/raw/story/story-bible.yaml"
  },
  "series_plan": {
    "path": "story/series-plan.yaml",
    "exists": true,
    "kind": "yaml",
    "schema": "series-plan",
    "text": "# Schema: schemas/series-plan.schema.json\n\ntitle: The Night Ferry\nissues:\n  - id: ISS_001\n    number: 1\n    title: Issue…",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "ee-1a2190bb465",
    "mtime": "2026-11-26T18:08:47.205Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  },
  "sources": [
    {
      "name": "description.md",
      "path": "story/source/description.md",
      "bytes": 115,
      "mtime": "2026-11-26T18:08:47.040Z",
      "url": "/api/projects/the-night-ferry/raw/story/source/description.md"
    }
  ],
  "blocking_questions": [],
  "characters_named": [],
  "chat_key": "story"
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
  "presets": "[6 items]",
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
        "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwxv99a6",
        "width": 600,
        "height": 900,
        "bytes": 7997,
        "mtime": "2026-11-26T18:08:48.702Z"
      },
      "status": "approved",
      "role": "style",
      "approved_at": "2026-11-26",
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
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_V01.png?v=665mwxv99a6",
          "width": 600,
          "height": 900,
          "bytes": 7997,
          "mtime": "2026-11-26T18:08:48.702Z"
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
          "created_at": "2026-11-26T18:08:48.605Z",
          "prompt_package": "PP_LOOK_NOIR_INK_CODEX-CLI-LOOK",
          "supplied_by_person": false,
          "summary": "Codex saved one 600x900 PNG in 1 s; 1 reference image(s) passed to the image tool, as Codex reports.",
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
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_REF_V01.png?v=11dmwxv98sn",
          "width": 200,
          "height": 300,
          "bytes": 1345,
          "mtime": "2026-11-26T18:08:48.071Z"
        },
        "status": "approved",
        "role": "style",
        "approved_at": "2026-11-26",
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
    "etag": "384-1a2190bb872",
    "mtime": "2026-11-26T18:08:48.242Z",
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
    "etag": "2dd-1a2190bb872",
    "mtime": "2026-11-26T18:08:48.242Z",
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
    "etag": "47-1a2190bb872",
    "mtime": "2026-11-26T18:08:48.242Z",
    "url": "/api/projects/the-night-ferry/raw/style/color-script.md"
  },
  "options": "{…}",
  "choices": "{…}",
  "chat_key": "style"
}
```
<!-- /example:style -->

### `GET /api/projects/:id/characters`

The cast. `image` is the approved master, else the newest candidate, else an
uploaded reference. `has_master` means an approved sheet exists;
`has_identity` also counts an uploaded photo. `candidates` counts sheets
waiting for a decision.

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
        "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png?v=8bpmwxv9a2j",
        "width": 900,
        "height": 900,
        "bytes": 10789,
        "mtime": "2026-11-26T18:08:49.723Z"
      },
      "has_master": true,
      "has_identity": true,
      "candidates": 1,
      "references": 1,
      "chat_key": "character:CHAR_MARA"
    }
  ],
  "look_approved": true,
  "chat_key": "characters"
}
```
<!-- /example:characters -->

### `GET /api/projects/:id/characters/:char`

One character: the summary above plus `character` and `wardrobe` (text
documents), `assets` (`masters`, `candidates`, `references`), `sheets` (per
kind: `{ master, candidates }` for `turnaround`, `expressions`, `wardrobe`,
`detail`), `packages` (compiled sheet prompts), `used_on` (page IDs where the
character appears) and `look_approved`.

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
    "url": "/api/projects/the-night-ferry/raw/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png?v=8bpmwxv9…",
    "width": 900,
    "height": 900,
    "bytes": 10789,
    "mtime": "2026-11-26T18:08:49.723Z"
  },
  "has_master": true,
  "has_identity": true,
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
    "etag": "219-1a2190bbf98",
    "mtime": "2026-11-26T18:08:50.072Z",
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
    "etag": "149-1a2190bbc88",
    "mtime": "2026-11-26T18:08:49.288Z",
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
        "approved_at": "2026-11-26",
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
        "generation": "{…}"
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
        "approved_at": "2026-11-26",
        "approved_by": "person",
        "notes": "Identity reference supplied by the person through the studio. Original file name: mara.png. Licence …"
      }
    ]
  },
  "sheets": {
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
  "look_approved": true
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
  "chat_key": "places"
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
    "etag": "1db-1a2190bc182",
    "mtime": "2026-11-26T18:08:50.562Z",
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
    "etag": "230-1a2190bc183",
    "mtime": "2026-11-26T18:08:50.563Z",
    "url": "/api/projects/the-night-ferry/raw/locations/LOC_MAIN_ROOM/map.yaml"
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
        "passes": false
      }
    }
  ]
}
```
<!-- /example:issues -->

### `GET /api/projects/:id/issues/:issue`

The pages screen of one issue.

| Field | Meaning |
|---|---|
| `issue` | `issues/<ISS_ID>/issue.yaml` as a text document (`exists: false` before the first plan). |
| `planned` | The issue's entry in the series plan. |
| `scenes` | `[{ id, path, summary, location, cast, pages }]`. |
| `pages` | One summary per page, in reading order (fields below). |
| `counts` | `pages`, `planned_budget`, `plan_approved`, `rendered`, `passed` (pass or notes), `with_notes`, `flagged`. |
| `mechanical` | `continuity` (findings of `check-continuity.js`, each with `code`, `severity`, `page`, `panel`, `entity`, `message`, `hint`), `validation` (`errors` and `warnings` of `validate-workspace.js`, each `{ file, code, message }`) and `errors`, their count. Always show the errors. |
| `draw` | `{ available, tool, reason, look_approved }`: whether pages can be drawn now. |
| `repair_limit` | Automatic repair cycles per page. |
| `cover` | Cover summary: `{ exists, status, approved_render, renders, current_render, image, verdict, outcome, open_findings, passes }`. |

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
| `blockers` | `[{ code, message }]`: what stops this page from being drawn (a character with no approved sheet, a look that is not approved). Empty for a page that already has a passing render. |

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
    "etag": "d1-1a2190bc23e",
    "mtime": "2026-11-26T18:08:50.750Z",
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
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png?v=73tmwxv9bbq",
        "width": 600,
        "height": 900,
        "bytes": 9209,
        "mtime": "2026-11-26T18:08:51.350Z"
      },
      "verdict": "pass",
      "outcome": "pass",
      "passes": true,
      "flagged": false,
      "open_findings": 0,
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
    "continuity": [],
    "validation": { "errors": [], "warnings": [] },
    "errors": 0
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
    "passes": false
  },
  "chat_key": "pages:ISS_001"
}
```
<!-- /example:issue -->

### `GET /api/projects/:id/pages/:page`

Everything about one page.

| Field | Meaning |
|---|---|
| `page` | `page.yaml` as a text document: layout, panel script, ledger, lettering text. |
| `plan` | The short readable plan: `purpose`, `grid`, `tiers`, `panels[]` (`id`, `number`, `size`, `shot`, `moment`, `location`, `cast[]` with `character`, `name`, `off_panel`, `action`, `where`, `holding`, `state`, and `lettering[]` with `id`, `type`, `speaker`, `speaker_name`, `text`) and `text`, the same as plain lines. |
| `plan_approval` | `{ approved, at, stale }`. `stale` is `true` when the plan changed after it was approved. |
| `renders` | Every version, oldest first (fields below). |
| `prompts` | The compiled prompt packages of the page: `path`, `id`, `provider`, `model`, `mode` (`generate` or `repair`), `prompt`, `negative_prompt`, `parameters`, `references[]` (`asset_id`, `role`, `path`, `image`), `edit_target`, `repair` (`of_render`, `findings`, `changes`, `locked`), `lettering_text`, and `stale` (reasons the package no longer matches its sources). |
| `reference_plan` | `reference-plan.yaml` as a text document plus `entries[]`: each planned reference with `asset_id`, `entity`, `role`, `priority`, `reason`, `omission_risk`, `required` and its `image`. |
| `findings` | Mechanical findings for this page: `continuity`, `validation` (`errors`, `warnings`), `schema`, and `blockers`. |
| `lettering` | `mode` (`in_image` or `overlay`), `geometry` (`lettering.yaml` as a text document) and `needs_placement`. |
| `draw` | `{ available, tool, reason }`. |
| `neighbors` | `{ previous, next }` page IDs. |

Render fields:

| Field | Meaning |
|---|---|
| `id`, `version`, `current` | `current` marks the page's `current_render`. |
| `image` | The render. |
| `lettered` | The flat lettered image (overlay mode), or `null`. |
| `overlay` | `{ path, url }` of the SVG overlay, or `null`. |
| `review` | `null` before a review. Else `path`, `verdict`, `outcome` (`pass`, `notes` or `flagged`), `passes`, `open_blocking`, `independent`, `reviewer`, `repair_cycle`, `reviewed_at`, `supersedes`, `human_approval` (`status`, `by`, `at`), `gates` (`style_fidelity`, `narrative_continuity`), `checks` (fourteen keys, each `{ result, evidence }`), `findings[]`, `open_findings`, `change_requests`, `compared_against`, `notes`. |
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
    "etag": "ea7-1a2190bc974",
    "mtime": "2026-11-26T18:08:52.596Z",
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
    "text": "Page 2: FLAG She hears the crates shift and goes down to the deck.\n1. The place where this happens: FLAG She h…"
  },
  "plan_approval": { "approved": true, "at": "2026-11-26T18:08:51Z", "stale": false },
  "renders": [
    {
      "id": "PG_001_002_V01",
      "version": 1,
      "current": false,
      "image": {
        "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png?v=74gmwxv9bss",
        "width": 600,
        "height": 900,
        "bytes": 9232,
        "mtime": "2026-11-26T18:08:51.964Z"
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
        "reviewed_at": "2026-11-26",
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
        "created_at": "2026-11-26T18:08:51.872Z",
        "prompt_package": "PP_PG_001_002_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 3 reference image(s) passed to the image tool, as Codex reports.",
        "notes": "Codex notes: Placeholder from the fake drawing tool. Not art. Replaced by PG_001_002_V02 after review."
      }
    },
    {
      "id": "PG_001_002_V02",
      "version": 2,
      "current": true,
      "image": {
        "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png?v=6wjmwxv9c55",
        "width": 600,
        "height": 900,
        "bytes": 8947,
        "mtime": "2026-11-26T18:08:52.409Z"
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
        "reviewed_at": "2026-11-26",
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
        "created_at": "2026-11-26T18:08:52.312Z",
        "prompt_package": "PP_PG_001_002_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 4 reference image(s) passed to the image tool, as Codex reports.",
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
    "text": "page: PG_001_002\nprovider: codex-cli\nbudget: 4\nrequired:\n  - asset_id: LOOK_NOIR_INK_MASTER_V01\n    entity: LO…",
    "data": {
      "page": "PG_001_002",
      "provider": "codex-cli",
      "budget": 4,
      "required": ["{…}", "... 1 more"],
      "optional": ["{…}"],
      "exclude": [],
      "created_at": "2026-11-26"
    },
    "parse_error": null,
    "findings": [],
    "etag": "353-1a2190bc5f3",
    "mtime": "2026-11-26T18:08:51.699Z",
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
          "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwxv99a6",
          "width": 600,
          "height": 900,
          "bytes": 7997,
          "mtime": "2026-11-26T18:08:48.702Z"
        }
      },
      "... 2 more"
    ]
  },
  "findings": {
    "note": "Mechanical checks of the plan files. A review verdict is a separate thing, under each render.",
    "continuity": [],
    "validation": { "errors": [], "warnings": [] },
    "schema": [],
    "blockers": []
  },
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
    "needs_placement": false
  },
  "draw": { "available": true, "tool": "codex", "reason": null },
  "repair_limit": 1,
  "neighbors": { "previous": "PG_001_001", "next": "PG_001_003" },
  "chat_key": "page:PG_001_002"
}
```
<!-- /example:page -->

### `GET /api/projects/:id/issues/:issue/cover`

The cover of an issue. `exists` is `false` before `cover.create`. `cover` is
`cover.yaml` as a text document, `renders` has the shape of a page's renders,
and `approved_render` is the version the edition ships.

<!-- example:cover -->
```json
{
  "exists": true,
  "status": "approved",
  "approved_render": "CV_001_V02",
  "renders": [
    {
      "id": "CV_001_V01",
      "version": 1,
      "current": false,
      "image": {
        "path": "issues/ISS_001/cover/renders/CV_001_V01.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V01.png?v=6dwmwxv9fae",
        "width": 600,
        "height": 900,
        "bytes": 8276,
        "mtime": "2026-11-26T18:08:56.486Z"
      },
      "lettered": null,
      "overlay": null,
      "review": {
        "path": "issues/ISS_001/cover/reviews/CV_001_V01.review.yaml",
        "verdict": "flagged",
        "outcome": "flagged",
        "passes": false,
        "independent": true,
        "reviewer": "visual-reviewer",
        "repair_cycle": 0,
        "reviewed_at": "2026-11-26",
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
            "panel": null,
            "source": "user_request",
            "check": "lettering",
            "expected": "The requested change shows in the cover, and nothing else differs.",
            "visible": "The cover as drawn in CV_001_V01, before the requested change.",
            "severity": "minor",
            "repair": "Make the title larger.",
            "status": "open"
          }
        ],
        "open_findings": 1,
        "open_blocking": 0,
        "change_requests": 1,
        "compared_against": { "references": ["LOOK_NOIR_INK_MASTER_V01", "... 1 more"], "neighbors": [] },
        "notes": "Automated reading by Claude Code through the studio. It is evidence to look at, not a guarantee."
      },
      "generation": {
        "id": "GEN_CV_001_01",
        "path": "generations/CV_001/GEN_CV_001_01.yaml",
        "provider": "codex-cli",
        "model": "unreported",
        "status": "rejected",
        "created_at": "2026-11-26T18:08:56.390Z",
        "prompt_package": "PP_CV_001_CODEX-CLI",
        "supplied_by_person": false,
        "summary": "Codex saved one 600x900 PNG in 1 s; 2 reference image(s) passed to the image tool, as Codex reports.",
        "notes": "Codex notes: Placeholder from the fake drawing tool. Not art. Replaced by CV_001_V02 after review."
      }
    },
    "... 1 more"
  ],
  "current_render": "CV_001_V02",
  "image": {
    "path": "issues/ISS_001/cover/renders/CV_001_V02.png",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V02.png?v=6xgmwxv9fvw",
    "width": 600,
    "height": 900,
    "bytes": 8980,
    "mtime": "2026-11-26T18:08:57.260Z"
  },
  "verdict": "fixed",
  "outcome": "pass",
  "open_findings": 0,
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
    "etag": "260-1a2190bdd41",
    "mtime": "2026-11-26T18:08:57.665Z",
    "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/cover.yaml"
  },
  "render_count": 2,
  "prompts": "[1 item]",
  "look_approved": true,
  "chat_key": "cover:ISS_001"
}
```
<!-- /example:cover -->

### `GET /api/projects/:id/issues/:issue/publish`

| Field | Meaning |
|---|---|
| `formats` | `[{ id, label }]` for `publish.build`. |
| `readiness.final_possible` | `true` when a final edition can be built now. |
| `readiness.draft_possible` | `true` when at least one page has a render. |
| `readiness.blockers` | `[{ page, render, code, message }]`. Codes: `no_render`, `render_missing`, `no_review`, `not_passing` (a flagged review; a page with notes passes), `not_lettered`, `continuity`. With blockers, a build is a marked draft. |
| `next_edition` | What a build would ship now: `id`, `pages[]` (`page`, `render`, `file`, `lettered_file`, `image`), `cover`, `supersedes`, `changes`, and `reuses` (the id of the latest edition when nothing changed since, in which case a build adds formats to that edition). |
| `lettering` | `mode`, and in overlay mode `pages[]` with `page`, `render`, `lettered_file`, `needs_placement`. |
| `editions` | Newest first: `id`, `path`, `title`, `label`, `status` (`draft`, `reviewed`, `published`), `created_at`, `supersedes`, `changes`, `cover`, `pages` (count) and `exports[]`. |
| `editions[].exports[]` | `format`, `file`, `built_at`, `exists`, `bytes`, `draft` (the file name carries `-DRAFT`), `url`, `download_url` (the same with `?download=1`; `null` for the web reader) and `browsable` (`true` for the web reader, whose `url` opens it). |

<!-- example:publish -->
```json
{
  "issue": "ISS_001",
  "formats": [
    { "id": "pdf", "label": "PDF" },
    { "id": "cbz", "label": "CBZ (comic reader apps)" },
    { "id": "web", "label": "Web reader" },
    { "id": "images", "label": "Images, one per page" },
    { "id": "epub", "label": "EPUB (fixed layout)" }
  ],
  "readiness": {
    "final_possible": true,
    "draft_possible": true,
    "blockers": [],
    "continuity_errors": 0,
    "note": "Final means every shipped render has a passing review on file. It does not certify the drawings."
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
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png?v=6vqmwxv9djw",
          "width": 600,
          "height": 900,
          "bytes": 8918,
          "mtime": "2026-11-26T18:08:54.236Z"
        }
      },
      {
        "page": "PG_001_002",
        "render": "PG_001_002_V03",
        "file": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png",
        "lettered_file": null,
        "image": {
          "path": "issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png",
          "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V03.png?v=7kwmwxv9ebg",
          "width": 600,
          "height": 900,
          "bytes": 9824,
          "mtime": "2026-11-26T18:08:55.228Z"
        }
      },
      "... 1 more"
    ],
    "cover": {
      "render": "CV_001_V02",
      "file": "issues/ISS_001/cover/renders/CV_001_V02.png",
      "lettered_file": null,
      "image": {
        "path": "issues/ISS_001/cover/renders/CV_001_V02.png",
        "url": "/api/projects/the-night-ferry/raw/issues/ISS_001/cover/renders/CV_001_V02.png?v=6xgmwxv9fvw",
        "width": 600,
        "height": 900,
        "bytes": 8980,
        "mtime": "2026-11-26T18:08:57.260Z"
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
      "created_at": "2026-11-26",
      "supersedes": null,
      "changes": [],
      "cover": { "render": "CV_001_V02", "file": "issues/ISS_001/cover/renders/CV_001_V02.png", "lettered_file": null },
      "pages": 3,
      "exports": [
        {
          "format": "pdf",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf",
          "built_at": "2026-11-26T18:08:58Z",
          "exists": true,
          "bytes": 24506,
          "draft": false,
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf",
          "download_url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf?download=1",
          "browsable": false
        },
        {
          "format": "cbz",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz",
          "built_at": "2026-11-26T18:08:58Z",
          "exists": true,
          "bytes": 37856,
          "draft": false,
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz",
          "download_url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz?download=1",
          "browsable": false
        },
        {
          "format": "web",
          "file": "editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html",
          "built_at": "2026-11-26T18:08:58Z",
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
  "chat_key": "publish:ISS_001"
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
    "text": "# Schema: schemas/series-plan.schema.json\n\ntitle: The Night Ferry\nissues:\n  - id: ISS_001\n    number: 1\n    title: Issue 1\n    summary: A ferry pilot finds a stowaway the harbour patrol is hunting.\n  …",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "ee-1a2190bb465",
    "mtime": "2026-11-26T18:08:47.205Z",
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
    "text": "# Schema: schemas/series-plan.schema.json\n\ntitle: The Night Ferry\nissues:\n  - id: ISS_001\n    number: 1\n    title: Cross…",
    "data": { "title": "The Night Ferry", "issues": ["{…}"] },
    "parse_error": null,
    "findings": [],
    "etag": "ef-1a2190bb621",
    "mtime": "2026-11-26T18:08:47.649Z",
    "url": "/api/projects/the-night-ferry/raw/story/series-plan.yaml"
  },
  "findings": [],
  "continuity": [],
  "commit": "1e0c6b12ffc4bb153256692d754a5a7cb8bfe57f",
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
    "message": "YAML parse error at line 1: unterminated double-quoted string",
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

## Raw files

### `GET /api/projects/:id/raw/*path`

Any file of the workspace, by its workspace-relative path:
`/api/projects/the-night-ferry/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png`.
Use the `url` fields of the other responses instead of building these.

- `Range: bytes=...` is honoured (one range), with `206` and `Content-Range`.
- `ETag` and `Last-Modified` are sent, and `If-None-Match` gets a `304`.
- `?download=1` adds `Content-Disposition: attachment`.
- An HTML or SVG file is served with `Content-Security-Policy: sandbox
  allow-scripts`. The web reader of an edition works that way: its relative
  image links resolve through this same route.
- Hidden files and paths outside the workspace are not served.

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
    "id": "up_2026112618084763306_ab7c",
    "name": "style-reference.png",
    "kind": "image",
    "bytes": 1345,
    "width": 200,
    "height": 300,
    "at": "2026-11-26T18:08:47Z",
    "url": "/api/projects/the-night-ferry/uploads/up_2026112618084763306_ab7c"
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
      "id": "up_2026112618084763306_ab7c",
      "name": "style-reference.png",
      "kind": "image",
      "bytes": 1345,
      "width": 200,
      "height": 300,
      "at": "2026-11-26T18:08:47Z",
      "url": "/api/projects/the-night-ferry/uploads/up_2026112618084763306_ab7c"
    }
  ]
}
```
<!-- /example:uploads -->

### `GET /api/projects/:id/uploads/:upload`

The bytes of one upload (for a preview).

### `DELETE /api/projects/:id/uploads/:upload`

Removes a staged upload. Answers `{ "deleted": "<upload id>" }`. Copies
already made into the workspace stay.

## Operations and jobs

Everything that calls the AI or draws is an operation, and an operation runs
as a job. A project runs one job at a time; the others wait in order.

### `POST /api/projects/:id/ops`

Body: `{ "op": "<name>", "params": { ... } }`. The parameters are checked
before the job is created, so a 400 or a 409 comes back at once and no job
exists. Answers 202 with the queued job, whose `steps` are already listed.
Chat messages do not go through this route (see [Chat](#chat)).

<!-- example:op-start -->
```json
{
  "job": {
    "id": "job_202611261808484290d_86fb",
    "project": "the-night-ferry",
    "op": "style.look",
    "title": "Draw a look page",
    "params": {},
    "status": "queued",
    "created_at": "2026-11-26T18:08:48Z",
    "started_at": null,
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "compile",
        "label": "Prepare the look page",
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
    "cost_usd": null
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
    "message": "The plan of PG_001_001, PG_001_002, PG_001_003 is not approved, or changed after it was. Approve it (POST /approve/plan) or send \"approve_plans\": true…",
    "details": { "pages": ["PG_001_001", "PG_001_002", "... 1 more"] }
  }
}
```
<!-- /example:error-plan-not-approved -->

### The job object

| Field | Meaning |
|---|---|
| `id` | Sortable by creation time. |
| `op`, `title`, `params` | The operation, its title for the person, and the checked parameters. |
| `status` | `queued`, `running`, `needs_decision`, `done`, `failed` or `cancelled`. |
| `position` | Place in the queue while `queued` (1 is next), else `null`. |
| `created_at`, `started_at`, `ended_at` | ISO 8601. `ended_at` stays `null` while the job waits for an answer. |
| `current_step` | Id of the running step, or `null`. |
| `steps` | In order: `{ id, label, status, started_at, ended_at, tool, commit, files, note, changed }`. More steps can appear while the job runs (a repair, for example). |
| `steps[].status` | `pending`, `running`, `done`, `failed`, `cancelled`, `waiting` (paused for an answer) or `skipped`. |
| `steps[].tool` | `claude`, `codex` or `person` for a step one of them did, else `null`. |
| `steps[].commit`, `files`, `changed` | The commit of what the step wrote, how many files, and their paths. |
| `steps[].note` | A short result or the reason for a failure or a skip. |
| `questions` | While `needs_decision`: `[{ id, question, options }]`. |
| `answers` | Answers given so far: `{ <question id>: { question, answer } }`. |
| `result` | The operation's result once `done` (see the operations reference). |
| `error` | `{ code, message, details? }` once `failed`. |
| `tools` | Which tool did each verb in this job: `{ plan?, look?, draw? }`. |
| `commits` | Every commit the job made. |
| `cost_usd` | Sum of the costs Claude Code reported, or `null`. Codex reports none. |

<!-- example:job -->
```json
{
  "job": {
    "id": "job_202611261808510580x_b1d1",
    "project": "the-night-ferry",
    "op": "pages.generate",
    "title": "Draw pages",
    "params": { "pages": ["PG_001_001", "... 2 more"], "approve_plans": false, "regenerate": false },
    "status": "done",
    "created_at": "2026-11-26T18:08:51Z",
    "started_at": "2026-11-26T18:08:51Z",
    "ended_at": "2026-11-26T18:08:53Z",
    "current_step": null,
    "steps": [
      {
        "id": "PG_001_001:prepare",
        "label": "Page 1: references and prompt",
        "status": "done",
        "started_at": "2026-11-26T18:08:51Z",
        "ended_at": "2026-11-26T18:08:51Z",
        "tool": null,
        "commit": "60c7e5c8472abcc9db9fa4553474120ea0cdfbd4",
        "files": 3,
        "note": "2 reference image(s)",
        "changed": [
          "issues/ISS_001/pages/PG_001_001/page.yaml",
          "issues/ISS_001/pages/PG_001_001/prompts/codex-cli.yaml",
          "issues/ISS_001/pages/PG_001_001/reference-plan.yaml"
        ]
      },
      {
        "id": "PG_001_001:draw",
        "label": "Page 1: draw",
        "status": "done",
        "started_at": "2026-11-26T18:08:51Z",
        "ended_at": "2026-11-26T18:08:51Z",
        "tool": "codex",
        "commit": "875646dbc62835b6a4348dbaca16630700ab6aec",
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
        "status": "done",
        "started_at": "2026-11-26T18:08:51Z",
        "ended_at": "2026-11-26T18:08:51Z",
        "tool": "claude",
        "commit": "e1bdedd34b2ad8fd4561350bf995657d50e20d29",
        "files": 2,
        "note": null,
        "changed": [
          "issues/ISS_001/pages/PG_001_001/page.yaml",
          "issues/ISS_001/pages/PG_001_001/reviews/PG_001_001_V01.review.yaml"
        ]
      },
      {
        "id": "PG_001_002:prepare",
        "label": "Page 2: references and prompt",
        "status": "done",
        "started_at": "2026-11-26T18:08:51Z",
        "ended_at": "2026-11-26T18:08:51Z",
        "tool": null,
        "commit": "e1fdb13bc7239fd63a80a1848f4e61f486cd13f0",
        "files": 3,
        "note": "3 reference image(s)",
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
      "tools": { "draw": "codex", "look": "claude" }
    },
    "error": null,
    "tools": { "draw": "codex", "look": "claude" },
    "commits": [
      "60c7e5c8472abcc9db9fa4553474120ea0cdfbd4",
      "875646dbc62835b6a4348dbaca16630700ab6aec",
      "e1bdedd34b2ad8fd4561350bf995657d50e20d29",
      "e1fdb13bc7239fd63a80a1848f4e61f486cd13f0",
      "... 7 more"
    ],
    "position": null,
    "cost_usd": null
  }
}
```
<!-- /example:job -->

### `GET /api/projects/:id/jobs`

Newest first. `?limit=` (default 50, at most 500) and `?active=1` (only
queued, running and waiting jobs). `running` is the job that runs now, or
`null`.

<!-- example:jobs -->
```json
{
  "jobs": [
    {
      "id": "job_202611261808510580x_b1d1",
      "project": "the-night-ferry",
      "op": "pages.generate",
      "title": "Draw pages",
      "params": { "pages": ["PG_001_001", "... 2 more"], "approve_plans": false, "regenerate": false },
      "status": "done",
      "created_at": "2026-11-26T18:08:51Z",
      "started_at": "2026-11-26T18:08:51Z",
      "ended_at": "2026-11-26T18:08:53Z",
      "current_step": null,
      "steps": [
        {
          "id": "PG_001_001:prepare",
          "label": "Page 1: references and prompt",
          "status": "done",
          "started_at": "2026-11-26T18:08:51Z",
          "ended_at": "2026-11-26T18:08:51Z",
          "tool": null,
          "commit": "60c7e5c8472abcc9db9fa4553474120ea0cdfbd4",
          "files": 3,
          "note": "2 reference image(s)",
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
        "tools": { "draw": "codex", "look": "claude" }
      },
      "error": null,
      "tools": { "draw": "codex", "look": "claude" },
      "commits": ["60c7e5c8472abcc9db9fa4553474120ea0cdfbd4", "... 10 more"],
      "position": null,
      "cost_usd": null
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
  "job": "job_202611261808510580x_b1d1",
  "lines": [
    "2026-11-26T18:08:53Z PG_001_003:review Page 3: check",
    "2026-11-26T18:08:53Z PG_001_003:review Claude Code started (sonnet)",
    "2026-11-26T18:08:53Z PG_001_003:review reading commands for review",
    "2026-11-26T18:08:53Z PG_001_003:review Claude Code finished in 1 s: The image matches the plan.",
    "2026-11-26T18:08:53Z PG_001_003:review review of PG_001_003_V01: fixed, 1 open finding(s), 0 blocking",
    "2026-11-26T18:08:53Z - Draw pages finished"
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
    "id": "job_202611261808560311p_a76b",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "params": { "instruction": "SLOW change that will be cancelled.", "source_upload": null },
    "status": "cancelled",
    "created_at": "2026-11-26T18:08:56Z",
    "started_at": "2026-11-26T18:08:56Z",
    "ended_at": "2026-11-26T18:08:56Z",
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "status": "cancelled",
        "started_at": "2026-11-26T18:08:56Z",
        "ended_at": "2026-11-26T18:08:56Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
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
    "cost_usd": null
  }
}
```
<!-- /example:job-cancel -->

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
    "id": "job_202611261808557781n_25d2",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "params": { "instruction": "DECIDE whether the patrol knows the boy by name.", "source_upload": null },
    "status": "needs_decision",
    "created_at": "2026-11-26T18:08:55Z",
    "started_at": "2026-11-26T18:08:55Z",
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "status": "waiting",
        "started_at": "2026-11-26T18:08:55Z",
        "ended_at": "2026-11-26T18:08:55Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
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
    "cost_usd": null
  }
}
```
<!-- /example:job-needs-decision -->

The answer to `POST .../answer`:

<!-- example:job-answer -->
```json
{
  "job": {
    "id": "job_202611261808557781n_25d2",
    "project": "the-night-ferry",
    "op": "story.update",
    "title": "Update the story",
    "params": { "instruction": "DECIDE whether the patrol knows the boy by name.", "source_upload": null },
    "status": "queued",
    "created_at": "2026-11-26T18:08:55Z",
    "started_at": "2026-11-26T18:08:55Z",
    "ended_at": null,
    "current_step": null,
    "steps": [
      {
        "id": "update",
        "label": "Update the story bible",
        "status": "pending",
        "started_at": "2026-11-26T18:08:55Z",
        "ended_at": "2026-11-26T18:08:55Z",
        "tool": "claude",
        "commit": null,
        "files": 0,
        "note": null,
        "changed": []
      },
      {
        "id": "check",
        "label": "Check the files",
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
    "cost_usd": null
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

| Event | When | Data |
|---|---|---|
| `hello` | Once, on connect. | `{ project, at, jobs }`: the active jobs, so a reload in the middle of a job picks it up. |
| `job` | Every change of a job: queued, a step starts or ends, a step is added, the job ends or pauses. | `{ job }`, the full job object. |
| `log` | A progress line of the running job. | `{ job, step, at, line }`. Tool use arrives as short lines such as `reading docs/data-model.md` or `writing story/story-bible.yaml`. |
| `activity` | A history entry was added. | `{ entry }`, as in [History](#history) (image paths, not image objects). |
| `files` | Files of the workspace changed. | `{ paths, job, commit }`. `job` is `null` for a save or an approval by the person. Reload the screens that show those paths. |
| `chat` | A chat message was added. | `{ key, message }`. |
| `heartbeat` | Every 15 seconds. | `{ at }`. |

<!-- example:event-hello -->
```json
{
  "project": "the-night-ferry",
  "at": "2026-11-26T18:08:47Z",
  "jobs": [
    {
      "id": "job_2026112618084703102_f9d2",
      "project": "the-night-ferry",
      "op": "project.setup",
      "title": "Set up the project",
      "params": {
        "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
        "pages": 3
      },
      "status": "running",
      "created_at": "2026-11-26T18:08:47Z",
      "started_at": "2026-11-26T18:08:47Z",
      "ended_at": null,
      "current_step": "source",
      "steps": [
        {
          "id": "source",
          "label": "Save the description",
          "status": "running",
          "started_at": "2026-11-26T18:08:47Z",
          "ended_at": null,
          "tool": null,
          "commit": null,
          "files": 0,
          "note": null,
          "changed": []
        },
        "... 2 more"
      ],
      "questions": [],
      "answers": {},
      "result": null,
      "error": null,
      "tools": {},
      "commits": [],
      "position": null,
      "cost_usd": null
    }
  ]
}
```
<!-- /example:event-hello -->

<!-- example:event-job -->
```json
{
  "job": {
    "id": "job_202611261808510580x_b1d1",
    "project": "the-night-ferry",
    "op": "pages.generate",
    "title": "Draw pages",
    "params": { "pages": ["PG_001_001", "PG_001_002", "PG_001_003"], "approve_plans": false, "regenerate": false },
    "status": "running",
    "created_at": "2026-11-26T18:08:51Z",
    "started_at": "2026-11-26T18:08:51Z",
    "ended_at": null,
    "current_step": "PG_001_001:prepare",
    "steps": [
      {
        "id": "PG_001_001:prepare",
        "label": "Page 1: references and prompt",
        "status": "running",
        "started_at": "2026-11-26T18:08:51Z",
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
    "cost_usd": null
  }
}
```
<!-- /example:event-job -->

<!-- example:event-log -->
```json
{
  "job": "job_2026112618084703102_f9d2",
  "step": "story",
  "at": "2026-11-26T18:08:47Z",
  "line": "writing project.yaml"
}
```
<!-- /example:event-log -->

<!-- example:event-activity -->
```json
{
  "entry": {
    "id": "act_202611261808515100z_8972",
    "at": "2026-11-26T18:08:51Z",
    "kind": "step",
    "title": "Draw pages: Page 1: draw",
    "actor": "codex",
    "job": "job_202611261808510580x_b1d1",
    "op": "pages.generate",
    "step": "PG_001_001:draw",
    "files": [
      { "path": "generations/PG_001_001/GEN_PG_001_001_01.request.json", "change": "added" },
      { "path": "generations/PG_001_001/GEN_PG_001_001_01.yaml", "change": "added" },
      "... 2 more"
    ],
    "images": ["issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png"],
    "commit": "875646dbc62835b6a4348dbaca16630700ab6aec"
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
  "job": "job_202611261808510580x_b1d1",
  "commit": "60c7e5c8472abcc9db9fa4553474120ea0cdfbd4"
}
```
<!-- /example:event-files -->

<!-- example:event-chat -->
```json
{
  "key": "page:PG_001_003",
  "message": {
    "id": "msg_2026112618085857727_7c92",
    "at": "2026-11-26T18:08:58Z",
    "key": "page:PG_001_003",
    "role": "assistant",
    "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
    "job": "job_2026112618085835225_ac5d",
    "tool": "claude",
    "reply_to": "msg_2026112618085834824_13d9",
    "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
    "commit": "c847674088acb2c70ce6f1e13be557aeb4da52ee",
    "decisions": []
  }
}
```
<!-- /example:event-chat -->

<!-- example:event-heartbeat -->
```json
{ "at": "2026-11-26T18:08:47.090Z" }
```
<!-- /example:event-heartbeat -->

## Chat

One conversation per screen. The AI is given the files of that screen and may
change them. A turn runs as a job (`chat.turn`), so it waits its turn behind a
running job and can be cancelled like one.

Screen keys:

| Key | Files in context |
|---|---|
| `story` | The story bible, the series plan, the source files. |
| `style` | The style bible, the style block, the colour script, `project.yaml`. |
| `options` | `project.yaml`. |
| `characters` | Every character and wardrobe file. |
| `character:<CHAR_ID>` | That character's file and wardrobe. |
| `places` | Every location, map and prop file. |
| `location:<LOC_ID>`, `prop:<PROP_ID>` | That entity's files. |
| `pages:<ISS_ID>` | The issue file, its scenes and its page files. |
| `page:<PAGE_ID>` | The page file, its lettering geometry, the review of its current render, its scene. |
| `cover:<ISS_ID>` | The cover file, the issue file, the story bible. |
| `publish:<ISS_ID>` | The issue file and the latest edition. |

A malformed key is 400 `bad_chat_key`; a key that names something missing is
404 `chat_target_not_found`.

### `GET /api/projects/:id/chats`

The conversations that exist: `[{ key, messages, last_at }]`.

<!-- example:chats -->
```json
{ "chats": [{ "key": "page:PG_001_003", "messages": 2, "last_at": "2026-11-26T18:08:58Z" }] }
```
<!-- /example:chats -->

### `GET /api/projects/:id/chats/:key`

The transcript, oldest first, with the `files` in context and `pending`, the
ids of chat jobs for this key that have not finished.

Message fields: `id`, `at`, `key`, `role` (`user` or `assistant`), `text`,
`job`. An assistant message also has `tool` (which tool answered),
`reply_to` (id of the message it answers), `files` (paths it changed),
`commit` (commit of those changes, or `null`) and `decisions`. When the turn
failed, the assistant message has `error` and an empty `text`.

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
  "messages": [
    {
      "id": "msg_2026112618085834824_13d9",
      "at": "2026-11-26T18:08:58Z",
      "key": "page:PG_001_003",
      "role": "user",
      "text": "EDIT bring the last panel closer",
      "job": null
    },
    {
      "id": "msg_2026112618085857727_7c92",
      "at": "2026-11-26T18:08:58Z",
      "key": "page:PG_001_003",
      "role": "assistant",
      "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
      "job": "job_2026112618085835225_ac5d",
      "tool": "claude",
      "reply_to": "msg_2026112618085834824_13d9",
      "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
      "commit": "c847674088acb2c70ce6f1e13be557aeb4da52ee",
      "decisions": []
    }
  ],
  "pending": []
}
```
<!-- /example:chat -->

### `POST /api/projects/:id/chats/:key`

Body: `{ "text": "<message>" }`, at most 8000 characters. Answers 202 with
the stored user message and the job. The reply arrives as a `chat` event and
in the transcript.

<!-- example:chat-post -->
```json
{
  "message": {
    "id": "msg_2026112618085834824_13d9",
    "at": "2026-11-26T18:08:58Z",
    "key": "page:PG_001_003",
    "role": "user",
    "text": "EDIT bring the last panel closer",
    "job": null
  },
  "job": {
    "id": "job_2026112618085835225_ac5d",
    "project": "the-night-ferry",
    "op": "chat.turn",
    "title": "Chat",
    "params": {
      "key": "page:PG_001_003",
      "text": "EDIT bring the last panel closer",
      "message": "msg_2026112618085834824_13d9"
    },
    "status": "queued",
    "created_at": "2026-11-26T18:08:58Z",
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
    "cost_usd": null
  }
}
```
<!-- /example:chat-post -->

## History

Every finished step, save, approval, chat turn and restore is an entry in the
project's activity log, and every entry that changed files links to a git
commit of the project directory.

### `GET /api/projects/:id/history`

Newest first. `?limit=` (default 100, at most 1000) and `?before=<entry id>`
for the next page.

| Field | Meaning |
|---|---|
| `entries[].id`, `at` | Entry id and time. |
| `entries[].kind` | `project`, `step`, `save`, `approval`, `lettering`, `restore`. |
| `entries[].title` | What happened, for the person. |
| `entries[].actor` | `person`, `claude`, `codex`, or `studio` for a mechanical step. |
| `entries[].job`, `op`, `step` | For a job step. |
| `entries[].files` | `[{ path, change }]` with `change` one of `added`, `modified`, `deleted` (at most 200). |
| `entries[].images` | Image objects of the images the entry added or changed. An image that no longer exists comes as `{ path, url: null, missing: true }`. |
| `entries[].commit` | Commit id, or `null`. |
| `entries[].restorable` | `true` when the project can be restored to the state right after this entry. |
| `total`, `more` | Number of entries, and whether more follow. |
| `restore` | `{ available, reason }`. Without git, `available` is `false` and `reason` says so; the log itself still works. |

<!-- example:history -->
```json
{
  "entries": [
    {
      "id": "act_2026112618085857226_22dd",
      "at": "2026-11-26T18:08:58Z",
      "kind": "step",
      "title": "Chat: Answer the message",
      "actor": "claude",
      "job": "job_2026112618085835225_ac5d",
      "op": "chat.turn",
      "step": "reply",
      "files": [{ "path": "issues/ISS_001/pages/PG_001_003/page.yaml", "change": "modified" }],
      "images": [],
      "commit": "c847674088acb2c70ce6f1e13be557aeb4da52ee",
      "restorable": true
    },
    {
      "id": "act_2026112618085832023_bc20",
      "at": "2026-11-26T18:08:58Z",
      "kind": "step",
      "title": "Publish: Build the files",
      "actor": "studio",
      "job": "job_2026112618085783921_2c29",
      "op": "publish.build",
      "step": "build",
      "files": [
        { "path": "editions/ED_001_01/edition.yaml", "change": "modified" },
        { "path": "editions/ED_001_01/exports/the-night-ferry-001-ed01-images.zip", "change": "added" },
        "... 12 more"
      ],
      "images": [
        {
          "path": "editions/ED_001_01/exports/the-night-ferry-001-ed01-images/000-cover.png",
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01-images/000-cover.png?v=6xgmwxv9gke",
          "width": 600,
          "height": 900,
          "bytes": 8980,
          "mtime": "2026-11-26T18:08:58.142Z"
        },
        {
          "path": "editions/ED_001_01/exports/the-night-ferry-001-ed01-images/001.png",
          "url": "/api/projects/the-night-ferry/raw/editions/ED_001_01/exports/the-night-ferry-001-ed01-images/001.png?v=6vqmwxv9gke",
          "width": 600,
          "height": 900,
          "bytes": 8918,
          "mtime": "2026-11-26T18:08:58.142Z"
        },
        "... 6 more"
      ],
      "commit": "572d5822943048fdf0b0bac3c1fe3df2dc57c537",
      "restorable": true
    },
    "... 1 more"
  ],
  "total": 57,
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
  "commit": "69f0c96e567fe1ba600df9af6632cad6e17387c7",
  "restored": "fef7e48f16eec102cf68b7408022a0494ddef286",
  "unchanged": false,
  "saved_first": null,
  "files": 15,
  "activity": {
    "id": "act_2026112618085915828_11c2",
    "at": "2026-11-26T18:08:59Z",
    "kind": "restore",
    "title": "Restored to an earlier point: Approved the cover of ISS_001",
    "actor": "person",
    "job": null,
    "op": null,
    "step": null,
    "files": [
      { "path": "editions/ED_001_01/edition.yaml", "change": "deleted" },
      { "path": "editions/ED_001_01/exports/the-night-ferry-001-ed01-images.zip", "change": "deleted" },
      "... 13 more"
    ],
    "images": [],
    "commit": "69f0c96e567fe1ba600df9af6632cad6e17387c7",
    "restored_from": "fef7e48f16eec102cf68b7408022a0494ddef286"
  }
}
```
<!-- /example:restore -->

## Approvals

Decisions only the person makes. They are plain calls, not jobs, and each is
committed and logged. They work while a job is running.

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
  "approved_at": "2026-11-26",
  "updated": ["references/style/LOOK_NOIR_INK_MASTER_V01.png", "references/manifest.yaml", "project.yaml"],
  "stale": [],
  "style_block": "style/style-block.txt",
  "warnings": [],
  "image": {
    "path": "references/style/LOOK_NOIR_INK_MASTER_V01.png",
    "url": "/api/projects/the-night-ferry/raw/references/style/LOOK_NOIR_INK_MASTER_V01.png?v=665mwxv99a6",
    "width": 600,
    "height": 900,
    "bytes": 7997,
    "mtime": "2026-11-26T18:08:48.702Z"
  },
  "style_frozen": true,
  "commit": "e34f3b9ad01b7a8d17b0d95214d5778a8b99b8f1"
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
  "commit": "e1404ae1f2afe13d627b61c322a3dfd1c7d25387"
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
    "message": "The check of PG_001_002_V03 is flagged with 1 open finding(s). Ask for a correction, or approve it anyway with \"overrule\": true.",
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
accepted by the person, the review says who overruled what, and the
reviewer's evidence stays in the file. 409 `review_incomplete` when nobody
has checked the render yet.

<!-- example:approve-page-overrule -->
```json
{
  "page": "PG_001_002",
  "render": "PG_001_002_V03",
  "verdict": "fixed",
  "overruled": true,
  "accepted_notes": [],
  "status": "approved",
  "commit": "8ed65ad535af6c606f2498f2e4edabf6cfdaa205"
}
```
<!-- /example:approve-page-overrule -->

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
  "render": "CV_001_V02",
  "previous": null,
  "verdict": "fixed",
  "overruled": false,
  "accepted_notes": [],
  "status": "approved",
  "commit": "fef7e48f16eec102cf68b7408022a0494ddef286"
}
```
<!-- /example:approve-cover -->

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
  "note": "Draw this SVG on a canvas at its width and height, export a PNG, and send it to POST /pages/<PAGE_ID>/lettered."
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
    "url": "/api/projects/overlay-letters/raw/issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png?v=39hmwxv9m2x",
    "width": 400,
    "height": 600,
    "bytes": 4229,
    "mtime": "2026-11-26T18:09:05.289Z"
  },
  "editions": [],
  "commit": "bc09d50b49508603fa8be3e3219c7e1566684012"
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

Fills the project metadata and writes the story bible and the series plan
(one issue). Scaffold commands: project-init, story-bible, series-plan.

| Param | Type | Meaning |
|---|---|---|
| `description` | string, required | What the comic is about. Saved as `story/source/description.md`, the source for provenance. |
| `pages` | integer 1 to 200 | Page budget of the first issue. Default 4. |

Steps: `source`, `story` (plan), `check`. `result.problems` lists what
`validate-workspace.js` reports about the new files.

<!-- example:op.project.setup -->
```json
{
  "params": {
    "description": "A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.",
    "pages": 3
  },
  "steps": [
    { "id": "source", "label": "Save the description", "status": "done" },
    { "id": "story", "label": "Write the story bible and the series plan", "status": "done" },
    { "id": "check", "label": "Check the files", "status": "done" }
  ],
  "result": {
    "summary": "Wrote the story bible and a one-issue plan of 3 page(s) for \"The Night Ferry\".",
    "decisions": ["One issue, because the description names no chapters."],
    "files": ["project.yaml", "story/story-bible.yaml", "... 1 more"],
    "tool": "claude",
    "problems": []
  }
}
```
<!-- /example:op.project.setup -->

### `story.update`

Applies a change to the canon, or folds in an uploaded source text. Commands:
source-analyze (with a source), story-bible, series-plan.

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
    "uploads": ["up_2026112618084763306_ab7c"],
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
    "uploads": ["up_202611261808490470h_7fd9"],
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
    "files": ["characters/CHAR_MARA/character.yaml"],
    "tool": "claude",
    "references": [],
    "sheet": null
  }
}
```
<!-- /example:op.character.update -->

### `character.sheet`

Draws one more sheet of a character. The result is a candidate.

| Param | Type | Meaning |
|---|---|---|
| `character` | string, required | Character id. |
| `sheet` | string | `turnaround` (default), `expressions` or `wardrobe`. |
| `outfit` | string | Wardrobe id, for a wardrobe sheet. Default: the character's default outfit. |

Steps: `sheet-compile`, `sheet-draw` (draw). Unlike `character.create`, a
sheet that cannot be drawn fails the job (`sheet_blocked`).

<!-- example:op.character.sheet -->
```json
{
  "params": { "character": "CHAR_MARA", "sheet": "expressions", "outfit": null },
  "steps": [
    { "id": "sheet-compile", "label": "Prepare the expressions sheet", "status": "done" },
    { "id": "sheet-draw", "label": "Draw the expressions sheet", "status": "done" }
  ],
  "result": {
    "character": "CHAR_MARA",
    "sheet": {
      "candidate": "characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png",
      "candidate_id": "CHAR_MARA_EXPR_V01",
      "record": "GEN_CHAR_MARA_02",
      "kind": "expressions"
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
  "steps": [{ "id": "write", "label": "Write the locations and props", "status": "done" }],
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
appended after the issue's existing ones.

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
    "fix_pass": false,
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
`<PAGE_ID>:review-<n>` (look) after them.

Result: `pages[]`, one per page, with `render` (the last version), `verdict`,
`outcome` (`pass`, `notes` or `flagged`), `passes`, `flagged`, `repairs` (how many were tried), `open_findings`,
`independent` and `stopped` (why the repairs stopped, or `null`). A page that
could not be drawn has `error: { code, message }` and the queue goes on. A
page skipped because it already passed has `skipped: true`. `passed`,
`with_notes`, `flagged` and `failed` count them (`with_notes` is part of
`passed`).

<!-- example:op.pages.generate -->
```json
{
  "params": { "pages": ["PG_001_001", "PG_001_002", "... 1 more"], "approve_plans": false, "regenerate": false },
  "steps": [
    { "id": "PG_001_001:prepare", "label": "Page 1: references and prompt", "status": "done" },
    { "id": "PG_001_001:draw", "label": "Page 1: draw", "status": "done" },
    { "id": "PG_001_001:review", "label": "Page 1: check", "status": "done" },
    { "id": "PG_001_002:prepare", "label": "Page 2: references and prompt", "status": "done" },
    { "id": "PG_001_002:draw", "label": "Page 2: draw", "status": "done" },
    { "id": "PG_001_002:review", "label": "Page 2: check", "status": "done" },
    { "id": "PG_001_002:repair-1", "label": "Page 2: repair 1", "status": "done" },
    { "id": "PG_001_002:review-1", "label": "Page 2: check repair 1", "status": "done" },
    { "id": "PG_001_003:prepare", "label": "Page 3: references and prompt", "status": "done" },
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
  "stopped": "The repair limit of 2 was reached."
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

A change request counts toward the page's repair cycles, and the project's
limit (`repair_policy.max_cycles`) is never raised or bypassed. So the job
takes one of two paths, and says which in `result.path` and in its steps:

- `edit` (`path_label`: "edited the existing image"). Steps: `request`,
  `compile`, `draw` (draw), `review` (look). The existing image is edited
  into the next version, with everything the request does not name locked.
- `redraw` (`path_label`: "redrew it from an updated plan"). The render's
  lineage has used its repair cycles. Steps: `request`, `plan` (plan),
  `compile`, `draw` (draw), `review` (look). The change is written into
  `page.yaml`, a fresh prompt is compiled, and the page is drawn again. The
  new render starts a new lineage (`repair_cycle` 0, `supersedes` null) and
  its review checks the requested change. The composition may differ from
  the earlier version, which the interface should tell the person.

`steps` are listed for the path that applies when the job is created.

Result: `page`, `from` (the render that was corrected), `finding` (id of the
recorded request), `path`, `path_label`, and the fields of a `pages.generate`
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
    { "id": "request", "label": "Record the request", "status": "done" },
    { "id": "compile", "label": "Prepare the correction", "status": "done" },
    { "id": "draw", "label": "Edit the existing page", "status": "done" },
    { "id": "review", "label": "Check the corrected page", "status": "done" }
  ],
  "result": {
    "page": "PG_001_001",
    "from": "PG_001_001_V01",
    "finding": "F01",
    "path": "edit",
    "path_label": "edited the existing image",
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

The same operation once the limit is reached:

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
    "path": "redraw"
  },
  "steps": [
    { "id": "request", "label": "Record the request", "status": "done" },
    {
      "id": "plan",
      "label": "Repair limit reached: put the change into the plan of the page",
      "status": "done"
    },
    { "id": "compile", "label": "Prepare a fresh drawing", "status": "done" },
    { "id": "draw", "label": "Redraw the page from the updated plan", "status": "done" },
    { "id": "review", "label": "Check the new page", "status": "done" }
  ],
  "result": {
    "page": "PG_001_002",
    "from": "PG_001_002_V02",
    "finding": "F02",
    "path": "redraw",
    "path_label": "redrew it from an updated plan",
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
  "steps": [{ "id": "prepare", "label": "Prepare the handoff for page 1", "status": "done" }],
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
            "url": "/api/projects/by-hand/raw/references/style/LOOK_SOFT_PENCIL_WARM_MASTER_V01.png?v=34omwxv9n2r",
            "width": 400,
            "height": 600,
            "bytes": 4056,
            "mtime": "2026-11-26T18:09:06.579Z"
          }
        },
        {
          "position": 2,
          "role": "identity",
          "asset_id": "CHAR_NELL_TURN_MASTER_V01",
          "path": "characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png",
          "image": {
            "path": "characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png",
            "url": "/api/projects/by-hand/raw/characters/CHAR_NELL/refs/CHAR_NELL_TURN_MASTER_V01.png?v=2dtmwxv9nlb",
            "width": 400,
            "height": 400,
            "bytes": 3089,
            "mtime": "2026-11-26T18:09:07.247Z"
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
    "upload": "up_202611261809081643w_6400"
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
    "message": "Codex is not installed, and it is the only tool here that draws. Use the manual handoff (page.manual): the studio prepares the prompt and the referenc…"
  }
}
```
<!-- /example:error-no-draw-tool -->

### `cover.create`

The optional cover of an issue. Command: cover.

| Param | Type | Meaning |
|---|---|---|
| `issue` | string | Default `ISS_001`. |
| `description` | string | What the cover shows. Empty: the AI proposes one. |
| `draw` | boolean | Default `true`. `false` writes `cover.yaml` only. |

Steps: `write` (plan), `compile`, `draw` (draw), `review` (look), with repair
steps `repair-<n>` and `review-<n>` as for a page. The drawing steps are
skipped, with `result.drawn: false` and a `reason`, before a look master
exists or with no drawing tool. Approve the result with
`POST .../approve/cover`.

<!-- example:op.cover.create -->
```json
{
  "params": { "issue": "ISS_001", "description": "Mara at the wheel at night, the river behind her.", "draw": true },
  "steps": [
    { "id": "write", "label": "Write the cover", "status": "done" },
    { "id": "compile", "label": "Prepare the cover", "status": "done" },
    { "id": "draw", "label": "Draw the cover", "status": "done" },
    { "id": "review", "label": "Check the cover", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
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

<!-- example:op.cover.correct -->
```json
{
  "params": {
    "issue": "ISS_001",
    "render": "CV_001_V01",
    "text": "Make the title larger.",
    "region": null,
    "lettering": true,
    "path": "edit"
  },
  "steps": [
    { "id": "request", "label": "Record the request", "status": "done" },
    { "id": "compile", "label": "Prepare the correction", "status": "done" },
    { "id": "draw", "label": "Edit the existing cover", "status": "done" },
    { "id": "review", "label": "Check the corrected cover", "status": "done" }
  ],
  "result": {
    "issue": "ISS_001",
    "from": "CV_001_V01",
    "finding": "F01",
    "path": "edit",
    "path_label": "edited the existing image",
    "render": "CV_001_V02",
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
    { "id": "overlay", "label": "Build the lettering overlays", "status": "done" }
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
      { "page": "CV_001", "render": "CV_001_V02", "verdict": "fixed" },
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

One chat message. It is started by `POST .../chats/:key`, which stores the
person's message first; `POST .../ops` refuses it. Its parameters are `key`
(the screen key) and `text` (the message), which that route fills in. Step:
`reply` (plan). Result: `{ key, message }` with the assistant's message.

<!-- example:op.chat.turn -->
```json
{
  "params": {
    "key": "page:PG_001_003",
    "text": "EDIT bring the last panel closer",
    "message": "msg_2026112618085834824_13d9"
  },
  "steps": [{ "id": "reply", "label": "Answer the message", "status": "done" }],
  "result": {
    "key": "page:PG_001_003",
    "message": {
      "id": "msg_2026112618085857727_7c92",
      "at": "2026-11-26T18:08:58Z",
      "key": "page:PG_001_003",
      "role": "assistant",
      "text": "This is the fake assistant. You wrote: \"EDIT bring the last panel closer\". With a real tool installed, the answer comes from Claude Code or Codex. I a…",
      "job": "job_2026112618085835225_ac5d",
      "tool": "claude",
      "reply_to": "msg_2026112618085834824_13d9",
      "files": ["issues/ISS_001/pages/PG_001_003/page.yaml"],
      "commit": "c847674088acb2c70ce6f1e13be557aeb4da52ee",
      "decisions": []
    }
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
| `EDIT` | A chat message | The reply also changes the first file of the screen. |

`STUDIO_FAKE_TOOLS` lists the tools the fake reports as installed, for
example `STUDIO_FAKE_TOOLS=claude` to see the interface with no drawing tool.

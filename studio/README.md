# Comics studio

A local web app on top of the scaffold, for people who will not work from an
editor. A person describes a comic, picks a style, adds characters, writes
what happens, and gets reviewed pages to correct and publish. The studio
writes the same workspace files the scaffold defines, so a project made here
opens in an editor with the slash commands, and the other way round.

This directory holds the server (`server/`), the prompt templates it sends to
the AI tools (`prompts/`), its API reference ([docs/api.md](docs/api.md)), and
the browser app (`web/`).

## Requirements

- Node.js 18 or later. The studio has no dependencies to install. The one
  library the browser app uses, three.js, ships as a file inside
  `web/vendor/three/` (see [The browser app](#the-browser-app)).
- git, for the history. Without it everything works except going back to an
  earlier state.
- At least one of the two command-line tools, installed and signed in:
  - Claude Code (`claude`) plans, writes and reviews.
  - Codex (`codex`) draws. It can also plan and review when Claude Code is
    not there.

With only Claude Code, pages are made by hand: the studio prepares the prompt
and the reference images, and the person uploads the result. With only Codex,
it does all three jobs, and every review is marked as not independent,
because the tool that drew a page is the one checking it.

The studio uses no paid API. Each tool runs under the login the person
already has, and its usage counts against that subscription.

## Start

From the repository root:

```bash
npm run studio
```

or `node studio/server/index.js`. It prints its address
(`http://127.0.0.1:4310`) and opens the browser.

| Option | Meaning |
|---|---|
| `--port <number>` | Port to listen on. Default 4310. |
| `--home <dir>` | Where projects live. Default: `STUDIO_HOME`, else `comics-studio` in the user's home directory. |
| `--no-open` | Do not open the browser. |
| `--fake` | Fake mode (see below). Same as `STUDIO_FAKE_AI=1`. |
| `--help` | Print the options. |

| Variable | Meaning |
|---|---|
| `STUDIO_HOME` | Default for `--home`. |
| `STUDIO_FAKE_AI=1` | Fake mode. |
| `STUDIO_AI_TIMEOUT_MS` | Limit for one AI call. Default 1800000 (30 minutes). |
| `CLAUDE_BIN`, `CODEX_BIN` | Path of each tool when it is not on `PATH`. |
| `CODEX_IMAGE_TIMEOUT_MS`, `CODEX_IMAGE_MODEL` | Read by the scaffold's `codex-cli` provider when it draws. |

## Where projects live

Each project is one directory in the studio home:

```
<home>/<project>/
├── production/    the scaffold workspace: project.yaml, story/, style/, characters/, issues/, editions/ ...
├── .studio/       settings.json, state.json, activity.jsonl, jobs/, uploads/,
│                  conversations/, proposals/, timings.jsonl, assumptions.json
└── .git/          one commit per finished step
```

`chats/` may also be there, from an earlier version that had one
conversation per screen; its messages are folded into the project
conversation the first time it is read.

`production/` is an ordinary workspace: `node scripts/validate-workspace.js
--root <home>/<project>/production` works on it, and so does every command of
the scaffold. `.studio/` is the studio's own state and stays out of the
history. Deleting a project in the studio moves its directory to
`<home>/.trash/`; nothing is erased.

## How the AI is called

Every AI step is one headless run of a CLI, with the scaffold root as working
directory and the project directory added as writable. The prompt goes in on
standard input, never on the command line. It names the scaffold command
files to follow (`commands/story-bible.md` and so on), the workspace root, the
person's input, and a short contract: nobody can answer during the run, so
the tool decides what a command would ask and lists its decisions, or stops
and returns a question when the choice is the person's alone. The run ends
with a JSON object (`status`, `summary`, `files_written`, `decisions`,
`questions`, `data`) that the studio reads.

Claude Code:

```
claude -p --output-format stream-json --verbose --json-schema <schema>
       --setting-sources project --strict-mcp-config
       --permission-mode acceptEdits
       --allowedTools "Read,Write,Edit,Glob,Grep,Bash(node scripts/*)"
       --add-dir <project dir> [--model <model>] [--resume <session id>]
```

A read-only run (a review) uses `--permission-mode dontAsk` and
`--allowedTools "Read,Glob,Grep"`. `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
are removed from the child's environment, so the studio can be started from
inside a Claude Code session. Tool calls in the event stream become the
progress lines of a job.

Codex:

```
codex exec --skip-git-repo-check -s workspace-write -C <scaffold root>
      --add-dir <project dir> --json --output-schema <file> -o <file>
      [-m <model>] [-i <image>]... -
```

A read-only run uses `-s read-only`. A chat continues with `codex exec resume
... <session id> -`, which takes its sandbox as `-c` overrides. Drawing does
not go through this driver: it goes through the scaffold
(`compile-prompts.js`, then `generate-assets.js` with the `codex-cli`
provider), so a page drawn by the studio has the same package, record and
file names as one drawn from an editor.

Both tools are started through `providers/lib/cli-spawn.js`, which finds the
executable on Windows and elsewhere and stops the whole process tree when a
job is cancelled. A run fails on its exit code or a missing result, never on
what the tool prints to standard error.

Which tool does what is a setting per project (plan, look, draw), with a
model per tool and verb. When the tool a verb is set to is not installed, the
other one takes it and the job says so.

## Models

The Settings screen offers, per job, the models the installed tools report.
Neither CLI has a command that only lists its models, so the server reads
what each tool keeps on disk when it starts (and again when asked through
`POST /api/tools/refresh`), never on every request:

- Claude Code keeps the model catalog it downloads in
  `~/.claude/cache/model-catalog/`. It lists the models, the aliases
  (`fable`, `opus`, `sonnet`, `haiku`) and the account's default. Without
  it, the server falls back to the aliases that `claude --help` names, marked
  as documented.
- Codex keeps its catalog in `~/.codex/models_cache.json`; without it,
  `codex debug models --bundled` prints the list built into the binary
  without going to the network. The default is the `model` of
  `~/.codex/config.toml`.

Every model in the answer says where it came from, and a name typed by hand
is still accepted. The details, file by file, are in
[docs/api.md](docs/api.md#where-the-model-lists-come-from).

Every AI call is timed and recorded per project in `.studio/timings.jsonl`
(tool, model, job, duration, how many pages it worked on). The settings
route returns the averages per model, including the time per page, so the
interface can say how long a page takes with the model the person picked.

## The person writes the story

Creating a project starts no AI job. The server saves the description as
the person's source text (`story/source/description.md`), writes a story
bible that is empty but valid (its premise is the description) and a series
plan of one issue with the page count given. `validate-workspace.js` passes
on it, and every later step (style, characters, pages, cover, publishing)
works with a story bible that holds only that.

The AI writes story text only when asked: "draft a story bible from my
text" (`story.draft`), "complete what is missing" (`story.complete`), a free
request such as "suggest an ending" (`story.suggest`), or a chat message.
Each of these runs read-only and returns a proposal, stored in
`.studio/proposals/`: parts (the premise, the tone, each world rule, each
fact, each arc, each timeline event, each question) that the person
accepts, edits or rejects one by one. Only accepted parts reach
`story/story-bible.yaml`, through the scaffold's comment-keeping YAML
helpers, as one commit. Where the person's text leaves open something the
story needs, the AI asks: a question part, or a job that stops with
`needs_decision`. It does not decide for them.

Page planning follows the same rule. The AI turns the person's text into
panels and adds no event of its own. What it has to fill in to make a page
drawable (who stands where, what someone holds, the background) comes back
as a list of assumptions per page and panel, shown on the page so the
person can change any of it.

## Styles

The Style screen lists the look presets of `templates/looks/`. Each one comes
with its sample page when it has been drawn
(`templates/looks/previews/<preset>.png`, served by
`GET /api/presets/:key/preview` with a long cache) and with the list of what
tends to drift across pages with that look. A style described in words or
taken from uploaded images has no sample until its own look page is drawn.

## One conversation per project

The chat is one conversation per project, open on every screen. Each
message carries the screen it was sent from, and the AI gets that screen's
files, so "change this" means what the person is looking at. A reply can
suggest screens to go to; the server keeps only the links that name real
screens of the project. The conversation continues through the tool's own
session (`--resume` for Claude Code, `codex exec resume` for Codex). When
the answering tool changes, the new one starts a session of its own with a
summary of the last messages, and the transcript says so. A chat never
writes the story bible: story text comes back as a proposal, and a reply
that wrote the file anyway is undone. The person can start a fresh
conversation; the earlier ones stay readable.

## The browser app

`web/` is plain ES modules, CSS and one HTML file, with no build step. It
runs under the server's Content-Security-Policy (`default-src 'self'`), so
nothing loads from another host and there are no inline scripts.

The frame has three parts. The path of the comic runs down the left as a
strip of numbered panels: inked when a step is done, yellow for the next one.
The screen sits in the middle, with the artwork given the larger share. The
conversation is docked on the right and keeps its messages while the person
moves between screens; each message shows the screen it came from, links in
replies open the screen they name, and "New" starts a fresh conversation
while the earlier ones stay readable. Below 1240 px the conversation floats
over the screen and opens only when asked.

The person can arrange the frame. A handle between each side and the
screen changes its width within limits; arrow keys move a focused handle,
and a double click or Enter puts it back. Each side collapses to a thin
rail: the path keeps its step numbers, the conversation keeps one button
that shows a marker when a reply arrives. Focus mode (the button in the top
bar, or Ctrl+Shift+F) hides both sides at once. Below 760 px the path
becomes a drawer opened from the top bar. The layout is kept in this
browser for the person, not per project, and survives a reload.

What each screen asks of the person:

- Projects: the comics as covers, a new comic, the tools found on this
  machine. Creating a comic asks for a title, a description and a few
  options, and starts no AI job.
- Story: the person's own text and the story bible to fill in. The AI writes
  only through four explicit actions (draft from my text, complete what is
  missing, suggest something, apply my change) or the conversation, and what
  it proposes opens in a review where each part is accepted, edited and
  accepted, or rejected.
- Style: every preset as a large card with its sample page, grouped as in
  `templates/looks/README.md`, a comparison of up to four side by side, and
  what tends to drift under "details". Words and reference images can be
  mixed in.
- Pages: the plan of each page, what the planner filled in that the text did
  not say (each item can be changed through the conversation), the drawing,
  and while a page is drawn, a waiting state that says what is happening and
  how long a page usually takes in this comic.
- Settings: per kind of work (planning, checking, drawing) the tool, then a
  model from the list the installed tool reports, the default marked, a name
  typed by hand when needed, and the time measured with each model. Without
  Codex, drawing says the pages are uploaded by hand.

Both languages (English and Spanish) have the same keys in
`web/js/i18n/en.js` and `es.js`; the text the server writes arrives in the
interface language and is shown as it comes. Light and dark themes follow
the system unless the person picks one.

### 3D and motion

Four places use three.js: the shelf of covers on the Projects screen, the
ring of sample pages on the Style screen, the drawn page as a sheet that
leans toward the pointer, and the waiting scene in which a blank page is
inked while Codex draws. Moving along the path turns the screen like a page,
with CSS only.

three.js r170 is vendored as one file, `web/vendor/three/three.module.min.js`,
taken from the npm package `three@0.170.0`, with its MIT license beside it in
`web/vendor/three/LICENSE`. It is not a `package.json` dependency. Only
`web/js/gl/stage.js` loads it, with a dynamic `import()`, when a screen
mounts a 3D stage, so screens without 3D never download it. A stage draws
only while it is on screen and the tab is visible, scales sample images down
before they reach the graphics card, and keeps a flat version of the same
content underneath. Without WebGL the flat version stays and three.js is not
fetched. With reduced motion the scenes draw still frames when something
changes, and no transition runs.

## What a page goes through

1. The plan: `pages.plan` runs the scaffold's issue breakdown and
   `smart-page`, then the two mechanical gates (`check-continuity.js`,
   `validate-workspace.js`), with one automatic fix pass when they report
   errors. The person reads a short plan per page and approves it.
2. The drawing: per page, in order, the studio builds the reference plan,
   compiles the prompt, and draws.
3. The check: the look driver opens the image beside the plan and the
   references and returns evidence for fourteen checks. The studio writes the
   review file from that, by the review rules of `docs/data-model.md`.
4. Notes and repair: a review whose findings are all minor passes, and the
   findings are shown as notes for the person to read. Only a blocking
   finding or a failed gate flags the page. Then, when the review says a
   repair can fix it, the studio repairs the page as a new version and checks
   again, up to the project's repair limit. A page that still fails is left
   flagged with its evidence.
5. Corrections: a change the person asks for is recorded as a finding on the
   review and counts toward the same limit. Below the limit the existing
   image is edited. At the limit the change goes into the page plan and the
   page is drawn again, as the scaffold's repair-limits rule asks. The job
   says which of the two happened.

The automatic check is an AI reading an image. It catches a lot and it is not
a guarantee, so the interface shows the evidence with every verdict, and the
person's approval is recorded apart from it. The scripts and the tests check
files; only a review says anything about a drawing.

## How long things take

Measured on 2026-11-26 in one run of a two-page issue with a cover, with
Claude Code 2.1.314 planning and reviewing and Codex 0.167.1 drawing. Each
figure is the whole job, from the click to the last commit.

| Job | Time |
|---|---|
| `project.setup` (story bible and series plan, as it worked then) | 92 s |
| `style.define` | 152 s |
| `style.look` (one look page) | 157 s |
| `character.create`, with its turnaround sheet | 150 to 180 s per character |
| `pages.plan`, two pages | 496 s |
| `pages.generate`, two pages | 1914 s |
| `cover.create` | 491 s |
| `publish.build`, five formats | 5 s |

The run took about an hour from an empty project to the exported files. In
it, every page and the cover were repaired twice for minor findings, which
is where most of the drawing time went. The studio no longer repairs for
minor findings (they are shown as notes), so a page that draws well costs
one drawing and one review. The interface should let the person keep working
on other screens while a job runs: nothing here is quick.

## History

After every step that changed files the studio commits the project directory
with a readable message, under its own identity (`Comics Studio
<studio@localhost>`), so nothing depends on the person's git configuration.
Every entry of the activity log links to its commit. Restoring an earlier
point makes a new commit that brings the workspace back to that state: files
added later leave the workspace and stay in git, so the later state can be
restored too. The same repository answers two read-only questions for the
interface: what a point of the history changed, file by file, and what a
file looked like at that point. Without git the activity log still works and
those two answer that the history is not available.

## Language

The server writes its own text in English and in Spanish: job titles, step
labels, the summaries and blockers of the project home, history titles and
error messages. A project has an interface language, and a request can ask
for another with `?lang=`. Jobs and history entries are stored with the code
of each sentence, so they read in whichever language they are asked for.
Every sentence comes with that code and its values, for an interface that
prefers its own wording. The dictionaries are in
`studio/server/i18n-text.js`. What a tool wrote, the scaffold's mechanical
findings and the job log stay as they were written.

## Fake mode

```bash
STUDIO_FAKE_AI=1 node studio/server/index.js
```

No CLI is called. Every operation runs its real path (the prompt is built,
the contract result is read, the scaffold's scripts compile and record, the
review file is written, the step is committed) and finishes at once with
placeholder files and images. It exists for the tests and for trying the
interface. Words in the text change what the fake does, such as `FLAG` for a
page whose first review fails; the list is at the end of
[docs/api.md](docs/api.md#fake-mode).

## Safety of a local server

The server listens on 127.0.0.1 only. It refuses requests whose `Host` header
is not its own address, which stops a web page from reaching it through DNS
rebinding, and it refuses writes that come from another origin. Every file
path sent by the browser is resolved and has to stay inside the project's
workspace. Uploads take images and text files only, with size limits. HTML
and SVG files of the workspace are served sandboxed, so they never run with
the app's origin. The exported web reader is one of them: it opens in the
app or in a tab, and only its page images are sent with a policy that lets
the sandboxed reader load them.

## Tests

`tests/studio-*.test.js` run with the rest of the suite (`npm test`), in fake
mode, each on a temporary studio home. They drive the server over HTTP: the
whole pipeline from a project that holds only the person's description,
story proposals decided part by part, the project conversation, the model
lists (read from files in a temporary home), cancel, questions and answers,
the event stream, the checks above, and the command lines built for both
tools. No test starts a real CLI.
`studio/test-support/record-api-examples.js` refreshes the examples in the
API reference from such a run.

## Limits

- One job runs at a time per project. Drawing one page with Codex took about
  five minutes when it was measured, so an issue is a long queue.
- Codex returned pages at 1024 x 1536 pixels in that measurement, below the
  default page size of a project. The studio does not upscale.
- A character sheet is drawn from the written description and the look
  master. An uploaded photo informs the description and is attached to later
  sheets and to pages as an identity reference, but the scaffold does not
  attach it to the first turnaround sheet.
- Pages are drawn whole. The scaffold's per-panel mode is not used.
- Lettering is one mode per project. In overlay mode the browser flattens
  each page; the server cannot.
- The style of a project is fixed once its look is approved. A different
  style means a new project.
- Publishing builds files. It does not upload them anywhere.
- The studio is for one person on their own machine. It has no accounts and
  must not be exposed to a network.

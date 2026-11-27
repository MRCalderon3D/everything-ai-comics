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
and the reference images, and the person uploads the result. Any image can be
made that way, even with Codex installed: ask the conversation for the prompt
and the references of a page, download them in their numbered order, and
attach the finished image to the conversation saying which page it is for.
With only Codex,
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

No AI run writes the story bible, except `story.update`, which applies a
change the person asked for. Any other run that changes it (a character run
that adds an invented relative as a fact, for example) has the change undone
inside its step, and what it wanted to add becomes a story proposal the
person accepts or rejects (`server/bible-guard.js`).

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

Every prompt of the conversation carries a short state of the project, read
from the workspace when the message is sent: the style and look, each
character and whether its sheet is approved, each issue with its pages,
cover and editions, the jobs running and the last ones finished, the
questions waiting for an answer. The conversation knows what was done on the
screens, and the screens show what the conversation did, because both write
the same files. A message can carry images and text files, dropped, pasted
or picked; they go through the upload store, the prompt names them by path,
and images also go to the tool. A message sent while another job runs is
answered at once in a read-only lane of the queue: the reply can answer and
propose work, and changes no file.

## The chat can do what the screens do

The server keeps one catalog of actions (`server/actions.js`): every
operation except `chat.turn`, with the operation's own parameters and
checks, and the decisions the screens make without a job (approvals, story
proposals, the project options, answering or cancelling a job, the next
issue). The catalog goes into every chat prompt. A reply proposes work in
its structured output, and the server checks each proposal the way the
screen's request would be checked and shows it as a card in the transcript:
what it will do, the tool and model, and how long it usually takes, measured
in this project or taken from the run below. A proposal that does not check
out is left out, with the reason in the reply and in the job log.

The model proposes and the server runs. A card runs when the person clicks
Run, or when they confirm in words and the next reply names the card. When
the message itself asks for exactly that action, now ("draw the look page",
"acepta toda la propuesta"), the reply marks the card `run` and it starts in
the same turn, drawing included, and the card says it ran on the person's
request. A card the model only suggests waits. A delete or a merge always
waits for a click.

Cards proposed together are a sequence. "Approve the plan of page 1 and draw
it" gives two cards; the drawing would be refused on its own, because the
plan is not approved yet, so it is kept as "after card 1", checked again
when its turn comes, and runs once the approval is done. If the first card
fails or is dismissed, the second is cancelled with the reason. A card's
parameters show with plain labels and the names of characters and places;
the raw names stay under "Details". An
operation goes through the normal queue, with its progress shown live on the
card; a decision runs through the same code as the screen's button. Work
that only writes text may start at once if the person turns that on in
Settings. Drawing, approving and answering always wait for them. A change to
the lettering of a page (`page.lettering`) shows on its card as the
balloons it adds, removes, changes or moves, before anything is saved. A
correction of an image at the touch-up warning shows the warning and two
buttons, touch up anyway and redraw with the change, in place of Run; it
never starts by itself, even when the message asked for it. When a job
started from a card ends or stops to ask, its result comes back into the
conversation: the outcome, the images it drew, links to the screens where
they are approved, and the questions, which can be answered right there. A
photo used for a character shows the same rights notice as the Characters
screen.

## Guide me

Someone who does not know the steps, or would rather not use the screens,
can let the conversation lead. "Guide me" is a switch at the top of the
conversation, and a box ticked by default on the new-comic form. It is a
mode of the project conversation, not a second chat: turning it off keeps
everything, and a fresh conversation keeps it on.

The guide reads where the project stands from the same step state the side
navigation paints, and narrows it to the one decision of now
(`server/guide.js`): tell the story in your words, pick a style from the
gallery (the preset sample pages, shown as a pickable list in the chat),
draw the look page and approve it, name the characters and approve their
sheets, say what happens and how many pages, read and approve the plans,
draw the pages (the button says how many images), look at each page and
approve it or say what should change, a cover or not, and the files to
publish. A job waiting for an answer, or paused because a tool ran out of
quota, comes first. Each message says what the step is, why it comes now
and what the person decides, and explains a term (look page, sheet, plan,
check, touch-up, edition) the first time it comes up.

Every action still goes through cards. A click on one of the guide's
choices makes the cards and runs them as the person's request; drawing says
how long it usually takes. Answers in words go to the AI with the step and
the guide's rules in its prompt: answer the question first, one decision at
a time, the story and the approvals are the person's, and end with the next
step. When a job or a decision settles (from a card, a chat reply, or a
screen), the guide posts the result and the next question on its own, from
a template, with no AI call. Nobody has to type "next". Detours are free: a
question gets its answer and the step stays; an approval made on a screen
moves the guide on.

## When a tool runs out of quota

Found in a real run: Codex's image tool hit its usage limit in the middle of
a twelve-page drawing, and the job went on failing page after page. Now a
usage-limit answer is its own kind of error. The scaffold's providers
recognise it (`providers/lib/quota.js`, matched on the tools' own wording
and broadly on "usage limit", "rate limit" and "quota") and record
`response.error_kind: tool_quota` on the generation record, with the reset
time when the tool gives one. Codex keeps rate limits for its text quota in
its session files; nothing there is about images, so the studio does not
show it as the image reset.

The job that meets it pauses where it stopped instead of failing. The pages
after it are not tried. The jobs queued behind it that need the same tool
pause too, untouched; the rest run. The person is told which tool ran out,
that nothing is wrong with the pages, which pages wait, and when the tool
says the limit resets. One button resumes the job and the ones behind it:
what was drawn is not drawn again, a change request is not recorded twice,
and none of the failed attempts counts toward a repair or touch-up limit.
The conversation and the guide say the same and offer to resume later.

Before batch drawing (all pages of an issue, every missing sheet) the
confirmation says how many images it will draw, and a card that draws says
it too.

## More characters than the drawing tool takes

Codex takes five reference images per drawing. A page whose cast needs more
(the look page plus five characters, say) is caught when it is planned: the
continuity check runs against the provider that will draw, and the page
says, in plain words and with the characters' names, how many images it
needs and how many the tool takes. Two ways out are offered. "Draw it panel
by panel" sets the page's `generation.mode` to `per_panel` and rebuilds its
reference plan in the same step; each panel is then drawn as its own image
with only its own cast, and the person puts the panels together in the
layout and uploads the page, which is checked as any page. "Propose a
staging change" asks the conversation for a change of who stands where, as
a proposal with the reason. Nothing moves a character off panel to fit the
tool: who is in a panel is the person's story, and the chat's prompt says so.

## One face per character

Photos and drawings the person adds to a character are where its face comes
from. The studio shows them to the drawing tool for the character's first
turnaround or full character sheet only, with the instruction to translate
the person into the comic's style. Once the person approves a drawn sheet,
that sheet is the face: expressions, wardrobe sheets, pages and the cover
are drawn from it and never from a photo, and they wait for it
(`409 master_required` before then). A full sheet outranks a turnaround.

A sheet drawn from the approved one is compared with it right after it is
drawn (`sheet-check`, a read-only look by the checking tool). If the face,
hair, build or a sided mark differs, the sheet is drawn once more with what
the comparison found and compared again. Whatever comes out is shown, with
a warning when it still differs, and the person decides.

The full character sheet (sheet kind `model`) is one wide image (3:2) with
the name, a line with the series and the sheet number in the project's
language, the turnaround, labelled close-ups and a labelled row of
expressions and poses. The lists live in the character file's `sheet`
block. A round of changes (`character.sheet` with `revise`) first updates
the character file to match (a story fact becomes a proposal, as for any
run), then edits the chosen version into the next one with everything else
locked. Approving a version makes it the face; approving another later
replaces it, so the person can go back.

## What a page plan adds

Planning pages from the person's text can create the files of people,
places and objects the text describes and nobody had written yet: two
unnamed attackers and a child, say. They need a file to stay the same from
panel to panel. After every step that wrote files the studio lists the ones
it created on the job, and the Pages screen shows them under "What the plan
added", each with a link, "needs a sheet" for a character, and buttons to
rename it or edit it.

Before a step creates someone, its prompt lists every ID the project
already knows: entity files, the characters of the story bible, and the
characters of story proposals still waiting for the person, and asks to
reuse an ID for the same person. A word check runs after the step as well
(`server/entities.js`): a new file whose name and description match one of
those is flagged "may be the same as", with a button to merge it into that
one, or to take its ID when only the story names it so far.

A merge (`server/entity-edit.js`) points every reference of the merged ID
at the one kept, in pages, scenes, the story bible, open proposals and
wardrobe; the one kept keeps its file and its sheets, and the merged name
becomes an alias. A rename moves the files, sheets and every reference to the
new ID and leaves approved page plans approved. Both run the workspace
checks before and after and say if they broke anything.

While a page plan is being written, the plan's checks are not run for its
issue: they would report pages that do not exist yet. The Pages and page
screens say "planning page 6 of 12" instead.

## What changed while you were away

Sheets, plans and pages take minutes, and the person keeps working
elsewhere. When a job ends, its screen gets a dot with a count in the side
navigation (the collapsed rail keeps it), and the item inside the screen
gets a marker with one short line: "new expressions sheet", "page 4 drawn,
needs review", "the plan is ready". A job that failed or waits for an answer
counts too, in red, and comes first. An item stops being new when the person
opens it; it keeps its marker until they leave, so they see what changed.
Each screen has "Mark all as seen". The seen state lives in the browser per
project (`web/js/unseen.js`), survives a reload, and is built from the jobs
the server already sends; the chat's result messages carry the same dots.
With reduced motion the dots appear without animation.

## Deleting

Every image that is not in use has a delete control: sheet candidates and
old masters, look pages, page versions and repair attempts, cover versions,
uploads, draft editions. A whole character, place or prop can go, and the
last page of an issue. "Clean up unused tries" on a screen lists every
unused try there, all ticked, to delete at once.

One module (`server/deletion.js`) knows what belongs to each thing (the
file, its registry entry, its generation record, the reviews of a render,
the references in character files and plans) and what uses it. It refuses,
saying what to do first, when pages were drawn from it, an edition ships
it, or a planned page lists it. Deleting an approved master asks twice and
lists what depends on it. Each delete is one commit, so History can bring it
back; uploads live outside the history, and the confirmation says so. The
workspace checks run after, and the answer says if anything broke. The chat
can delete too, always as a card the person runs.

## The next issue

A project is a series. "New issue" on the Pages screen or the project home
(or the `issue.create` action of the conversation) asks for a title and a
rough page count, then writes the series-plan entry and the new
`issue.yaml`, nothing else. Look, characters, places, props and the story
bible stay the project's. `opens_from` points at the state the previous
issue ended in: `continuity/<ISS_ID>.final-state.yaml` as
`/continuity-review` wrote it, or, when that file is missing, one the
studio derives from the last ledger rows of each character and prop. The
first plan of the new issue reads it, and `check-continuity.js` checks the
first page against it. The issue picker on the Pages, Check, Corrections,
Cover and Publish screens follows the chosen issue, and pages added to an
issue that already has an edition go after its last page, so the next
publish makes the next edition.

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
while the earlier ones stay readable. "Guide me" in its header turns
[guide mode](#guide-me) on and off. Below 1240 px the conversation floats
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
  options, and starts no AI job. "Guide me through it in the chat" is ticked
  by default: the comic then opens with the conversation and its first
  question.
- Story: the person's own text and the story bible to fill in. The AI writes
  only through four explicit actions (draft from my text, complete what is
  missing, suggest something, apply my change) or the conversation, and what
  it proposes opens in a review where each part is accepted, edited and
  accepted, or rejected.
- Style: every preset as a large card with its sample page, grouped as in
  `templates/looks/README.md`, a comparison of up to four side by side, and
  what tends to drift under "details". Words and reference images can be
  mixed in.
- Characters: each character's drawn sheets and where its face comes from.
  A sheet that is missing says why (the look is not approved yet, nothing
  can draw, a candidate waits for approval). Expressions and wardrobe sheets
  stay unavailable, with the reason, until a turnaround or a full character
  sheet is approved. The full sheet has its own panel: the close-ups and
  poses to draw, edited as lines, the versions side by side with a
  comparison, approval of one of them, and a round of changes on any
  version with text, a marked region and an optional photo. Once the look
  is approved, the Characters screen offers to draw the sheets still
  missing.
- Places and objects: the place and object files the page plans wrote, each
  with its description, a place with its map when it has one, and its
  reference image if one was drawn. "Write places and objects" fills in the
  files the planned pages still lack (or works from a description of pages
  not written yet), and can also draw a reference image of each place once
  the look is approved. Most comics never need this screen.
- Pages: the plan of each page, what the planner filled in that the text did
  not say (each item can be changed through the conversation), the drawing,
  and the lettering of each panel. The lettering editor adds, removes and
  reorders balloons, captions and sound effects, picks the kind by its plain
  name and icon, picks who says it from the panel's cast or as a voice from
  off panel, shows where the tail points, and counts words and balloons
  against the lettering rules while typing, with a warning before saving
  when a panel goes over. Saving runs the page's checks again. On a page
  already drawn it says the change needs the page drawn again (or lettered
  again in overlay mode) and offers that. One button draws every page with
  no passing version, or the pages the person ticked, after saying how many
  images that is. While a page is drawn, a waiting state says what is
  happening and how long a page usually takes in this comic.
- Settings: per kind of work (planning, checking, drawing) the tool, then a
  model from the list the installed tool reports, the default marked, a name
  typed by hand when needed, and the time measured with each model. Without
  Codex, drawing says the pages are uploaded by hand. A switch lets the
  conversation start text-only work without a click. "Touch-ups before a
  warning" (0 to 10, default 2) is written to `project.yaml`
  (`repair_policy.touch_up_warning`), so the scaffold reads the same number.

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

### Design

`design/PRODUCT.md` says who the studio is for and what it must keep (the
artwork as the largest thing on screen, one next action per screen, plain
words in front of the person). `design/DESIGN.md` records the visual system
as it is in `web/css/base.css`: the print palette and the one job of each
colour, the type scale, corners by role, how state is shown, and the rules
a new screen follows. Read both before changing how a screen looks. The
tokens live in `base.css`; when a value changes there, change it in
`DESIGN.md` too.

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
   review, and the existing image is touched up into a new version. Every
   edit regenerates the whole image, so colours, line and faces wear a
   little each round. Once an image has had as many edits as the project's
   touch-up warning (2 unless Settings say otherwise), the correction form
   says so and offers both paths: touch up anyway, or redraw the whole page
   with the change written into its plan. The person chooses; the studio
   never picks for them. A touch-up they choose may go past the repair
   limit, which only stops the automatic repairs, and the automatic repairs
   after it still keep that limit. The job says which path it took.

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
one drawing and one review. Nothing here is quick, so the person keeps
working on other screens while a job runs.

## History

After every step that changed files the studio commits the files of that
step, and only those, with a readable message, under its own identity (`Comics Studio
<studio@localhost>`), so nothing depends on the person's git configuration.
Every entry of the activity log links to its commit. An approval, a save or
a delete made while a job writes in the same workspace commits only its own
files: the job's files stay in the job's commits, so undoing the approval
takes back the approval alone. Restoring an earlier
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
tools. Two of them make a whole comic: one only through the conversation
endpoints (messages, cards, answers), one mixing screens and conversation.
Others cover a commit made while another writer is busy in the same
workspace, possible duplicates with merge and rename, deletes and their
refusals, and chat cards that run in order on an explicit request. Guide
mode has its own: a whole comic made only by answering the guide (clicks on
its choices and answers in words, never "next"), and a job result that
brings the next guide message with no message from the person. The quota
tests run the drawing tool out in the middle of a job, check the pause, the
untouched queue and the resume, and do the same for a correction and for
the writing tool. A page whose cast is over the reference budget is drawn
panel by panel and uploaded. No test starts a real CLI.
`studio/test-support/record-api-examples.js` refreshes the examples in the
API reference from such a run.

## Limits

- One job that writes runs at a time per project. Drawing one page with
  Codex took about five minutes when it was measured, so an issue is a long
  queue. Chat turns are the exception: they answer beside it, read-only.
- Codex returned pages at 1024 x 1536 pixels in that measurement, below the
  default page size of a project. The studio does not upscale.
- The check that compares a sheet with the approved one looks at identity
  only (face, hair, build, sided marks). It does not judge the layout or
  the labels of a full character sheet: the person does.
- A page drawn panel by panel comes back as one image per panel. The studio
  does not put them together (the scaffold has no compositor): the person
  does, in the layout of the plan, and uploads the page.
- The quota recognition matches the wording Codex and Claude Code used in
  the runs and binaries looked at on 2026-11-27, and broadly "usage limit",
  "rate limit" and "quota". A tool that changes its wording may need a new
  pattern in `providers/lib/quota.js`.
- Lettering is one mode per project. In overlay mode the browser flattens
  each page; the server cannot. So the conversation can place overlay
  lettering but not flatten it: that last step is on the Publish screen.
- A real chat turn reads its attachments through the tool: Claude Code opens
  them with its Read tool inside the project directory, Codex gets images
  with `-i`. Whether `codex exec resume` accepts `-i` on a resumed session
  was not measured.
- The style of a project is fixed once its look is approved. A different
  style means a new project.
- Publishing builds files. It does not upload them anywhere.
- The studio is for one person on their own machine. It has no accounts and
  must not be exposed to a network.

# Changelog

## Unreleased

- Web studio, design pass: `studio/design/PRODUCT.md` and
  `studio/design/DESIGN.md` record who the studio is for and its visual
  system. Fixes from an audit of every screen in both themes and languages:
  - A danger button and a red count on the path were white on light red in
    the dark theme (2.1:1); they now use a `--bad-ink` token (8.7:1).
  - State is shown by a whole outline, a wash or words, never a bar down
    one side of a box: jobs in the queue, findings, accepted proposal
    parts, approved plans, readiness, the guide's captions, job results,
    tool rows, the check strip and toasts. Running work turns an arc
    instead of pulsing a dot.
  - Headings no longer skip levels (Style, a place, a page's plan and its
    lettering, History). History's restore buttons name the step they
    restore.
  - Names instead of IDs in front of the person: History titles, the
    conversation's cards and results, and Publish say "page 2", "issue 1"
    and "edition 1"; an edition titled like its comic shows the title once;
    "Another ID…" reads "Change its internal name…".
  - After publishing, the project home offers to read the comic instead of
    sending the person to publish again. The conversation on the overview
    and on History says it is about the whole comic.
  - Tablet and phone: the queue no longer slides under the focus button,
    the collapsed path hides its "collapse" label, the path never scrolls
    sideways, the phone's top bar drops focus mode and (under 560 px) the
    language, which stays in Settings, and the path's drawer button has its
    own icon.
  - On a check, the verdict sits beside the drawing down to 720 px of
    screen. Notes and verdicts inside a panel are no longer boxes in a box.
  - Smaller things: themed text selection, caret and scrollbars, a stable
    scrollbar gutter, 24 px targets for standalone small links, no lone
    last word on a line in the conversation.

- Web studio, "Guide me": a mode of the project conversation that leads
  from an empty project to a published comic, one decision at a time. It is
  offered on the new-comic form and switched from the conversation header.
  The step comes from the same step state as the side navigation
  (`studio/server/guide.js`): the story in the person's words (new action
  `story.text`), a style picked from the preset gallery shown in the chat,
  the look page, the characters and their sheets, the page count and plans,
  the drawing, each page, the cover, publishing. The guide explains a term
  the first time, shows what is to be approved, and after each job or
  decision posts the result and the next question from a template, with no
  AI call. Choices clicked go through cards
  (`POST .../conversation/guide/choose`); answers in words go to the AI with
  the step and the guide's rules in `chat.txt`. Mode on and off:
  `POST .../conversation/guide`; `POST /api/projects` takes `guide`.
- A tool out of its usage quota is its own error kind. Generation records
  get `response.error_kind: tool_quota` and `response.resets` (schema,
  `docs/data-model.md`), set by `markFailed` from the new
  `providers/lib/quota.js`, which matches the wording Codex and Claude Code
  use. `codex-cli` reads it from the final message and the error events. In
  the studio the job pauses where it stopped (status `paused`, `job.paused`),
  the pages after it are not tried, the queued jobs that need the same tool
  pause untouched, and `POST .../jobs/:job/resume` (or the action
  `job.resume`) picks them all up without drawing anything twice or
  counting an attempt toward a repair or touch-up limit. The conversation,
  the guide, the job drawer and the top bar say it in plain words with the
  reset time. Cards that draw say how many images (`images`), and batch
  drawing on the Pages and Characters screens confirms the count first.
- Web studio, reference budget (TODO item 15): the plan checks run against
  the provider that will draw (`mechanical(root, issue, { provider })`). A
  `REFERENCE_BUDGET` warning shows on the page in plain words with the
  characters' names (`findings.budget`) and two choices: draw the page panel
  by panel (`POST .../pages/:page/mode`, action `page.mode`, which rebuilds
  the reference plan in the same step), or ask for a staging change as a
  proposal. `pages.generate` draws a per-panel page as one image per panel
  and leaves it for the person to assemble and upload; `page.manual` takes
  the assembled page with every reference of the page for its review. The
  chat never changes who is in a panel to fit a tool without a proposal
  (`chat.txt`). The fake codex answers with `reference_mode` and
  `references_count`.
- `compile-prompts.js --touch-up` (`touchUp: true`): a repair compile that
  goes past `repair_policy.max_cycles`, only when the review holds an open
  change request of the person. The studio uses it instead of reading the
  project with a raised limit in memory.

- Web studio: the plan review of a page edits its lettering. Per panel,
  balloons, captions and sound effects can be added, removed and reordered,
  each with its kind by plain name and icon (speech, thought, shout,
  whisper, radio or phone, caption, narration, sound effect, sign), its
  speaker from the panel's cast or as a voice from off panel, and a line on
  where its tail points. Words per balloon, words per panel and balloons per
  panel are counted while typing, from `project.lettering` and the rule's
  defaults, and a panel over them asks before saving. The plan saves through
  `PUT .../pages/:page/plan` (`studio/server/lettering-plan.js`): ids kept,
  reading order renumbered, an off-panel ledger row added for a voice from
  outside the frame, the page validated and its continuity checked. On a
  drawn page the answer says it needs drawing again, or lettering again in
  overlay mode, and the screen offers it. The chat does the same with the
  action `page.lettering`, whose card shows the change before it runs.
- The touch-up limit is a warning the person decides on. New project field
  `repair_policy.touch_up_warning` (default 2; schema, template, example,
  `create-project.js`, `docs/data-model.md`): once an image has had that
  many edits, a touch-up the person asks for comes with a warning that more
  may degrade it and the offer of a redraw from the plan. `max_cycles` now
  only stops the automatic repairs. `validate-workspace.js` accepts a review
  past `max_cycles` when the render it edited holds the person's change
  request. The rules (`repair-limits.md`, `cost-control.md`), the repair and
  review skills and commands, and the guides say so.
- Web studio: `page.correct` and `cover.correct` take `mode` (`touch_up` or
  `redraw`). At the warning a request without it is refused with 409
  `touch_up_choice`, and the correction form, the review's "correct this"
  and the chat card offer both choices. Settings has "Touch-ups before a
  warning", written to `project.yaml`.

- Image provider `codex-cli`: the instruction lists the absolute path of
  every input image and asks Codex to call its image tool with
  `referenced_image_paths` set to those paths, in order, instead of relying
  on attached images (`num_last_images_to_include`, which keeps 5 and drops
  the rest silently). Codex reports `reference_mode` and
  `references_count`; both go into the response summary, and a count lower
  than the number of images sent fails the run and discards the image.
  Measured with Codex CLI 0.167.1: the tool rejects 6, 8 and 10 paths
  ("at most 5 paths") and holds every identity at 5, so the budget stays 5.
- Reference plans record the `generation.mode` they were built for
  (`mode: full_page | per_panel`). `compile-prompts.js` rebuilds and
  rewrites a plan built for another mode, provider or budget before
  compiling, or fails with the reason and the build error when the rebuilt
  plan does not fit. `build-reference-plan.js --if-stale` runs the same
  check. Found in a real run: switching a page to `per_panel` left the old
  plan, and the next draw failed.
- `check-continuity.js` warns at plan time (`REFERENCE_BUDGET`) about
  pages and panels whose drawn cast needs more required reference images
  than the image provider takes, naming the panels and saying whether
  drawing panel by panel would fit. `--provider` (and `opts.provider`)
  checks against a provider other than the page's.
- Web studio: a commit holds only the files of its own step or action. A
  job step commits the files that changed while it ran; a save, an
  approval, a delete or a merge commits the files it names, through a
  temporary index (`git.commitPaths`), and running steps leave those files
  out. Found in a real run: three character files written by a page plan
  went into the commit of a sheet approval made at the same time.
- Web studio: what a step added. After every step that wrote files, the
  character, place and prop files it created are listed on the job
  (`added_entities`) and compared, by the words of their names, aliases,
  descriptions and IDs, with the entity files, the story bible's characters
  and the open story proposals; a close match is flagged as a possible
  duplicate. The prompts that may create an entity list the known IDs and
  ask to reuse them. New routes merge one entity into another and rename an
  ID (`POST .../entities/merge`, `POST .../entities/rename`, and the chat
  actions `entity.merge` and `entity.rename`), rewriting every reference and
  running the workspace checks before and after. The Pages screen lists what
  the plan added, and its checks wait while the plan is written ("planning
  page 6 of 12").
- Web studio: markers of what changed while the person was on another
  screen. A dot with a count per step of the side navigation (kept on the
  collapsed rail), a line on each item that is new, failures and questions
  in red, "Mark all as seen" per screen. Kept per project in the browser.
- Web studio: delete what is not wanted (`server/deletion.js`): sheet
  candidates and old masters, look pages, page and cover versions, uploads,
  draft editions, a whole character, place or prop, the last page of an
  issue. A delete removes the file, its registry entry, its generation record
  and reviews, and the references to it, as one commit; it is refused, with
  what to do first, when something uses it, and an approved master asks
  twice. "Clean up unused tries" per screen. Routes `POST .../delete/check`,
  `POST .../delete`, `GET .../cleanup`; chat action `delete`, which always
  waits for a click.
- Web studio, chat: a card the person's message asks for explicitly carries
  `run: true` and starts in the same turn (`run_by: "request"`); cards
  proposed together run in order, a card that needs an earlier one waits
  for it (`after`, status `waiting`) and is cancelled if that one fails.
  Card parameters show with plain labels and names. The chat prompt asks for
  replies without IDs or file names. The suggestion chips no longer quote
  the placeholder story.
- Web studio: the person's text is read from `story/source/description.md`,
  so what the chat or the editor saves there shows on the Story screen at
  once. The action card of a sheet revision names both tools it uses. The
  correction form says how many touch-ups are left before the next change
  redraws the whole page.

- One identity chain per character. Photos and drawings a person supplied
  are likeness sources, attached only to the character's first turnaround
  or full character sheet while no drawn sheet is approved. The approved
  turnaround or full sheet is the identity master: expression and wardrobe
  sheets, pages and covers attach it and never a photo. Expression and
  wardrobe sheets refuse to compile without it (`master_required`), and a
  page or cover whose character has only photos is refused. This fixes two
  sheets of one character drawn with two faces, when the turnaround went
  out without the photo and the expressions took the photo as identity.
  Existing registries need no edit: photos are told apart by kind.
- Full character sheet, sheet kind `model` (`--sheet model`, tag `MODEL`):
  one landscape image with the name and a line in the project's language,
  the turnaround, labelled close-ups and a labelled row of expressions and
  poses. The lists come from the new optional `sheet` block of
  `character.yaml`. `--revise <version> --changes "..."` edits a version
  into the next with everything else locked. An approved full sheet
  outranks a turnaround as identity master. The identity line of a page
  prompt now also says to letter none of the sheet's text.
- Web studio: `character.sheet` draws the full sheet and its revision rounds
  (`revise`, `text`, `region`, `changes`, `uploads`), and refuses
  expressions and wardrobe sheets before a master is approved. A sheet drawn
  from the master is compared with it (`sheet-check`) and drawn once more
  when the face differs. The character screen says plainly why a sheet is
  missing, shows the full sheet's versions side by side with approval and
  a round of changes with a marked region, and the Characters screen offers
  to draw the missing sheets once the look is approved. `has_identity` no
  longer counts a photo.

- Web studio: the conversation can do what the screens do. A message can
  carry images and text files (button, drop or paste); they go through the
  upload store and reach the tool by path, and images also as attachments. A
  reply proposes work as action cards (`studio/server/actions.js`, listed by
  `GET /api/actions`): every operation plus approvals, story proposals,
  project options, answering or cancelling a job, and the next issue. A card
  says what it will do, with which tool and model and how long it usually
  takes, and runs on a click or on a confirmation in words
  (`POST .../conversation/:conversation/actions/:card/run`). Text-only work
  may run at once when the new `chat_auto_run` setting is on. When a card's
  job ends or stops to ask, its result comes back into the conversation with
  the images, links to the screens that approve them, and the questions to
  answer there. Every chat prompt carries a short state of the project, so
  work done on the screens is known to the conversation. A chat turn sent
  while another job runs answers at once in a read-only lane of the queue.
- Web studio: no AI run can write the story bible except `story.update`. A
  run that changes it anyway (a character run adding an invented relative,
  say) is undone inside its step, and what it wanted to add becomes a story
  proposal for the person to accept or reject (`studio/server/bible-guard.js`).
- Web studio: `POST /api/projects/:id/issues` and a "New issue" button on the
  Pages screen and the project home start the next issue. It adds the
  series-plan entry and `issue.yaml` with `opens_from` set to the previous
  issue's `continuity/<ISS_ID>.final-state.yaml`, derived from its panel
  ledger when `/continuity-review` has not written it. Planning the first
  pages of the new issue reads that state, and the issue picker of the Pages,
  Check, Corrections, Cover and Publish screens follows the chosen issue.
- Web studio (`studio/`, `npm run studio`): a local web app that runs the
  pipeline from the browser. It creates a project from a description, defines
  the style from a preset, a text, or reference images, writes and draws
  character sheets, plans and draws pages in a queue, shows the check of each
  page with its evidence, takes corrections on a region or a panel, makes an
  optional cover, and publishes PDF, CBZ, EPUB, a web reader, or numbered
  images. Every screen has the text, the images, and a chat that can change
  the files. Each finished step is a commit in the project's own git
  repository, and the History screen restores an earlier point. The AI runs
  through the Claude Code and Codex command-line tools with no API key. The
  server and the browser app have no dependencies. The interface is in
  English and Spanish.
- Image provider `codex-cli`: draws through the Codex command-line tool the
  user is signed in to. A live run starts `codex exec` with the reference
  images attached in order and the prompt on stdin, and saves the result as
  the next render or candidate. It needs no API key. `npm run doctor` says
  whether the `codex` binary is found and prints its version. Optional
  settings: `CODEX_BIN`, `CODEX_IMAGE_TIMEOUT_MS`, `CODEX_IMAGE_MODEL`.
- `providers/lib/cli-spawn.js`: `resolveBinary`, `spawnCli`, and `killTree`
  for running a command-line tool on Windows and POSIX, with npm `.cmd`
  shims resolved and the whole process tree stopped on timeout or cancel.
- `generateAssets()` and `runPackage()` take `signal` and `onProgress` and
  hand them to the provider. Aborting the signal stops a running tool and
  records the attempt as failed with the error `cancelled`.
- `scripts/approve-asset.js` (`npm run approve:asset`): promotes an approved
  candidate to its `_MASTER` name, registers it in `references/manifest.yaml`
  with its generation record, updates the entity file, freezes the style
  when the asset is a look, and supersedes an earlier master with
  `--supersede`.
- Change requests from a person: `addUserRequest()` in
  `scripts/lib/review-requests.js` records a request as a review finding
  with `source: user_request` and an optional `region`. A request can open
  the review of a render that has none; its checks and gates are then
  `not_performed`. `compile-prompts.js --repair` includes open requests, and
  `validate-workspace.js` keeps a review flagged while one is open.
- Covers: one optional cover per issue, `CV_<issue number>`, in
  `issues/<ISS_ID>/cover/` with `cover.yaml` (new `cover` schema and
  template), `prompts/`, `renders/CV_###_V##`, and `reviews/`. The new
  `/cover` command plans, generates, reviews, and approves it.
  `compile-prompts.js --cover <ISS_ID>` (`compileCover`) and
  `generate-assets.js --cover <ISS_ID>` treat it like a page. A cover review
  uses the visual-review schema with `position`, `movement`, and
  `role_causality` not applicable. `approveCover()` in `scripts/lib/cover.js`
  refuses a render without a passing review. The example workspace has a
  cover.
- Editions: `build-edition.js` adds the formats `images` (a folder and a zip
  of numbered page images) and `epub` (EPUB 3, fixed layout, written by
  `scripts/lib/epub.js`). An edition can name a cover render under `cover:`,
  which becomes the first page of every format (`000-cover`, `FrontCover` in
  `ComicInfo.xml`). `draftEdition({ root, issue })` composes an edition from
  the current state without writing it and lists what blocks a final one.
  `images` and `epub` are also valid `deliverables` targets.
- Lettered files: `registerLetteredFile()` in `letter-pages.js`
  (`--register-lettered`) stores the PNG or JPEG exported from the overlay
  as `<RENDER_ID>.lettered.png` and sets `lettered_file` in the draft
  editions that ship the render.
- The `protect-approved-assets` hook also blocks a write over an existing
  cover render.

## 0.1.0

First version of the scaffold.

- Rules in common, domain (writing, visual, layout, lettering, image,
  publishing), and format (paged, webtoon) layers.
- Agents, commands, skills, and contexts for the whole pipeline, from source
  analysis to a published edition.
- JSON Schemas, templates, and a complete example workspace
  (`examples/the-night-ferry/`).
- Mechanical gates: `validate-workspace.js` (schemas, cross-references, review
  and edition rules) and `check-continuity.js` (panel ledger audit).
- Prompt pipeline: `build-reference-plan.js`, `compile-prompts.js`,
  `generate-assets.js`, with image providers that run dry by default.
- Publishing: `letter-pages.js` (SVG lettering overlay), `build-edition.js`
  (PDF, CBZ, web reader), `build-board.js` (issue board).
- Harness wrappers for Claude Code, Codex, Cursor, and OpenCode, plus a
  skills-only `.agents/` directory for other harnesses, generated by
  `sync-harnesses.js`.
- Reference sheets, location plates, and look pages compile per entity
  (`compile-prompts.js --asset`).

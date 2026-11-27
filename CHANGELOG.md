# Changelog

## Unreleased

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

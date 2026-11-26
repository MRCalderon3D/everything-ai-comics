# Web studio plan

Draft 3, 2026-11-26. A plan for a web interface on top of the scaffold, for
people who will not work from an editor. The three spikes of phase 0 are done
and their results are below. The build lives in `studio/`.

## Goal

A person describes a comic, picks a style, defines characters, writes what
happens, and gets reviewed pages they can correct and publish. They never see
a YAML file unless they ask to. The same project stays fully usable from VS
Code with the slash commands, because the studio writes the same workspace
files the scaffold already defines.

## What it is

A local web app. It runs on the user's machine, opens in the browser, and
drives the AI through the command-line tools already installed there: Claude
Code and Codex. It is a second front end for the scaffold, not a second
implementation: every action calls an existing command or script and every
result is an existing artifact.

## Facts that shape the design

1. Claude Code does not draw. It plans, writes, and reads images. Codex has
   an image tool. So in the first version Codex is the illustrator and either
   tool can write and plan. The first version uses no paid API at all
   (decided 2026-11-26): everything runs through the two CLIs.
2. The reviewer should not be the tool that drew the page. With two CLIs
   that is free: Codex draws, Claude reviews. With only one installed, the
   review runs in a fresh session and the page says the review was not
   independent.
3. It cannot be a hosted service in this form. The CLIs run under each
   user's own login, so each user runs the studio locally. A hosted version
   would need API billing and a different AI backend; the plan keeps that
   door open by putting the CLIs behind one interface.
4. Pages are generated one at a time. "Several pages at once" means a queue:
   each page is drawn, reviewed, and only then used as a reference for the
   next. The interface shows the queue; it does not pretend to run in
   parallel.
5. The automatic check is an AI reading the image and writing evidence. It
   catches a lot and it is not a guarantee. The interface shows the evidence
   and the verdict, and the person always has the last word.
6. The scaffold keeps its zero-dependency rule. The studio is a separate
   package in the same repository (`studio/`) with its own dependencies.
7. A browser can do two things the scaffold cannot: turn the lettering
   overlay into a flat image, and resize pages for social formats.

## Screens

Every screen has the same three parts: the text of what is being made
(editable), the images (current and earlier versions), and a chat with the AI
scoped to that screen. A change can always be made by editing the text or by
asking the chat.

| Screen | The person does | The studio runs | Files |
|---|---|---|---|
| Projects | Creates a project from a title and a description; reopens earlier ones | `create-project.js`, `/project-init` | `project.yaml` |
| Setup: story | Edits the premise; optionally pastes or uploads source text | `/source-analyze`, `/story-bible`, `/series-plan` | `story/` |
| Setup: style | Picks a preset, describes a style, or uploads a reference image; approves a look page | `/ingest-references`, `/style-bible`, `compile-prompts.js --asset LOOK_* --sheet look`, generation | `style/`, look master |
| Setup: options | Format (paged or webtoon), reading direction, page size, color, lettering mode, AI tools | form over `project.yaml` | `project.yaml` |
| Characters | Adds a character from text, a photo, or both; approves the sheet | `/ingest-references`, `/character-bible`, `compile-prompts.js --asset CHAR_* --sheet turnaround`, generation | `characters/` |
| Places and objects | Usually nothing: derived from the page text. Editable for those who want it | `/location-bible`, `/prop-bible` | `locations/`, `props/` |
| Pages | Writes what happens on one page or across several; approves the plan; starts generation | `/smart-page` (plan, script, ledger, references, prompts), `check-continuity.js`, `/generate-pages` | `issues/` |
| Check | Reads the verdict and the evidence per page | `/visual-review`, automatic `/repair-page` up to the repair limit | `reviews/` |
| Corrections | Marks a panel or the page, writes the change, compares versions | `/repair-page` with the person's request recorded as a finding | new render version, new review |
| Cover (optional) | Describes the cover or lets the AI propose one | new cover artifact (see below) | `issues/<ISS_ID>/cover/` |
| Publish | Picks formats and downloads | `/lettering`, `/continuity-review`, `build-edition.js` | `editions/` |
| History | Browses everything made, restores an earlier state | activity log, git commits per step | `.studio/` |

## Architecture

- `studio/server`: Node. HTTP API plus a live event stream for job progress.
  It imports the scaffold scripts as modules (they already export their main
  functions) and never shells out to them.
- AI drivers behind one interface with three verbs: plan (run a scaffold
  command and return its result), look (read an image and answer), draw
  (produce an image from a prompt package). Drivers in the first version:
  `claude -p` with JSON output and `codex exec`. The scaffold's API providers
  fit the same interface and can be added later without changing the screens.
- Job queue: one generation at a time per project, with progress, cancel,
  and a log per job. Long steps survive a browser refresh.
- `studio/web`: a single-page app. Forms are generated from the JSON
  Schemas, so a new field in the scaffold shows up without new interface
  code.
- Storage: the workspace is the database. The studio adds `.studio/` inside
  it for the activity log, chat transcripts, and job logs, and commits the
  workspace to a local git repository after each step so any state can be
  restored.
- Chat: one conversation per screen, resumed through the CLI's own session
  support, with the files of that screen as context.

## What the scaffold needs first

| Gap | Change |
|---|---|
| No cover artifact | A `cover` schema and directory, a `/cover` command, cover support in `compile-prompts.js` and `build-edition.js` |
| No "one image per page" export | An `images` format in `build-edition.js` (numbered files, optional zip); consider EPUB |
| Promoting a candidate to master is manual | An `approve-asset.js` script that registers the file in `references/manifest.yaml` and names the master |
| Commands assume a conversation | A headless contract: each command ends with a small machine-readable result (files written, verdict, what needs a decision) |
| A person's change request has no formal place | Findings with `reviewer: human` and a `source: user_request` marker in the review schema |
| Lettering overlay is SVG only | The studio rasterizes it in the browser and saves the result as `lettered_file` |

## Phases

0. Spikes. Three questions answered with throwaway code before anything is
   designed in detail: can `codex exec` draw a page with reference images
   attached and save it where asked; can `claude -p` run a scaffold command in
   a workspace and return a structured result; how good is a cross-tool review
   on a real page with a planted error.
1. Skeleton: server, AI drivers, job queue, projects list, history.
2. Setup: story, style, options, characters, with approval of masters.
3. Pages: plan, ledger, generation queue, automatic check.
4. Corrections: region marking, change requests, version comparison.
5. Cover and publish.
6. First-run experience for people who are not developers: one command or an
   installer, a check that the CLIs are present and logged in, clear messages
   when they are not.

### Spike 1 result (2026-11-26): Codex draws headless

Run with codex-cli 0.167.1, `codex exec --skip-git-repo-check --ephemeral -s
workspace-write --json`, in an empty folder. Both images were opened and
looked at.

| Test | Result | Time |
|---|---|---|
| One ink panel from text, saved to a named file | 1672 x 941 PNG at the requested path | 103 s |
| A three-panel portrait page with the first image attached as style reference (`-i`) and one caption | 1024 x 1536 PNG (2:3), three bordered panels, style carried over, caption text exact | 331 s |

What the studio has to account for:

- `-i` takes several files, so the prompt must come through stdin
  (`codex exec ... -i ref.png - < prompt.txt`). Passed as an argument, the
  prompt is read as another image path and the run exits at once.
- Output is 1024 x 1536, below the 2000 x 3000 page size in the sample
  project. Either the project page size follows the tool or pages are
  upscaled later. Not solved here.
- A page with one reference took five and a half minutes. A twelve-page
  issue with reviews and repairs is an hour or more of queue.
- The run printed errors about an MCP server configured on this machine that
  was not running. They did not affect the result; the driver should not
  treat stderr noise as failure.
- Not tested yet: several references at once (style plus two character
  sheets plus the previous page), editing an existing image for a repair,
  and how often the lettering comes back wrong.

### Spike 2 result (2026-11-26): Claude runs a command headless

Run with Claude Code 2.1.314 from the scaffold root, on a fresh workspace
made by `create-project.js`, with the prompt on stdin:

```
claude -p --output-format json --json-schema '<schema>' \
  --setting-sources project --strict-mcp-config \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(node scripts/*)" \
  --add-dir <project dir>
```

The prompt named `commands/story-bible.md`, gave a four-line premise and said
nobody could answer questions. In 110 seconds and 18 turns it wrote
`story/story-bible.yaml` (19 facts with provenance, world rules, arcs, a
timeline), ran `validate-workspace.js` on its own, and returned a result that
matched the schema: status, summary, files written, and ten decisions it made
in place of questions. The workspace validated with 0 errors.

What the studio has to account for:

- `--setting-sources project` keeps the person's own plugins and hooks out of
  the run and still loads the scaffold's `.claude/` directory, so its hooks
  apply.
- The child process must not inherit `CLAUDECODE` and
  `CLAUDE_CODE_ENTRYPOINT`.
- Shell calls outside the allowed pattern are denied and listed in
  `permission_denials`. The run carries on. PowerShell calls were among them,
  so the allow list has to cover both shells or the prompt has to say which
  one to use.
- The call used the default model and reported a list price of 0.67 USD. A
  full issue is dozens of calls, so the model per verb is a setting.

### Spike 3 result (2026-11-26): cross-tool review

The page Codex drew in spike 1 was reviewed by Claude (`--model sonnet`, only
the Read tool, permission mode `dontAsk`) against a plan with eight checks,
three of them altered on purpose: a different caption text, an eyepatch that
is not there, a ring that is not there. It took 13 seconds. All three altered
checks came back as failures with a description of what is on the page, and
the five true ones passed.

One page and three planted errors is a small sample. It says the mechanism
works. It does not say how often a subtle drift in a face or a costume gets
through.

### What phase 0 decided

Codex draws and Claude reviews, both headless. The fallback stays in the
design for machines without Codex: the studio prepares the prompt and the
references, the person generates the image elsewhere and uploads the file.
That is the scaffold's `manual` provider with a screen around it.

Three things changed from the first draft of this plan:

- The studio has no dependencies either. Node's `http` module and plain
  browser modules are enough, and it means there is nothing to install.
- Drawing is a scaffold provider, `codex-cli`, so the same path works from an
  editor with `generate-assets.js --provider codex-cli --live --yes`.
- Prompts name the command file to follow (`commands/<name>.md`) and do not
  use slash commands, so the same prompt works in both tools.

## Open decisions

| Decision | Recommendation |
|---|---|
| Local app or hosted service | Decided: local. Each user runs it with their own Claude Code or Codex login. |
| Who draws | Decided: Codex. No paid APIs in the first version. |
| Where the code lives | `studio/` in this repository, separate package. |
| How much of the plan the person sees before generation | A short readable page plan to approve. The ledger stays behind an "advanced" switch, but its errors are always shown. |
| Automatic repair before showing a page | Up to the project's repair limit, then show the page as flagged with the evidence. |

## Risks

- Headless image generation through Codex may be slower or more limited than
  the interactive tool. The spike measures it.
- CLI usage limits: a twelve-page issue is dozens of long calls. The queue
  needs to pause and resume cleanly.
- People who are not developers still have to install and log in to a CLI.
  Phase 6 exists for that, and it may be the hardest part.
- An automatic "pass" will be read as "correct". The interface has to keep
  showing evidence, not a green tick alone.

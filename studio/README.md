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

- Node.js 18 or later. The studio has no dependencies to install.
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
├── .studio/       settings.json, state.json, activity.jsonl, jobs/, chats/, uploads/
└── .git/          one commit per finished step
```

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
| `project.setup` (story bible and series plan) | 92 s |
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
whole pipeline, cancel, questions and answers, the event stream, the checks
above, and the command lines built for both tools. No test starts a real CLI.
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

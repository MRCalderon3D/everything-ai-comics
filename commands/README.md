# Commands

Workflow entry points (`/command-name`) for the comic pipeline. A command
says what to produce, which agents own the work, which skills they follow,
and which files come out. Each file uses the Command format in
[docs/conventions.md](../docs/conventions.md). The `Invokes Agents` and
`Required Skills` lists mirror the command map in that document and in
`manifests/commands.json`, and `npm run validate` checks all three against
each other.

Paths in these files are written with `production/` as the workspace root.
Any directory that holds a `project.yaml` works the same way.

## Setup

| Command | What it produces |
|---|---|
| [project-init](project-init.md) | The `production/` workspace: `project.yaml`, the directory layout, starter files, and a phase plan. |

## Development (source and story)

| Command | What it produces |
|---|---|
| [source-analyze](source-analyze.md) | The fact registry in `story/story-bible.yaml`: events, entities with permanent IDs, each fact tagged `source`, `user_change`, or `addition`, and the open questions. |
| [story-bible](story-bible.md) | The approved canon: resolved questions, world rules, timeline, arcs, and user changes propagated to everything that depends on them. |
| [series-plan](series-plan.md) | `story/series-plan.yaml`: the issues, their source spans, and their page budgets. |
| [humanize](humanize.md) | Prose rewritten to read as written by a person, or a findings report with `--check`. |

## Pre-production (bibles and look)

| Command | What it produces |
|---|---|
| [character-bible](character-bible.md) | `character.yaml` and `wardrobe.yaml` per character, with distinguishing features, adjacent characters, and a reference-sheet plan. |
| [location-bible](location-bible.md) | `location.yaml` and `map.yaml` per location: levels, side convention, landmarks, exits, lighting logic. |
| [prop-bible](prop-bible.md) | `prop.yaml` per object, with its appearance, hands required, and custody and state timelines. |
| [style-bible](style-bible.md) | The style bible, the color script, the lettering style, and the frozen `style-block.txt`. |
| [ingest-references](ingest-references.md) | The user's own reference material analyzed, filed, and registered in `references/manifest.yaml` with one role each. |
| [visual-development](visual-development.md) | Master references (look page, character sheets, plates, prop references) with generation records, registered and submitted for approval. |

## Page planning

| Command | What it produces |
|---|---|
| [issue-breakdown](issue-breakdown.md) | `issue.yaml` and one scene file per scene, with beats, cast, geography, and pages per beat. |
| [page-plan](page-plan.md) | `page.yaml` per page: purpose, grid, panels with one moment each, gutters, and page turns. |
| [panel-script](panel-script.md) | The panel script inside `page.yaml`: framing, visible cast, action, acting, and exact lettering text. |
| [thumbnails](thumbnails.md) | Rough layouts under `thumbnails/` and the fixes the readability test sends back to the plan. |
| [panel-ledger](panel-ledger.md) | A complete ledger in every panel and a `check-continuity.js` run with zero errors. |
| [reference-plan](reference-plan.md) | `reference-plan.yaml` per page: which approved images are attached, each with one role. |
| [smart-page](smart-page.md) | All of the above for one scene in a single pass, plus compiled prompt packages. |

## Generation and review

| Command | What it produces |
|---|---|
| [generate-pages](generate-pages.md) | Versioned page renders, one page at a time, with prompt packages and generation records. |
| [visual-review](visual-review.md) | A review file per render: fourteen checks with pixel evidence, findings, two gates, and a verdict. |
| [repair-page](repair-page.md) | A sibling version of a flagged page, rechecked change by change, with a new review. |
| [lettering](lettering.md) | Lettering placement, the overlay (`lettering.yaml` and a lettered SVG) in overlay mode, and the lettering check. |

## Publishing

| Command | What it produces |
|---|---|
| [continuity-review](continuity-review.md) | An audit across pages and issue boundaries, and `continuity/<ISS_ID>.final-state.yaml` for the next issue. |
| [build-edition](build-edition.md) | `edition.yaml` listing the exact render of every page, and the PDF, CBZ, and web reader exports. |

## Orchestration

| Command | What it produces |
|---|---|
| [full-production](full-production.md) | The whole pipeline run in order, with an approval gate per phase and a cost confirmation per batch. |
| [self-review](self-review.md) | A self-evaluation report on existing artifacts, or the fixes with `--fix`. |

## Suggested order for a first issue

```
/project-init
/source-analyze
/story-bible                 # resolve blocking questions here
/series-plan
/ingest-references           # only if you bring your own reference material
/character-bible
/location-bible
/prop-bible
/style-bible
/visual-development          # first step that can spend money
/issue-breakdown
/smart-page                  # per scene (or /page-plan, /panel-script, /panel-ledger, /reference-plan)
/thumbnails                  # optional readability test
/generate-pages              # one page at a time, cost-gated
/visual-review               # after every page, by a reviewer who did not generate it
/repair-page                 # only for flagged pages, within the repair limit
/lettering                   # overlay mode; in-image lettering is checked in the review
/continuity-review
/build-edition
```

`/full-production` runs the same order with the gates built in. For a
first project it is worth running the commands by hand once, to see what
each file looks like.

The commands that can spend generation budget are `/visual-development`,
`/generate-pages`, `/repair-page`, and `/thumbnails` with sketch
rendering. All of them are dry-run by default and show a cost estimate
before a live batch.

Two kinds of result are reported apart everywhere. Scripts validate files:
schemas, cross-references, the ledger, the review and edition rules. A
visual review judges a rendered page by looking at it. A clean script run
says nothing about the drawing.

Every artifact these commands write goes through the `self-evaluation`
gates before it is delivered (`rules/common/self-review.md`), and all
human-facing prose follows the `text-humanization` skill
(`rules/writing/prose-style.md`). `/self-review` and `/humanize` apply
the same passes to files that already exist.

## Adding a command

A roster change touches three places, in the same change:

1. The command file, `commands/<name>.md`, in the Command format: the
   `description` frontmatter, `# /<name>`, and the eight sections. The
   bullets under `Invokes Agents` and `Required Skills` carry bare roster
   names with nothing after them.
2. The manifest, `manifests/commands.json`: `name`, `file`, `description`,
   `agents`, and `skills`, matching the file.
3. The contract, `docs/conventions.md`: the command roster and a row in
   the command map with the same description, agents, and skills.

Then run `npm run sync:harnesses` to regenerate the harness wrappers and
`npm run validate` to confirm the three agree. Add the command to the
table for its phase in this file, and to the install profiles in
`manifests/profiles.json` that should carry it.

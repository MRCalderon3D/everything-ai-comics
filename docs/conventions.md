# Authoring Conventions

This document is the single contract for everything in this scaffold. Every agent,
command, skill, rule, schema, manifest, script, and provider MUST follow it. The
validation gate (`npm run validate`) enforces the machine-checkable parts. The
shapes of the workspace artifacts are specified in [data-model.md](data-model.md),
which is part of this contract.

## What this repository is

A layered workflow scaffold for AI-assisted comic creation: rules, agents,
commands, skills, and contexts that a coding assistant (Claude Code, Codex,
Cursor, OpenCode) loads to take a project from source text to a published
edition. It generates and maintains structured files inside a `production/`
workspace. It is not an app and has no UI.

Language: **English**, everywhere. Style: imperative, concise, no marketing prose.

## Layers

| Layer | Purpose | Format |
|---|---|---|
| `rules/` | Policy: what good looks like. `common/` first, then domain layers (`writing/`, `visual/`, `layout/`, `lettering/`, `image/`, `publishing/`), then exactly ONE format layer (`paged/` or `webtoon/`) selected by `comic_format` in `production/project.yaml`. | Markdown |
| `agents/` | Specialized roles: who owns the work. Flat list. | Markdown + frontmatter |
| `commands/` | Workflow entry points (`/command-name`). Flat list. | Markdown + frontmatter |
| `skills/` | Reusable procedures: how the work is done. One dir per skill with `SKILL.md`. | Markdown + frontmatter |
| `contexts/` | Production-phase framing loaded alongside commands. | Markdown |
| `schemas/` | JSON Schema (draft 2020-12) for every structured artifact in `production/`. | JSON |
| `manifests/` | Machine-readable index of the scaffold; source of truth for validation and installers. | JSON |
| `templates/` | Starter files that `create-project.js` copies into a new `production/` workspace. | YAML/Markdown |
| `examples/` | A complete sample workspace that passes every mechanical gate. Tests run against it. | YAML |
| `scripts/` | Node.js >= 18, **zero runtime dependencies**, CommonJS. Validation, generation, assembly, sync. | JS |
| `providers/` | Thin adapters for image generation backends. Common interface. | JS |
| `hooks/` | Harness hook handlers (validate on write, protect approved assets, etc.). | JS + `hooks.json` |
| `.claude/ .codex/ .cursor/ .opencode/ .agents/` | **Generated** harness wrappers. Never hand-edit; run `npm run sync:harnesses`. | generated |

## Rosters (exhaustive; do not add or rename without updating manifests)

**Agents (16):** editor-in-chief, comic-writer, script-editor, art-director,
character-designer, environment-designer, layout-artist, penciller, colorist,
letterer, continuity-editor, prompt-director, image-generation-specialist,
visual-reviewer, prepress-specialist, production-qa.

**Commands (27):** project-init, source-analyze, story-bible, series-plan,
character-bible, location-bible, prop-bible, style-bible, visual-development,
ingest-references, issue-breakdown, page-plan, panel-script, thumbnails,
panel-ledger, smart-page, reference-plan, generate-pages, visual-review,
repair-page, lettering, cover, continuity-review, build-edition,
full-production, humanize, self-review.

**Skills (29):** source-analysis, adaptation, narrative-structure,
comic-scripting, text-humanization, character-consistency,
character-sheet-generation, location-design, location-mapping,
visual-style-development, color-scripting, reference-ingestion, scene-blocking,
page-layout, panel-composition, sequential-storytelling, thumbnailing,
performance-direction, balloon-lettering, state-tracking, reference-selection,
production-orchestration, self-evaluation, prompt-compilation, image-generation,
page-repair, pixel-review, continuity-checking, edition-assembly.

**Rules (35):**
`common/`: source-of-truth, project-structure, naming-conventions, asset-provenance, cost-control, approval-policy, self-review, ask-dont-assume, visual-evidence, repair-limits.
`writing/`: comic-script-format, narrative-continuity, prose-style, adaptation-fidelity, dialogue-economy.
`visual/`: character-consistency, location-consistency, spatial-continuity, state-continuity, visual-language.
`layout/`: page-composition, panel-transitions, pacing.
`lettering/`: balloons-and-captions, sound-effects, reading-order.
`image/`: image-generation, reference-roles, page-generation.
`publishing/`: edition-assembly, export-formats.
`paged/` (format layer): page-turn-grammar, print-specs.
`webtoon/` (format layer): scroll-grammar, episode-deliverables.

Format layers are mutually exclusive: a task loads `paged/` OR `webtoon/`
based on `comic_format` in `production/project.yaml` (default: paged). Craft
shared by both formats lives in the common and domain layers and is never
duplicated into a format layer. `manifests/rules.json` mirrors this roster and
`validate.js` checks it against the files on disk.

**Contexts (5):** development, preproduction, production, publishing, review.

**Schemas (19):** project, story-bible, series-plan, character, wardrobe,
location, location-map, prop, issue, scene, page, lettering, reference-plan,
prompt-package, continuity-state, generation-record, visual-review, cover,
edition.
Files are `schemas/<name>.schema.json`; `$id` is
`https://everything-ai-comics.dev/schemas/<name>.schema.json`.

**Manifests (7):** profiles.json, agents.json, commands.json, skills.json,
rules.json, image-providers.json, harnesses.json.

**Providers (7):** image: fal, replicate, comfyui, gemini, harness-native, codex-cli, manual.

**Scripts (14):** install.js, doctor.js, validate.js, sync-harnesses.js,
create-project.js, validate-workspace.js, compile-prompts.js,
build-reference-plan.js, generate-assets.js, approve-asset.js,
check-continuity.js, letter-pages.js, build-edition.js, build-board.js. Shared
helpers live in `scripts/lib/`.

**Hooks (4):** validate-after-write.js, protect-approved-assets.js,
detect-continuity-drift.js, require-cost-confirmation.js, wired by `hooks/hooks.json`.

**Profiles (5):** full, writing-room, layout, generation, publishing.

## Roster descriptions (authoritative one-liners)

Frontmatter `description` fields and manifest `description` fields MUST use
these sentences verbatim.

### Agents

| Agent | Tools | Description |
|---|---|---|
| editor-in-chief | Read, Grep, Glob, Write, Edit | Owns the whole production: story vision, phase sequencing, approvals, and arbitration between departments. |
| comic-writer | Read, Grep, Glob, Write, Edit | Writes the comic script: page breakdowns, panel descriptions, dialogue, captions, and sound effects. |
| script-editor | Read, Grep, Glob, Write, Edit | Gives structural coverage on scripts and adaptations; guards source fidelity, causality, and dialogue economy. |
| art-director | Read, Grep, Glob | Owns the visual language (line, tone, color, texture) and reviews all imagery against the style bible. |
| character-designer | Read, Grep, Glob, Write, Edit | Builds and maintains character identity: face, silhouette, wardrobe states, and reference sheets. |
| environment-designer | Read, Grep, Glob, Write, Edit | Designs locations and props, and maps every space so staging and continuity can reason about it. |
| layout-artist | Read, Grep, Glob, Write, Edit | Breaks the story into pages and panels: grids, panel sizes, reading flow, page turns, and thumbnails. |
| penciller | Read, Grep, Glob | Composes each panel (framing, angle, staging, acting) so one drawable moment reads at a glance. |
| colorist | Read, Grep, Glob | Sets the color strategy: palette, color scripts, spot color, and tone continuity across pages. |
| letterer | Read, Grep, Glob, Write, Edit | Places balloons, captions, and sound effects; owns reading order, exact text, and lettering checks. |
| continuity-editor | Read, Grep, Glob, Write, Edit | Tracks position, custody, wardrobe, and physical state panel by panel; owns ledgers and continuity state. |
| prompt-director | Read, Grep, Glob, Write, Edit | Builds reference plans and compiles page data plus approved masters into provider-ready prompt packages; never freehands a prompt. |
| image-generation-specialist | Read, Grep, Glob, Write, Edit, Bash | Runs page and reference generation through image providers, saves versioned candidates, and records provenance. |
| visual-reviewer | Read, Grep, Glob, Write, Edit | Inspects rendered pages against the plan and references; records evidence-based findings and verdicts. |
| prepress-specialist | Read, Grep, Glob, Write, Edit, Bash | Assembles editions and exports PDF, CBZ, web, and social deliverables to spec. |
| production-qa | Read, Grep, Glob | Runs the validation gates: schema compliance, roster integrity, provenance, approval, and cost policy. |

All agents use `model: sonnet`.

### Skills

| Skill | Category | Description |
|---|---|---|
| source-analysis | story | Decompose source prose or a script into events, entities, and a complete fact registry. |
| adaptation | story | Turn prose into comic story: separate source facts, user changes, and additions, then compress for the page. |
| narrative-structure | story | Map acts, turning points, setups and payoffs, and pacing across issues and pages. |
| comic-scripting | story | Write panel-by-panel script: one drawable moment per panel, exact dialogue, captions, and sound effects. |
| text-humanization | story | Write and rewrite prose so it reads like a person wrote it, removing the catalogued AI-writing tells. |
| character-consistency | visual | Lock canonical character identity so every drawn appearance matches every other. |
| character-sheet-generation | visual | Produce reference sheets (turnarounds, expressions, wardrobe) that become approved identity masters. |
| location-design | visual | Define each location's architecture, dressing, light, and time-of-day states. |
| location-mapping | visual | Map levels, sides, landmarks, and exits so panels can state positions precisely. |
| visual-style-development | visual | Define the comic's visual language (line, tone, texture, rendering) as an enforceable style bible. |
| color-scripting | visual | Plan palette, spot color, and tonal progression per scene and page. |
| reference-ingestion | visual | Analyze user-supplied reference material and turn it into bible entries and registered reference assets. |
| scene-blocking | production | Stage each scene on the location map: positions, movement paths, eyelines, travel and threat directions. |
| page-layout | production | Design the page: panel count, grid, relative panel size, reading order, and page turns. |
| panel-composition | production | Choose framing, angle, and staging inside the panel so the moment and the actor are unmistakable. |
| sequential-storytelling | production | Order panels into readable sequences: transitions, gutter ellipses, and flow from panel to panel. |
| thumbnailing | production | Rough each page as thumbnails to test readability before any final generation. |
| performance-direction | production | Direct character acting as visible, drawable behavior instead of emotion labels. |
| balloon-lettering | production | Place balloons, captions, and sound effects in reading order with the exact approved text. |
| state-tracking | production | Keep the panel ledger: position, custody, wardrobe, and physical state for every character and object. |
| reference-selection | production | Choose which approved reference images each page needs, and give each one a single role. |
| production-orchestration | production | Run the pipeline: phase gates, approval workflow, dependency order, and batch cost confirmation. |
| self-evaluation | production | Evaluate a fresh artifact cold against schema, rules, and the producing skill's quality bar; apply clear fixes. |
| prompt-compilation | generation | Compile provider-ready prompt packages from bibles, page files, and reference plans; never freehand. |
| image-generation | generation | Generate pages and reference art through image providers with dry-run, provenance, and cost discipline. |
| page-repair | generation | Repair a failed page with a targeted sibling version, locked elements, and a two-cycle limit. |
| pixel-review | post | Inspect the rendered pixels against plan and references and record evidence-based findings. |
| continuity-checking | post | Audit position, custody, state, wardrobe, and geography across panels, pages, and issues. |
| edition-assembly | post | Select reviewed page versions, assemble an edition, and export it without overwriting earlier ones. |

Skill categories: `story | visual | production | generation | post`.
Skill frontmatter `origin` is `everything-ai-comics`.

## File formats

### Agent (`agents/<name>.md`)

```markdown
---
name: penciller
description: One-line role summary ending with a period.
tools: ["Read", "Grep", "Glob"]
model: sonnet
---

# penciller

## Role
## Responsibilities        (bulleted, 5–8 items)
## Uses These Skills       (bulleted skill names from the roster)
## Collaborates With       (bulleted agent names from the roster)
## Deliverables            (bulleted concrete artifacts)
## Activation Guidance     (when to use, when to escalate)
```

Bullets under `Uses These Skills` and `Collaborates With` carry the bare roster
name only (no description after it), because `validate.js` matches them exactly.

### Command (`commands/<name>.md`)

```markdown
---
description: One-line summary of what the command produces.
---

# /command-name

## Purpose
## Use When
## Inputs                  (required / optional, with types and defaults)
## Invokes Agents          (bulleted, bare roster names)
## Required Skills         (bulleted, bare roster names)
## Process                 (numbered steps)
## Outputs                 (file paths under production/, schema names)
## Notes                   (escalation, related commands, cost warnings)
```

### Skill (`skills/<name>/SKILL.md`)

```markdown
---
name: reference-selection
description: One-line capability summary.
origin: everything-ai-comics
category: story | visual | production | generation | post
---

# Reference Selection

## Purpose
## Use When
## Inputs
## Process                 (numbered, decisive steps)
## Outputs
## Quality Bar
## Common Failure Modes
## Related Agents
## Related Commands
## Notes
```

### Rule (`rules/<layer>/<name>.md`)

```markdown
# Title

## Purpose
## Scope
## Core Principles         (then domain-specific rule sections)
## Validation              (how compliance is checked)
```

### Context (`contexts/<name>.md`)

Free-form Markdown: what phase this is, what matters now, which commands and
rule layers apply, what to defer.

## Command → agents → skills map (authoritative)

| Command | Description | Agents | Skills |
|---|---|---|---|
| project-init | Scaffold a production/ workspace: project.yaml, directory layout, and phase plan. | editor-in-chief, production-qa | production-orchestration |
| source-analyze | Break source prose or a script into events, entities, and a fact registry with open questions. | comic-writer, script-editor | source-analysis, adaptation |
| story-bible | Compile the canon: facts by provenance, world rules, timeline, and character arcs. | editor-in-chief, comic-writer | narrative-structure, source-analysis |
| series-plan | Divide the story into issues with source spans, page budgets, and status. | editor-in-chief, script-editor | narrative-structure, adaptation |
| character-bible | Define identity, distinguishing features, wardrobe states, and reference-sheet plans for every character. | character-designer, comic-writer | character-consistency, character-sheet-generation |
| location-bible | Define locations with levels, landmarks, exits, and lighting logic. | environment-designer | location-design, location-mapping |
| prop-bible | Catalog plot-relevant props with appearance, state timeline, and custody tracking. | environment-designer, continuity-editor | visual-style-development, state-tracking |
| style-bible | Lock the visual language: line, tone, color mode, lettering style, and the frozen style block. | art-director, colorist, letterer | visual-style-development, color-scripting |
| visual-development | Generate and iterate the master references: character sheets, location plates, and look pages. | art-director, character-designer, environment-designer | visual-style-development, character-sheet-generation, location-design |
| ingest-references | Analyze user-supplied reference material and fold it into the bibles and the reference registry with provenance. | art-director, character-designer, environment-designer | reference-ingestion, visual-style-development |
| issue-breakdown | Break one issue into scenes and beats with cast, geography, and a page budget per beat. | editor-in-chief, comic-writer, layout-artist | narrative-structure, scene-blocking |
| page-plan | Plan every page of an issue: panel count, grid, panel sizes, reading order, and page turns. | layout-artist, comic-writer | page-layout, sequential-storytelling |
| panel-script | Write the full panel script for planned pages: framing, cast, action, acting, and exact lettering text. | comic-writer, penciller, letterer | comic-scripting, panel-composition, performance-direction |
| thumbnails | Rough each page as thumbnails and check readability before final generation. | layout-artist, penciller | thumbnailing, panel-composition |
| panel-ledger | Fill and audit the per-panel ledger of position, custody, wardrobe, and physical state. | continuity-editor, layout-artist | state-tracking, scene-blocking |
| smart-page | Turn one scene into finished page plans: layout, panel script, ledger, reference plan, and prompts. | art-director, layout-artist, comic-writer, penciller, letterer, continuity-editor, prompt-director | scene-blocking, page-layout, sequential-storytelling, comic-scripting, panel-composition, performance-direction, state-tracking, reference-selection, prompt-compilation |
| reference-plan | Decide which approved reference images each page conditions on, one role per image. | prompt-director, continuity-editor | reference-selection |
| generate-pages | Generate pages one at a time through image providers, with cost confirmation and provenance. | image-generation-specialist, prompt-director | image-generation, prompt-compilation, reference-selection |
| visual-review | Review rendered pages against plan and references; record findings, gates, and a verdict. | visual-reviewer, continuity-editor, art-director | pixel-review, continuity-checking |
| repair-page | Repair a flagged page as a sibling version, then recheck the whole page and its neighbors. | visual-reviewer, prompt-director, image-generation-specialist | page-repair, prompt-compilation, pixel-review |
| lettering | Plan, place, and check balloons, captions, and sound effects for in-image or overlay lettering. | letterer, visual-reviewer | balloon-lettering |
| cover | Plan the cover of an issue, generate and review it, and record the approved render. | art-director, editor-in-chief, prompt-director, image-generation-specialist, visual-reviewer | panel-composition, reference-selection, prompt-compilation, image-generation, pixel-review |
| continuity-review | Audit continuity across pages and issue boundaries and write the end-of-issue state. | continuity-editor, production-qa | continuity-checking, state-tracking |
| build-edition | Assemble reviewed pages into an edition and export PDF, CBZ, web reader, images, and EPUB. | prepress-specialist, editor-in-chief, production-qa | edition-assembly |
| full-production | Orchestrate the whole pipeline from source text to published edition, with approval gates and cost confirmation. | editor-in-chief, production-qa | production-orchestration |
| humanize | Rewrite generated or existing prose so it reads human, or audit it with --check. | script-editor, comic-writer | text-humanization |
| self-review | Run the self-evaluation pass on existing artifacts and report or fix what it finds. | production-qa, editor-in-chief | self-evaluation |

Commands may reference additional agents/skills in prose, but `Invokes Agents`
and `Required Skills` lists MUST contain only roster names and MUST include the
rows above. `validate.js` cross-checks every listed name against the manifests.

## Naming and IDs (project workspace)

- Issues: `ISS_###` (e.g. `ISS_001`). An issue is the publication unit; a
  chapter or a webtoon episode is an issue.
- Scenes: `SC_<issue>_##` (e.g. `SC_001_02`). Beats: `BT_<issue>_<scene>_##`.
- Pages: `PG_<issue>_###` (e.g. `PG_001_004`). In `webtoon` format a page is
  one scroll segment.
- Panels: `PN_<issue>_<page>_##` (e.g. `PN_001_004_03`).
- Lettering elements: `L##`, unique within a page.
- Renders (page image candidates): `<PAGE_ID>_V##` (e.g. `PG_001_004_V02`).
  A repair always creates the next version; earlier files stay on disk.
- Covers: `CV_<issue number>` (e.g. `CV_001` for `ISS_001`), one per issue.
  Cover renders: `<COVER_ID>_V##` (e.g. `CV_001_V02`), versioned like page
  renders. A cover has no panels. Where a prompt package, a generation
  record, or a review names its `page`, a cover file names the cover ID.
- Assets: `CHAR_*`, `LOC_*`, `PROP_*`, `LOOK_*`, versioned `_V##`
  (e.g. `CHAR_MARA_TURN_MASTER_V02`). Approved masters carry `_MASTER`.
- Wardrobe states: `WARD_<CHARACTER>_<NAME>` (e.g. `WARD_MARA_OILSKIN`).
- Prompt packages: `PP_<page-or-entity-id>_<PROVIDER>`, or
  `PP_<COVER_ID>_<PROVIDER>` for a cover (`PP_CV_001_FAL`), with a `-P##` suffix for
  a single panel and a `-<TAG>` suffix for a reference sheet (`TURN`, `EXPR`,
  `WARD`, `PLATE`, `SHEET` for a prop, `LOOK`, `DETAIL`). A wardrobe sheet
  appends its outfit, a detail its subject, and a plate a non-default time
  of day: `PP_CHAR_MARA_FAL-WARD-OILSKIN`.
- Reference candidates: `<ENTITY_ID>_<TAG>_V##`, with the same variant after
  the tag (`CHAR_MARA_WARD_OILSKIN_V01`, `PROP_FLARE_GUN_SHEET_V01`,
  `LOC_FERRY_DECK_PLATE_DUSK_V01`). Promotion to a master is an
  approval step: the file is copied to the `_MASTER` name and registered in
  `references/manifest.yaml`; the candidate stays on disk. The master keeps
  the candidate's version number (`CHAR_MARA_TURN_V02` becomes
  `CHAR_MARA_TURN_MASTER_V02`). `scripts/approve-asset.js --candidate
  <path-or-stem>` does the copy and the registration once a person has
  approved the image, and `--supersede` replaces the approved master of the
  same sheet.
- Generation records: `GEN_<page-id>_<attempt##>`, `GEN_<entity-id>_<attempt##>`,
  or `GEN_<cover-id>_<attempt##>` (`GEN_CV_001_02`).
- Canon facts: `FACT_###`, unique within the story bible.
- Review findings: `F##`, unique within a review file.
- Editions: `ED_<issue>_##` (e.g. `ED_001_03`).
- Files are lowercase-kebab or the ID itself; YAML for structured data,
  Markdown for human documents.

## `production/` workspace layout

`production/` is the default workspace name, not a requirement: a workspace
root is any directory containing `project.yaml`, and hooks and scripts resolve
roots by that marker. Parallel productions in one clone live side by side
(`production/`, `production-<slug>/`), each fully self-contained. Assets,
references, and continuity NEVER cross workspace roots.

```
production/
├── project.yaml               # project.schema.json
├── story/                     # source/ (source text), story-bible.yaml, series-plan.yaml
├── style/                     # style-bible.md, style-block.txt (frozen prompt block), color-script.md
├── characters/                # <CHAR_ID>/character.yaml, wardrobe.yaml, refs/ (sheets, candidates, refs/prompts/)
├── locations/                 # <LOC_ID>/location.yaml, map.yaml, refs/ (plates, refs/prompts/)
├── props/                     # <PROP_ID>/prop.yaml, refs/ (sheets, refs/prompts/)
├── references/                # manifest.yaml (registry of ALL reference material), inbox/, style/ (look pages, style/prompts/), docs/
├── issues/
│   └── <ISS_ID>/
│       ├── issue.yaml         # issue.schema.json
│       ├── scenes/            # <SC_ID>.yaml (scene.schema.json)
│       ├── cover/             # optional: cover.yaml (cover.schema.json), prompts/, renders/ <CV_ID>_V##.png, reviews/, laid out like a page
│       └── pages/
│           └── <PG_ID>/
│               ├── page.yaml              # page.schema.json: layout, panels, ledger, lettering text
│               ├── lettering.yaml         # lettering.schema.json (overlay mode only)
│               ├── reference-plan.yaml    # reference-plan.schema.json
│               ├── thumbnails/            # rough layouts
│               ├── prompts/               # <provider>.yaml (prompt-package.schema.json)
│               ├── renders/               # <PG_ID>_V##.png|jpg versioned candidates, never overwritten
│               └── reviews/               # <RENDER_ID>.review.yaml (visual-review.schema.json)
├── generations/               # <PG_ID, CV_ID or ENTITY_ID>/GEN_*.yaml (generation-record.schema.json) + GEN_*.request.json
├── continuity/                # <ISS_ID>.final-state.yaml (continuity-state.schema.json)
└── editions/
    └── <ED_ID>/               # edition.yaml (edition.schema.json), exports/
```

## Cover, edition, and lettered-file tooling

The cover goes through the same scripts as a page. Each has a command-line
form and an exported function, and both do the same thing.

| Task | Command line | Function |
|---|---|---|
| Compile the cover package | `compile-prompts.js --cover <ISS_ID> [--root <workspace>] [--provider <id>] [--model <id>] [--repair <review.yaml>]` | `compileCover({ root, issue, provider, model, repair, write })` in `scripts/compile-prompts.js` |
| Generate the cover | `generate-assets.js --cover <ISS_ID> [--root <workspace>] [--provider <id>] [--live --yes]` | `generateAssets({ cover: '<ISS_ID>', root, provider, live, yes })` in `scripts/generate-assets.js` |
| Approve a cover render | none | `approveCover({ root, issue, render })` in `scripts/lib/cover.js` |
| Build an edition | `build-edition.js --edition <edition.yaml> [--formats pdf,cbz,web,images,epub] [--draft] [--force]` | `buildEdition(editionFile, { formats, draft, force })` in `scripts/build-edition.js` |
| Compose an edition | none | `draftEdition({ root, issue })` in `scripts/build-edition.js` |
| File a lettered page | `letter-pages.js --register-lettered <image> --render <RENDER_ID> (--page <page.yaml> \| --root <workspace>)` | `registerLetteredFile({ root, page, render, file })` in `scripts/letter-pages.js` |

- `compileCover` returns what `compilePage` returns, `{ pkg, spec, warnings,
  fileName }`, plus `fileRel`, the workspace-relative path the package
  belongs at. It writes nothing unless `write: true`. `repair` is a review
  file path or a review document.
- `generateAssets` treats a cover package like a page package: the record
  goes under `generations/<COVER_ID>/` and the image to the next free
  `cover/renders/<COVER_ID>_V##`. Nothing is overwritten.
- `approveCover` sets `status: approved` and `approved_render` in
  `cover.yaml`, and refuses a render whose review is not `pass` or `fixed`.
  It returns `{ cover, render, file, previous, preserved }`.
- `draftEdition` writes nothing. It returns an edition document with the
  next free edition ID, status `draft`, every page that has a current
  render, and the cover when `cover.yaml` is approved. The object also
  carries `blockers`, a non-enumerable array of `{ page, render, code,
  message }` that lists what keeps the edition from being final (`no_render`,
  `render_missing`, `no_review`, `not_passing`). Because it is
  non-enumerable, serializing the object gives a valid `edition.yaml`.
- `registerLetteredFile` stores a PNG or JPEG as
  `<RENDER_ID>.lettered.png` (or `.jpg`) next to the render and sets
  `lettered_file` on that render's entry in every draft edition. It returns
  `{ path, render, editions, skipped }`. `file` is a path or a Buffer.
  Reviewed and published editions are never changed.
- Path helpers for the cover live in `scripts/lib/workspace.js`:
  `coverIdOfIssue`, `issueOfCover`, `coverOfRender`, `coverDir`, `coverFile`,
  `loadCover`, `coverRenderFile`, `listCoverRenders`, `coverReviewFile`,
  `listCoverReviews`. `renderFile`, `reviewFile`, and `loadReview` take a
  cover render ID as well as a page render ID.

## Provider interface (JS, CommonJS)

Every file in `providers/image/<id>.js` exports:

```js
module.exports = {
  id: 'fal',                    // matches manifests/image-providers.json
  kind: 'image',
  label: 'fal.ai',
  env: ['FAL_KEY'],             // required env vars; empty for local/harness-native/codex-cli/manual
  capabilities: {               // hard limits compile() checks packages against
    referenceImages: 4,         // max reference inputs, 0 if unsupported
    aspectRatios: ['2:3', '3:4', '1:1', '9:16'],
    imageEditing: true,         // accepts an edit target (needed for /repair-page)
    textRendering: 'unreliable' // 'reliable' | 'unreliable' | 'none' (in-image lettering)
  },
  // prompt-package (schemas/prompt-package.schema.json) -> provider request spec
  compile(promptPackage, options = {}) { /* pure, no I/O */ },
  // request spec -> generation record (schemas/generation-record.schema.json)
  async generate(requestSpec, { dryRun = true, outDir, root, signal, onProgress } = {}) { /* fetch-based */ },
};
```

`generate` MUST default to dry-run (writes the request spec and a generation
record with status `dry_run`, calls no network) and MUST refuse to run live when a required
env var is missing. Never log API keys. `manual` and `harness-native` produce a
handoff package for a person or for the harness's own image tool; they never
call the network.

`codex-cli` runs the Codex command-line tool the user is signed in to. In
live mode it starts `codex exec` with the package's reference images attached
in order and the instruction on stdin, has Codex save one PNG at a temporary
path inside `outDir`, and returns the image on the record. It needs no env
var. A missing `codex` binary, a non-zero exit with no file, a timeout, a
cancelled run, and a saved file that is not an image each give a `failed`
record with a plain message; text on stderr alone never does. The image model
is `unreported` unless Codex names it, and the cost is `null`.

`signal` and `onProgress` are optional. `generate-assets.js` hands them
through from `generateAssets({ signal, onProgress })`. Aborting the signal
stops a provider that runs a local tool, process tree included, and its
record fails with the error `cancelled`; packages not started yet are
skipped. `onProgress(line)` receives short status lines while the tool runs.
API providers ignore both.

Code that starts a command-line tool goes through `providers/lib/cli-spawn.js`:
`resolveBinary(name, envOverride)` finds the executable on Windows and POSIX
(an npm `.cmd` shim is resolved to the script it launches),
`spawnCli({ bin, args, cwd, stdin, env, signal, timeoutMs, onStdout, onStderr })`
runs it and resolves with `{ code, signal, timedOut, cancelled, stdout, stderr }`,
and `killTree(child)` stops a process and everything it started. Text a
person wrote goes to the tool on stdin or in a file, never on the command
line.

## Manifest shapes

- `agents.json` / `commands.json` / `skills.json`:
  `{ "$schema": "...", "version": 1, "<plural>": [{ "name", "file", "description", ... }] }`.
  Commands entries also carry `"agents": []` and `"skills": []` mirroring the
  map above; skills entries carry `"category"`.
- `rules.json`: `{ "version": 1, "layers": [{ "name", "kind": "common" | "domain" | "format", "rules": ["<name>"] }] }`.
- `image-providers.json`: `{ "version": 1, "providers": [{ "id", "file", "label", "env", "capabilities" }] }`.
- `profiles.json`: named install profiles (`full`, `writing-room`, `layout`,
  `generation`, `publishing`) listing included commands/agents/skills.
- `harnesses.json`: per-harness wrapper strategy (target dir, command format,
  frontmatter mapping) consumed by `sync-harnesses.js`.

## Environment variables

`FAL_KEY`, `REPLICATE_API_TOKEN`, `COMFYUI_HOST`, `GOOGLE_API_KEY` (Gemini).
Document in README; never commit values.

The `codex-cli` provider reads three optional settings. None is a secret and
none is required, so its `env` list stays empty:

- `CODEX_BIN`: path of the `codex` executable when it is not on `PATH`. Tests
  point it at a stub.
- `CODEX_IMAGE_TIMEOUT_MS`: time limit for one image in milliseconds, default
  `900000` (15 minutes). A run that passes it is stopped and recorded as
  failed.
- `CODEX_IMAGE_MODEL`: model for the Codex session, passed as `-m`. Without
  it Codex uses its own default, unless the prompt package pins a model.

## Cross-cutting policies (mirrored in rules/)

- **Source of truth:** bibles and approved masters in `production/` outrank any
  prompt or generation. Regenerate outputs; never hand-edit generated wrappers.
- **Adaptation fidelity:** every canon fact is tagged `source`, `user_change`,
  or `addition`. A user change propagates to every artifact that depends on it:
  wardrobe, dialogue, references, and prompts change together.
- **Plan before pixels:** pages, panels, geography, and the panel ledger are
  written and checked before any prompt is compiled. An approved plan fixes
  intent; it does not approve an image that does not exist yet.
- **One role per reference:** every reference image attached to a request has
  exactly one role (style, identity, wardrobe, spatial continuity, prop
  consistency, composition, or edit target). A style reference never stands in
  for a character's face.
- **Frozen style block:** the style prompt lives in `production/style/style-block.txt`
  and is reused verbatim in every request. The approved look master is attached
  as an image on every request; repeating a style word is not a substitute.
- **Sequential generation:** pages are generated one at a time. A returned
  file is opened and reviewed before it becomes a continuity reference for the
  next page.
- **Visual evidence:** a successful tool call means an image exists, not that
  it passed. Reviews judge the rendered pixels against plan and references.
  Schema checks and repository tests verify structured data and tooling; they
  never certify identity, anatomy, geography, or comic continuity, and reports
  keep mechanical validation and visual review separate.
- **Two gates:** every review records style fidelity and narrative continuity
  as separate gates. Identity ambiguity, duplicates, impossible positions,
  broken causality, and missing critical state transitions are blocking.
- **Repair limits:** a repair produces a sibling version, never an overwrite.
  The whole page and its neighbors are rechecked after a local edit. After two
  failed repair cycles the plan or the references are fixed before any further
  generation.
- **Change requests:** a change a person asks for on a rendered page is a
  review finding with `source: user_request`, written by `addUserRequest()` in
  `scripts/lib/review-requests.js`. It may mark a `region` of the page, it
  keeps the review `flagged` while it is open, and a repair carries it with
  the reviewer's findings. A render that had no review gets one whose checks
  and gates read `not_performed` until a reviewer judges them.
- **Asset provenance:** every generated file gets a generation record
  (provider, model, prompt package hash, references used, cost, timestamp).
  Metadata the tool does not report is recorded as unavailable, never invented.
- **Approval gates:** assets move `draft → review → approved`. Approved assets
  are immutable; supersede with a new version. Verdicts are `pass`, `fixed`, or
  `flagged`; human approval is a separate decision recorded on the review.
  `scripts/approve-asset.js` records the approval of a reference candidate:
  the master copy, the registry entry, the entity file, and for a look the
  frozen style.
- **Cost control:** batch generation requires an explicit cost estimate and
  confirmation; dry-run is always the default.
- **Edition discipline:** an edition lists the exact render of every page,
  and of the cover when it has one.
  Only renders whose review verdict is `pass` or `fixed` enter a non-draft
  edition. Exports never overwrite an existing file; a new edition gets a new ID.
- **Prose style:** all human-facing generated text follows the
  `text-humanization` skill by default (`rules/writing/prose-style.md`);
  model-facing prompt text is exempt and answers to `prompt-compilation`.
- **Format separation:** paged and webtoon projects share the common and domain
  rule layers but never each other's layer. Commands read `comic_format`
  before applying layout, pacing, or delivery defaults.
- **Self-review by default:** every generated artifact passes the
  `self-evaluation` gates (schema, rules, quality bar, improvement pass)
  before it is delivered or submitted for review
  (`rules/common/self-review.md`); `/self-review` retrofits existing
  artifacts. Self-review precedes human approval and never replaces it.

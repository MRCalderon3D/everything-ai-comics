# Skills

Skills are the scaffold's procedures: how a piece of work is done, step by
step, against the real files of a `production/` workspace. Each one lives in
its own directory as `skills/<name>/SKILL.md`. Rules say what good looks like,
agents say who owns the work, commands say when it starts. A skill is what the
agent follows once the command has started.

The tables below group the roster by category. The descriptions are the
authoritative one-liners from [docs/conventions.md](../docs/conventions.md).

## Story

| Skill | Description |
|---|---|
| [source-analysis](source-analysis/SKILL.md) | Decompose source prose or a script into events, entities, and a complete fact registry. |
| [adaptation](adaptation/SKILL.md) | Turn prose into comic story: separate source facts, user changes, and additions, then compress for the page. |
| [narrative-structure](narrative-structure/SKILL.md) | Map acts, turning points, setups and payoffs, and pacing across issues and pages. |
| [comic-scripting](comic-scripting/SKILL.md) | Write panel-by-panel script: one drawable moment per panel, exact dialogue, captions, and sound effects. |
| [text-humanization](text-humanization/SKILL.md) | Write and rewrite prose so it reads like a person wrote it, removing the catalogued AI-writing tells. |

## Visual

| Skill | Description |
|---|---|
| [character-consistency](character-consistency/SKILL.md) | Lock canonical character identity so every drawn appearance matches every other. |
| [character-sheet-generation](character-sheet-generation/SKILL.md) | Produce reference sheets (turnarounds, expressions, wardrobe) that become approved identity masters. |
| [location-design](location-design/SKILL.md) | Define each location's architecture, dressing, light, and time-of-day states. |
| [location-mapping](location-mapping/SKILL.md) | Map levels, sides, landmarks, and exits so panels can state positions precisely. |
| [visual-style-development](visual-style-development/SKILL.md) | Define the comic's visual language (line, tone, texture, rendering) as an enforceable style bible. |
| [color-scripting](color-scripting/SKILL.md) | Plan palette, spot color, and tonal progression per scene and page. |
| [reference-ingestion](reference-ingestion/SKILL.md) | Analyze user-supplied reference material and turn it into bible entries and registered reference assets. |

## Production

| Skill | Description |
|---|---|
| [scene-blocking](scene-blocking/SKILL.md) | Stage each scene on the location map: positions, movement paths, eyelines, travel and threat directions. |
| [page-layout](page-layout/SKILL.md) | Design the page: panel count, grid, relative panel size, reading order, and page turns. |
| [panel-composition](panel-composition/SKILL.md) | Choose framing, angle, and staging inside the panel so the moment and the actor are unmistakable. |
| [sequential-storytelling](sequential-storytelling/SKILL.md) | Order panels into readable sequences: transitions, gutter ellipses, and flow from panel to panel. |
| [thumbnailing](thumbnailing/SKILL.md) | Rough each page as thumbnails to test readability before any final generation. |
| [performance-direction](performance-direction/SKILL.md) | Direct character acting as visible, drawable behavior instead of emotion labels. |
| [balloon-lettering](balloon-lettering/SKILL.md) | Place balloons, captions, and sound effects in reading order with the exact approved text. |
| [state-tracking](state-tracking/SKILL.md) | Keep the panel ledger: position, custody, wardrobe, and physical state for every character and object. |
| [reference-selection](reference-selection/SKILL.md) | Choose which approved reference images each page needs, and give each one a single role. |
| [production-orchestration](production-orchestration/SKILL.md) | Run the pipeline: phase gates, approval workflow, dependency order, and batch cost confirmation. |
| [self-evaluation](self-evaluation/SKILL.md) | Evaluate a fresh artifact cold against schema, rules, and the producing skill's quality bar; apply clear fixes. |

## Generation

| Skill | Description |
|---|---|
| [prompt-compilation](prompt-compilation/SKILL.md) | Compile provider-ready prompt packages from bibles, page files, and reference plans; never freehand. |
| [image-generation](image-generation/SKILL.md) | Generate pages and reference art through image providers with dry-run, provenance, and cost discipline. |
| [page-repair](page-repair/SKILL.md) | Repair a failed page with a targeted sibling version, locked elements, and a two-cycle limit. |

## Post

| Skill | Description |
|---|---|
| [pixel-review](pixel-review/SKILL.md) | Inspect the rendered pixels against plan and references and record evidence-based findings. |
| [continuity-checking](continuity-checking/SKILL.md) | Audit position, custody, state, wardrobe, and geography across panels, pages, and issues. |
| [edition-assembly](edition-assembly/SKILL.md) | Select reviewed page versions, assemble an edition, and export it without overwriting earlier ones. |

## How skills relate to commands and agents

A command names the agents it invokes and the skills it requires. The agents
load those skills and follow their Process sections. The pairing is fixed in
the command → agents → skills map in
[docs/conventions.md](../docs/conventions.md), and `manifests/commands.json`
mirrors it for the validation gate.

Take `/panel-ledger`. It invokes `continuity-editor` and `layout-artist` and
requires `state-tracking` and `scene-blocking`. The continuity editor fills
the ledger rows the way `state-tracking` describes, using the positions that
`scene-blocking` fixed, and then runs `scripts/check-continuity.js` because
the skill's Process tells it to.

One skill can serve several commands. `reference-selection` is used by
`/reference-plan`, `/smart-page`, and `/generate-pages`, and it reads the same
in each. Each skill lists the commands and agents that use it under Related
Commands and Related Agents.

Two skills apply by default to everything the scaffold writes:
`self-evaluation` runs on every generated artifact before it is delivered, and
`text-humanization` governs all human-facing prose.

## Format

Every `SKILL.md` follows the skill template in
[docs/conventions.md](../docs/conventions.md). The frontmatter has `name`
(equal to the directory name), `description` (the roster sentence, verbatim),
`origin: everything-ai-comics`, and `category`. The body has a title and ten
sections in this order: Purpose, Use When, Inputs, Process, Outputs, Quality
Bar, Common Failure Modes, Related Agents, Related Commands, Notes.

Process steps are numbered and name the workspace files and fields they read
and write, as specified in [docs/data-model.md](../docs/data-model.md). Where
a script does part of the job, the step gives the command line. Quality Bar
items are things a reviewer can check against the file.

## Adding a skill

A roster change touches three places, in one change:

1. The skill file: `skills/<name>/SKILL.md`, in the format above.
2. The manifest: an entry in `manifests/skills.json` with `name`, `file`,
   `description`, and `category`. Add the skill to the commands that require
   it in `manifests/commands.json`, and to any profile in
   `manifests/profiles.json` that should install it.
3. The contract: the Skills roster and the description table in
   `docs/conventions.md`, plus the command map rows for the commands that
   use it. Update this README's table too.

Then list the skill under Required Skills in those command files and under
Uses These Skills in the agents that own it, run `npm run sync:harnesses` to
regenerate the harness wrappers, and run `npm run validate`. The gate fails
on a skill missing from the manifest, a description that differs from the
roster sentence, a missing section, or an unknown category.

# Rules

Policy layers for the comics scaffold. Rules say what good work looks like.
Agents say who does the work, skills say how, and commands say when. Every
rule is normative: MUST, SHOULD, and NEVER carry their RFC 2119 meanings.

Rules are written for the assistant that loads them and for the person who
audits its output. Each one ends by naming how compliance is checked, and it
says plainly when the only possible check is a person or a reviewer looking
at the rendered page.

## Layers

| Layer | Kind | Applies to | Rules |
|---|---|---|---|
| `common/` | common | Every task, always loaded | source-of-truth, project-structure, naming-conventions, asset-provenance, cost-control, approval-policy, self-review, ask-dont-assume, visual-evidence, repair-limits |
| `writing/` | domain | Source analysis, adaptation, scripts, and any human-facing prose | comic-script-format, narrative-continuity, prose-style, adaptation-fidelity, dialogue-economy |
| `visual/` | domain | Design, staging, the panel ledger, and any judgment of a drawn image | character-consistency, location-consistency, spatial-continuity, state-continuity, visual-language |
| `layout/` | domain | Page plans, panel breakdowns, thumbnails | page-composition, panel-transitions, pacing |
| `lettering/` | domain | Balloons, captions, sound effects, and their order | balloons-and-captions, sound-effects, reading-order |
| `image/` | domain | Reference plans, prompt packages, and every image request | image-generation, reference-roles, page-generation |
| `publishing/` | domain | Editions and exports | edition-assembly, export-formats |
| `paged/` | format | Only when `comic_format: paged` | page-turn-grammar, print-specs |
| `webtoon/` | format | Only when `comic_format: webtoon` | scroll-grammar, episode-deliverables |

Each rule is the file `rules/<layer>/<name>.md`.

## Load order

1. `common/` always applies. No task, agent, or command is exempt.
2. Domain layers load by task. Writing a panel script loads `writing/`,
   `layout/`, and `lettering/`. Generating a page loads `visual/` and
   `image/`. Building an edition loads `publishing/`. A command that crosses
   domains, such as `/smart-page`, loads every layer it touches.
3. `visual/` underlies `image/`. Any task that requests or judges a drawn
   image loads the visual layer as well.
4. Exactly one format layer loads last: `paged/` or `webtoon/`.
5. The more specific rule governs inside its scope. A domain or format rule
   may tighten a common rule and may never loosen it. If a rule appears to
   contradict `common/`, the common rule wins and the conflict is a defect
   to report.
6. Contexts frame the work and rules govern it. The files in `contexts/`
   describe the current phase and choose emphasis. They do not override
   policy.

## Format layers

`paged/` and `webtoon/` are mutually exclusive. `comic_format` in
`production/project.yaml` selects one, and `paged` is the default when the
field is absent. Commands read `comic_format` before applying any layout,
pacing, or delivery default.

A format layer holds only what is true for that format: page turns, spreads,
and print geometry for bound pages; scroll rhythm, segments, and platform
delivery for vertical episodes. Craft that both formats share (composition,
transitions, lettering, reference discipline, edition rules) lives in the
common and domain layers and is not repeated in a format layer. A paged
project never loads `webtoon/`, and a webtoon project never loads `paged/`.

Each format rule states its condition in its `Scope` section, and ends with
a short list of the other format's techniques that do not belong in it.

## Rule format

Every rule follows the contract in `docs/conventions.md`:

```markdown
# Title

## Purpose
## Scope
## Core Principles         (then domain-specific rule sections)
## Validation              (how compliance is checked)
```

`npm run validate` requires those four headings by exact name. The sections
between `Core Principles` and `Validation` belong to the rule's subject and
use sentence case.

Numbers in a rule (panel counts, word budgets, margins, gutter sizes) are
defaults. Where `project.yaml` has a field for the value, the rule names it
and the project's value wins. Where it has none, the rule says where a
project records its own number.

`Validation` names real mechanisms only: a schema in `schemas/`,
`scripts/validate-workspace.js`, `scripts/check-continuity.js`,
`scripts/build-edition.js`, a hook wired in `hooks/hooks.json`, a named
check of the visual review, or human review. A rule does not claim a
mechanical check that the data model cannot support. Anything only pixels
can show is assigned to visual review (`common/visual-evidence.md`).

## Adding or changing a rule

The roster is exhaustive, and a rule exists in three places that MUST agree:

1. The file `rules/<layer>/<name>.md`, in the format above.
2. The layer's entry in `manifests/rules.json`, with the layer's `kind`
   (`common`, `domain`, or `format`).
3. The rules roster in `docs/conventions.md`.

Then run `npm run validate`, which compares the files on disk with the
manifest and the roster, and `npm run sync:harnesses`, which regenerates the
harness wrappers. Renaming or removing a rule takes the same three edits,
plus a search for references to the old path in the other rules, the
skills, and the commands.

Add a rule only for policy that no existing rule covers. Procedure belongs
in a skill, and a one-off decision belongs in the project's own files.

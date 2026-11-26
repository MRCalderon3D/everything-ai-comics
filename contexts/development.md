# Context: Development

The story phase. The project exists as words: a source text or a premise
becomes a canon registry and a plan for how many issues it takes to tell.
Nothing is drawn here.

## Goals

- A workspace with a filled `production/project.yaml`: `comic_format`,
  `publication`, page size, `color_mode`, lettering mode, default provider.
- The source text under `production/story/source/`, broken into events,
  entities, and facts.
- `story/story-bible.yaml`: every fact tagged `source`, `user_change`, or
  `addition`, with world rules, a timeline, and character arcs.
- `story/series-plan.yaml`: the story divided into issues, each with a source
  span and a page budget.

## In scope

- Reading the source and recording what it says, with a `source_ref` per fact.
- Applying user changes. A `user_change` names the fact it `replaces` and
  lists what it `affects`, so later phases know what to update.
- Listing open questions and marking which ones block generation.
- Reserving `CHAR_`, `LOC_`, and `PROP_` IDs for the entities the story needs.
- Choosing the format. `comic_format` is set once here and selects the
  `paged/` or `webtoon/` rule layer for every later phase.

## Defer

- Character design, style decisions, and any reference image. Those start in
  preproduction, from the entity list this phase produces.
- Page and panel planning. A page budget per issue is enough for now.
- Any provider spend.

## Typically active

- Commands: `/project-init`, `/source-analyze`, `/story-bible`,
  `/series-plan`, and `/humanize` for prose meant for readers.
- Agents: editor-in-chief, comic-writer, script-editor; production-qa to
  verify the new workspace.
- Rule layers: `common/` (source-of-truth, project-structure,
  naming-conventions, ask-dont-assume) and `writing/` (adaptation-fidelity,
  narrative-continuity, prose-style). The format layer matters here only for
  the publication unit: an issue in `paged/`, an episode in `webtoon/`.

## Exit criteria → preproduction

- `scripts/validate-workspace.js` is clean on `project.yaml`, the story
  bible, and the series plan.
- No open question with `blocking: true` is left without a resolution.
- Every user change has been traced: the script-editor's list of affected
  artifacts is empty or assigned.
- The human has accepted the series plan. Record that decision; a clean
  validation run is not an approval.

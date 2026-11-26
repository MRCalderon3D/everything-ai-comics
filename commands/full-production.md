---
description: Orchestrate the whole pipeline from source text to published edition, with approval gates and cost confirmation.
---

# /full-production

## Purpose

Run the whole pipeline as one supervised production. The command calls the
other commands in dependency order, stops at the end of every phase for
the user's approval, and stops before every live generation batch for a
cost confirmation. editor-in-chief drives. production-qa keeps a phase
from starting on work that has not passed the gate before it. The command
writes nothing of its own; it decides what runs next and what waits.

## Use When

- A project has `project.yaml` and source text, and you want the scaffold
  to carry it to an edition while you approve at the gates.
- A production stalled and has to be resumed. The phase is read from the
  files and the run continues at the first gate that is not passed.
- You want the total generation estimate for an issue before deciding
  anything.

## Inputs

- `source` (path, optional, default `production/story/source/`): the text
  to adapt.
- `issues` (list, optional): limit the run to some `ISS_###`; default is
  every issue in the series plan, in order.
- `budget_cap` (currency, optional): a hard ceiling. The run pauses when
  the next batch would cross it.
- `stop_after` (string, optional): the phase to halt at, e.g. `bibles` or
  `plan`.
- `--dry-run` (flag, optional): go through the phases with every
  generation step as a dry run.

## Invokes Agents

- editor-in-chief
- production-qa

## Required Skills

- production-orchestration

## Process

1. Preflight. production-qa runs `node scripts/validate-workspace.js
   --root production`, checks the chosen provider and its environment
   variables with `npm run doctor`, and reads `comic_format`,
   `lettering.mode`, and `repair_policy.max_cycles`. Determine the current
   phase from the files on disk, whatever anyone asserts.
2. Phase 1, source and canon. Run `/source-analyze`, then `/story-bible`.
   Gate: the user approves the facts by provenance and the rulings on open
   questions, every user change has been propagated, and no question with
   `blocking: true` is without a `resolution`.
3. Phase 2, series. Run `/series-plan`. Gate: the split into issues and
   the page budgets are approved.
4. Phase 3, bibles and references. Run `/character-bible`,
   `/location-bible`, `/prop-bible`, and `/style-bible`; run
   `/ingest-references` first when the user has material. Then
   `/visual-development`, with one cost confirmation per batch. Gate: every
   bible and every master a page will cite is `approved`. Nothing
   downstream binds to a draft.
5. Phase 4, plan, per issue in order. Run `/issue-breakdown`, then
   `/smart-page` for each scene (or the stations: `/page-plan`,
   `/panel-script`, `/thumbnails`, `/panel-ledger`, `/reference-plan`).
   Gate: `node scripts/check-continuity.js --root production --issue
   <ISS_ID>` and `validate-workspace.js` both report zero errors, and the
   user approves the page plan. This is the last free stop before
   generation. An approved plan approves no image.
6. Phase 5, pages. Show the estimate for the batch and wait for one
   explicit confirmation; a larger batch, another provider, or a repair
   run needs its own. Then, page by page along the reading order: run
   `/generate-pages` for one page, `/visual-review` by a reviewer who did
   not generate it, and `/repair-page` if the verdict is `flagged`. The
   next page starts only after a `pass` or `fixed`. When a page reaches
   the repair limit still flagged, stop generating, report the decision
   needed, and return to phase 4 for that page. Enforce `budget_cap`
   against the spend in the generation records.
7. Phase 6, lettering and continuity. In `overlay` mode run `/lettering`
   for every reviewed page. Then run `/continuity-review` for the issue.
   Gate: no blocking finding and no blocking entry in `open_issues`; the
   final-state file exists.
8. Phase 7, edition. Run `/build-edition`. Gate: the exports have been
   opened and checked, and the user decides when the edition is
   `published`. For a series, the next issue returns to phase 4 and opens
   from this issue's final state.
9. After every phase, record progress where it belongs: `status` on the
   series plan and the issue, on bibles and assets, on each page, and
   `human_approval` on reviews. An interrupted run resumes from those
   fields and never pays again for finished work.
10. Run the self-evaluation gates on the artifacts of the phase just
    closed before presenting it for approval, and report every gate in two
    separate lines: mechanical validation (what the scripts checked and
    the result) and visual review (which renders were inspected, by whom,
    with what verdict). The first never stands in for the second.

## Outputs

Everything the constituent commands produce, across the workspace:
`production/project.yaml` (`schemas/project.schema.json`), the story bible
and series plan under `production/story/`, the bible directories, the
registry in `production/references/manifest.yaml`, per-issue plans, pages,
renders, and reviews under `production/issues/<ISS_ID>/`, generation
records under `production/generations/`
(`schemas/generation-record.schema.json`),
`production/continuity/<ISS_ID>.final-state.yaml`
(`schemas/continuity-state.schema.json`), and editions under
`production/editions/<ED_ID>/` (`schemas/edition.schema.json`). See each
command's Outputs for the full list. This command also produces a run
report per phase: what passed which gate, what is blocked and by which
artifact, spend against estimate, and the next step.

## Notes

- Cost warning: phases 3 and 5 can spend money, and so can sketch
  thumbnails in phase 4. Every live batch shows its estimate and waits.
  Dry run stays the default at every layer, and `budget_cap` is a hard
  stop.
- Approving a phase freezes its artifacts as the source of truth for the
  next one. Skipping a review upstream is how money gets spent twice
  downstream.
- A gate that fails is information about the project. Report it to the
  user; do not route around it.
- For a first project, run the commands by hand to learn the artifacts,
  then use this one for later issues.
- Format differences: the phase order is the same for paged and webtoon
  projects. The format layer changes what the plan and the edition look
  like, and the command reads `comic_format` before phase 4.
- For a picture of an issue at any point, run `node
  scripts/build-board.js --issue production/issues/<ISS_ID>`.
- Related: every other command in `commands/`. This one orchestrates them.

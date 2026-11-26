# Page generation

## Purpose

Generate pages in an order and a manner that keeps defects from spreading:
one page at a time, each result saved as a versioned candidate, opened, and
reviewed before the next page builds on it.

## Scope

Image layer. Applies to every page render under
`issues/<ISS_ID>/pages/<PG_ID>/renders/`, to the generation records under
`generations/`, and to the `generation`, `status`, and `current_render`
fields of `page.yaml`. Used by `/generate-pages`, `/repair-page`, and
`/full-production`.

## Core Principles

- One page at a time, in reading order.
- A returned file is a candidate. A successful tool call means an image
  exists and says nothing about whether it passed.
- Nothing is overwritten. Every attempt keeps its own version number and
  its own record.
- Defects are stopped where they appear. A page with a flaw that later
  pages would copy is repaired or rejected before generation continues.
- Records state what is known. A value the tool did not report is marked
  unavailable.

## Before a page is generated

- The page file is complete and its ledger audit is clean
  (`scripts/check-continuity.js` reports no errors for the issue).
- A reference plan and a compiled prompt package exist for the page and the
  chosen provider, and the package's `source_hashes` match the current
  files.
- The previous page in the `continuity` chain has a render with a review
  verdict of `pass` or `fixed`, unless this is the first page of the issue.
- Blocking `open_questions` in the story bible are resolved.

## One page at a time

- Live generation follows the `continuity.enters_from` and `exits_to`
  chain. Page N+1 is not requested until page N's render has been opened
  and reviewed.
- Use `scripts/generate-assets.js --issue` for dry runs: cost estimates and
  handoff packages for a whole issue. It skips pages whose `status` is
  `reviewed` or `approved`. Live runs go through `--page` or `--package`,
  so that nobody renders an issue unattended.
- Reference art for different entities may be generated in the same
  session, since one sheet does not condition another. Pages may not.
- Parallel candidates of the same page are allowed when the cost was
  confirmed. Each gets its own version and record, and one is chosen at
  review.

## Full page or per panel

`generation.mode` in `page.yaml` selects the unit of a request.

- `full_page` is the default. One request produces the whole page with its
  panel borders, which keeps line and tone uniform across the panels.
- `per_panel` generates each panel as its own image. Use it when the page's
  critical references exceed the provider's limit, when a dense page (seven
  or more panels by default) loses panels or merges them in `full_page`, or
  when the same identity defect survived a repair cycle.
- Each panel is compiled on its own:
  `compile-prompts.js --page <page.yaml> --panel <PN_ID>` writes
  `prompts/<provider>.<PN_ID>.yaml` with the id
  `PP_<PAGE_ID>_<PROVIDER>-P##`, carrying only the references that panel
  needs. `build-reference-plan.js` checks the budget against the fullest
  panel, and `generate-assets.js --page` runs the panel packages it finds.
- In `per_panel` mode the panel images are working files. A panel request
  yields no page render: its image is kept beside its record under
  `generations/<PAGE_ID>/`. The scaffold has no compositor, so the panels
  are assembled to the layout in `page.yaml` outside the scaffold, in an
  image tool. The result is saved by hand as the next `<PAGE_ID>_V##` in
  `renders/` and the assembly is noted in the generation record's
  `response.summary`. The review is of that assembled page.
- `per_panel` pairs naturally with `overlay` lettering, since balloons often
  cross what would be separate requests.
- The mode is a planning decision. Changing it after a failed render counts
  as fixing the plan under `common/repair-limits.md`.

## Versioned candidates

- Every returned image is saved as
  `renders/<PAGE_ID>_V##.png` (or `.jpg`) with the next free version number.
  NEVER save over an existing version, and NEVER reuse a number.
- A repair is a sibling version produced through `/repair-page`. The file it
  repairs stays where it is.
- `current_render` in `page.yaml` names the one version the page currently
  stands on. It changes only when a newer version is reviewed.
- Rejected and superseded versions stay on disk with their prompt packages
  and records. They are evidence for the review and material for comparison.
- Each request has a generation record with `output_render` and
  `media_files` pointing at the saved file.

## Open the file

- After every request, open the saved file and look at it before doing
  anything else with it. Confirm it is the page that was asked for: panel
  count, cast, lettering present or absent according to the mode.
- `status` in `page.yaml` moves to `rendered` when the file is saved. It
  moves to `reviewed` only when a review file for `current_render` exists
  with verdict `pass` or `fixed`.
- A generation record with `status: succeeded` records that the provider
  returned an image. It is never quoted as evidence of quality.
- A correct prompt does not imply a correct picture. The review compares
  pixels with the plan and the references (`common/visual-evidence.md`).

## Defects later pages would inherit

- Some defects travel, because a reviewed page becomes a spatial reference
  for the next one: a wrong face, a wrong or missing wardrobe detail, a
  landmark on the wrong side, a redesigned prop, a missing injury, a drift
  in line or tone.
- A render with such a defect is repaired or rejected before the next page
  is requested. It is NEVER attached as a reference "for now".
- A rejected attempt is recorded: the generation record's `status` becomes
  `rejected`, and the review of that render carries the finding that caused
  it.
- When the defect comes from the plan or the references (an ambiguous
  description, a missing identity sheet), fix that first. Requesting the
  same package again repeats the cause.

## Generation records and unavailable metadata

- Every request produces one record under `generations/<scope>/`, dry runs
  included, and a `GEN_*.request.json` beside it. The request file is the
  handoff package for `harness-native` and `manual`, and it keeps the
  request as sent after the prompt package is recompiled for a repair.
- `model` is the model string the tool reported, or the literal
  `unreported`. `cost.amount` is the reported number, or `null` with
  `cost.reported: false`. `seed` is the reported integer, or `null`.
- `metadata_unavailable` lists which of `model`, `cost`, and `seed` the tool
  did not report. Harness image tools often report none of the three.
- NEVER fill a field with a guess, a typical value, or a number copied from
  another record. An estimate is allowed only in `cost.amount` with
  `cost.estimated: true`.
- The record cites the prompt package it ran, so the exact request can be
  recovered for any render.

## Validation

- `schemas/generation-record.schema.json` checks every record, including
  the allowed `status` values and the `metadata_unavailable` list.
- `scripts/validate-workspace.js` fails a page whose `status` is `reviewed`
  or `approved` without a review of its `current_render` with verdict `pass`
  or `fixed`, and resolves `current_render` and each record's
  `output_render` to files on disk. It also fails a record whose
  `metadata_unavailable` list contradicts its fields, or whose cost amount
  was neither reported nor marked as an estimate.
- `hooks/require-cost-confirmation.js` blocks `generate-assets --live`
  without `--yes`, and `hooks/validate-after-write.js` re-validates records
  and page files on write.
- Sequence is visible in the files: a render attached as a previous-page
  reference has a review dated no later than the next page's generation
  record. Production-qa reads this at issue review.
- `hooks/protect-approved-assets.js` blocks a write over an existing file
  under `renders/`. A file replaced outside the harness leaves no trace, so
  production-qa also compares the versions in `renders/` with the
  generation records.
- Whether a defect would be inherited, and whether a render is acceptable
  at all, is visual review on the opened file.

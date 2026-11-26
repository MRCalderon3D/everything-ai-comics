# Context: Production

The page phase. One issue at a time goes from breakdown to reviewed renders:
scenes and beats, page plans, panel script, ledger, reference plan, prompts,
generation, review, repair. Planning comes first and takes most of the
effort. An approved plan fixes intent; it does not approve an image that
does not exist yet.

## Goals

- `issues/<ISS_ID>/issue.yaml` and one `scenes/<SC_ID>.yaml` per scene, with
  cast, geography, and beats mapped to pages.
- A complete `page.yaml` per page: layout, panel script, ledger rows, and
  exact lettering text, with `scripts/check-continuity.js` clean before any
  prompt is compiled.
- A `reference-plan.yaml` and a compiled `prompts/<provider>.yaml` per page.
- Versioned renders under `renders/`, a generation record for each attempt,
  and a review file for each render.
- Every page's `current_render` reviewed with verdict `pass` or `fixed`.

## In scope

- Issue breakdown, page planning, thumbnails, panel scripting, and the ledger.
- Reference planning with one role per image, and prompt compilation with
  the style block reused verbatim.
- Generation one page at a time, in reading order. Open the returned file
  and review it before it is attached as a spatial reference for the next
  page.
- Visual review of every render, with evidence per check and the two gates
  recorded separately.
- Repair as a sibling version, followed by a recheck of the whole page and
  its neighbors. After `repair_policy.max_cycles` failed cycles (two by
  default), stop and fix the plan or the references.

## Defer

- Overlay lettering geometry and the issue-wide continuity pass. Both belong
  to publishing, once the renders are settled.
- Editions and exports.
- Bible and canon changes. If a review finding traces back to an ambiguous
  character description or a missing landmark, the fix is made in the bible
  by its owner, and then the page is recompiled.

## Typically active

- Commands: `/issue-breakdown`, `/page-plan`, `/panel-script`,
  `/thumbnails`, `/panel-ledger`, `/smart-page`, `/reference-plan`,
  `/generate-pages`, `/visual-review`, `/repair-page`, and `/full-production`
  for orchestrated runs.
- Agents: layout-artist, comic-writer, penciller, letterer, continuity-editor,
  prompt-director, image-generation-specialist, visual-reviewer,
  art-director; editor-in-chief and production-qa at the gates.
- Rule layers: `common/` (cost-control, visual-evidence, repair-limits,
  asset-provenance), `writing/` (comic-script-format, dialogue-economy),
  `visual/` (spatial-continuity, state-continuity, character-consistency),
  `layout/`, `lettering/` for the text in `page.yaml`, and `image/`
  (page-generation, reference-roles). Load exactly one format layer:
  `paged/page-turn-grammar` when `comic_format` is `paged`,
  `webtoon/scroll-grammar` when it is `webtoon`.
- Scripts: `check-continuity.js`, `build-reference-plan.js`,
  `compile-prompts.js`, `generate-assets.js`, and `build-board.js` for a
  one-page view of the issue's status and verdicts.

## Exit criteria → publishing

- Every page of the issue has `status: reviewed` and a review of its
  `current_render` with verdict `pass` or `fixed`.
- No blocking finding is open. Rejected and superseded renders are still on
  disk, and none is listed as current.
- `scripts/validate-workspace.js --issue <ISS_ID>` and
  `scripts/check-continuity.js --issue <ISS_ID>` are clean. Report those
  results as mechanical validation, apart from the visual review.
- Spend from the generation records is reconciled with the estimates, with
  unreported costs listed as unreported.

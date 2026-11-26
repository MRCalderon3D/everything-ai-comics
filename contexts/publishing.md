# Context: Publishing

The delivery phase. Reviewed pages become something a reader can open:
lettering is placed and checked, continuity is audited across the whole
issue, and an edition lists the exact render of every page and exports it.

## Goals

- Lettering finished in the project's mode. In `overlay` mode that means a
  `lettering.yaml` per page and a `renders/<RENDER_ID>.lettered.svg` from
  `scripts/letter-pages.js`, exported to PNG or JPEG in a browser or a
  vector tool so the edition can list it as `lettered_file`. In `in_image`
  mode it means every string on the render checked against `page.yaml`.
- `continuity/<ISS_ID>.final-state.yaml`: where every character and prop
  ends the issue, with open threads and open issues listed.
- `editions/<ED_ID>/edition.yaml` and its exports under `exports/`: PDF, CBZ,
  and web reader as the project's `deliverables` require.

## In scope

- Balloon, caption, and sound-effect placement; reading order; tails that
  point at the right speaker; text that covers no face, hand, or action.
- A lettering check on the actual render or lettered file, recorded as the
  `lettering` check of the review.
- The issue-wide continuity pass: page boundaries, the `enters_from` and
  `exits_to` chain, and the state the next issue opens from (`opens_from`).
- Edition assembly from reviewed renders only. `scripts/build-edition.js`
  refuses a render without a `pass` or `fixed` review unless `--draft` is
  given, and a draft export is labelled as a draft.
- New editions for corrections: the next `ED_<issue>_##`, with `supersedes`
  and `changes` filled in.

## Defer

- New pages, restaging, and script changes. Those reopen production for the
  pages concerned.
- Repairs run from here. A lettering or continuity defect found now goes
  back through `/repair-page` and `/visual-review` with the usual limits,
  and the edition waits for the new render.
- Rasterizing the SVG overlay and cropping for social carousels. The
  scaffold lists those deliverables; an image tool produces them.

## Typically active

- Commands: `/lettering`, `/continuity-review`, `/build-edition`.
- Agents: letterer, visual-reviewer, continuity-editor, prepress-specialist,
  production-qa, editor-in-chief for the sign-off.
- Rule layers: `common/` (approval-policy, asset-provenance,
  visual-evidence), `lettering/`, `visual/` (state-continuity,
  spatial-continuity) for the continuity pass, and `publishing/`
  (edition-assembly, export-formats). From the format layer, load
  `paged/print-specs` or `webtoon/episode-deliverables`, never both.
- Scripts: `letter-pages.js`, `check-continuity.js`, `build-edition.js`,
  `validate-workspace.js`.

## Exit criteria → review, or done

- The edition lists every page once, in order, and each listed render has a
  review with verdict `pass` or `fixed`.
- Exports exist under `editions/<ED_ID>/exports/` and none replaced an
  earlier file.
- The final-state file is written and `scripts/check-continuity.js` is clean
  for the issue.
- The handoff names the shipped file per page, what was repaired, what was
  rechecked on the pixels, and what still needs a decision. A draft or
  flagged page is never described as approved.
- The edition moves to `published` only on a human decision.

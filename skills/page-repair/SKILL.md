---
name: page-repair
description: Repair a failed page with a targeted sibling version, locked elements, and a two-cycle limit.
origin: everything-ai-comics
category: generation
---

# Page Repair

## Purpose

Fix a flagged render with the smallest change that addresses its findings,
and prove the fix by looking at the new file. A repair produces a sibling
version next to the failed one. It names what must change and what must
stay, and it stops after the project's limit of cycles, at which point the
problem belongs to the plan or the references.

## Use When

- A review file has verdict `flagged` with one or more `open` findings.
- A minor finding is worth correcting before an edition is built.
- A repair attempt came back and needs to be verified or followed up.

## Inputs

- The review file `reviews/<RENDER_ID>.review.yaml`: findings with `panel`,
  `check`, `expected`, `visible`, `severity`, and `repair`.
- The flagged render and its prompt package.
- `page.yaml`, the reference plan, and the bibles for the entities named in
  the findings.
- `project.repair_policy.max_cycles` (default 2) and the review's
  `repair_cycle`.
- The renders of the neighboring pages.

## Process

1. Check the budget. If the flagged review's `repair_cycle` already equals
   `max_cycles`, do not repair. Go to step 11.
2. Mark the failed render as superseded and keep it. Its file, prompt
   package, and review stay on disk. Set its generation record to
   `status: rejected`. It will stop being the page's `current_render` when
   the sibling exists.
3. Find the cause upstream before writing any request. For each finding,
   ask what the model was given. An identity swap usually means a missing
   sheet, an empty `visually_adjacent_to`, or two descriptions that read
   alike. A wrong position means a ledger row without a landmark. A
   changed object means a prop without `distinguishing_features`. Fix the
   bible, the ledger, or the reference plan first. Sending the same
   ambiguous description again produces the same picture.
4. Write the repair precisely, in the finding's `repair` field and then in
   the package: the edit target (the flagged render), the failing panels by
   ID, the exact changes ("panel 3: give Oskar a round face and a hooded
   jacket, matching image 2"), and the locked elements ("all lettering,
   panel borders, Mara in every panel, panels 1, 2, and 4 entirely").
5. Split the work when findings are of different kinds. Identity repairs
   go in one request; prop and state repairs go in another. A combined
   request tends to carry out the most visible change and skip the rest.
   Each request produces its own version and counts as one cycle, so order
   them with the blocking findings first.
6. Compile the repair package:
   `node scripts/compile-prompts.js --page <page.yaml> --repair <review.yaml>`.
   Check `mode: repair`, `edit_target`, and the `repair` block (`of_render`,
   `findings`, `changes`, `locked`). If the provider lacks `imageEditing`,
   the repair is a full regeneration from the corrected plan; it is still
   a sibling version and still a cycle.
7. Generate under `image-generation`: dry run, confirmation, live call.
   Save the result as the next version (`<PG_ID>_V##`). Never write over
   the flagged file.
8. Reopen the new render and verify each requested change, one finding at
   a time, in the pixels. A successful edit call is not evidence. Record,
   per finding, `status: fixed` with `recheck.render` and `recheck.evidence`
   describing what is now visible, or leave it `open`.
9. Recheck the whole page for collateral changes: lettering strings, the
   other characters' faces, hands and anatomy, clothing, which side the
   landmarks are on, the panel count. Edits leak outside their target.
10. Recheck the neighbors. Compare with the previous and next pages'
    renders for wardrobe, state, and geography across the page boundary.
    Write the new review file for the sibling render with `supersedes`,
    `repair_cycle` raised by one, all fourteen checks, and a verdict:
    `fixed` when every blocking finding is fixed and rechecked, `flagged`
    otherwise. Point the page's `current_render` at the sibling.
11. At the limit, stop generating. Record the upstream issue and the
    decision needed in the review, leave the verdict `flagged`, and return
    the page to its plan (`/page-plan`, `/panel-script`, `/panel-ledger`) or
    its references (`/character-bible`, `/visual-development`). A page that
    fails twice is telling you the panel asks for something the plan does
    not pin down.

## Outputs

- A sibling render `<PG_ID>_V##` under the page's `renders/`.
- A repair prompt package under `prompts/` and a generation record per
  attempt.
- A review file for the new render (`visual-review` schema) with
  `supersedes`, `repair_cycle`, and a `recheck` on every fixed finding.
- Upstream corrections in the bible, ledger, or reference plan, where the
  cause was found there.

## Quality Bar

- The flagged render and its review are still on disk and unmodified.
- Every finding marked `fixed` has a `recheck` naming the new render and
  describing visible evidence.
- The repair package lists failing panels, exact changes, and locked
  elements; none of the three is empty.
- The new review covers the whole page and names the neighbors it was
  compared against in `compared_against.neighbors`.
- `repair_cycle` never exceeds `project.repair_policy.max_cycles`.
- The verdict is `fixed` only if no blocking finding is `open`.

## Common Failure Modes

- Overwriting the failed render, so the review's evidence points at a file
  that no longer shows the defect.
- "Fix the face in panel 3" sent with the same prompt and the same
  references that produced the wrong face.
- Declaring the page fixed because the edit request returned without
  error. The returned image is identical to the original.
- Checking only the repaired panel. The balloon in panel 1 lost a word and
  nobody looked.
- One request for a face, a gun, and a bloodstain. The face changes, the
  gun and the stain do not.
- No locked list. The model redraws the whole page and the unaffected
  panels come back different.
- A third and fourth reroll because the last one was close.
- A repaired page that now disagrees with its neighbors: the coat is torn
  on page 2 and whole on the repaired page 3.

## Related Agents

- visual-reviewer
- prompt-director
- image-generation-specialist

## Related Commands

- repair-page

## Notes

The limit is `project.repair_policy.max_cycles`. Its default of 2 is where
this skill's one-line description gets "two-cycle" from, and a project may
change it. `validate-workspace.js` rejects a review whose `repair_cycle`
exceeds it and a `fixed` finding without a recheck. The verification itself
follows `pixel-review`, and the reviewer who rechecks should not be the
agent that generated the repair. The rules are `rules/common/repair-limits.md`
and `rules/common/visual-evidence.md`.

---
name: production-orchestration
description: "Run the pipeline: phase gates, approval workflow, dependency order, and batch cost confirmation."
origin: everything-ai-comics
category: production
---

# Production Orchestration

## Purpose

Coordinate the production from source text to published edition: work out
where the project stands from its files, decide what may start next, hold each
gate, confirm cost before any live batch, and make it possible to stop and
pick up again on another day without redoing or skipping work.

## Use When

- `/project-init` creates a workspace, or `/full-production` runs the
  pipeline.
- Someone asks whether a phase may start or an artifact may be used
  downstream.
- A session resumes and the first question is "where were we".
- An upstream change (a canon fact, a character sheet, a location map) has to
  reach everything built on it.

## Inputs

- `production/project.yaml` and the current state of every artifact in the
  workspace.
- Status fields: `status` in `series-plan.yaml`, `issue.yaml`, `page.yaml`,
  the character, location, and prop files, `references/manifest.yaml`, and
  `edition.yaml`.
- Review files under each page's `reviews/` and generation records under
  `production/generations/`.
- The command map in `docs/conventions.md` and the phase contexts in
  `contexts/`.
- Provider capabilities and pricing for batch estimates.

## Process

1. Find the workspace root (the nearest directory with `project.yaml`) and
   read `comic_format`, `lettering.mode`, `default_providers.image`, and
   `repair_policy.max_cycles`. Never mix artifacts from two workspace roots.
2. Determine the phase from the files, whatever anyone asserts:
   - development: source text, fact registry, story bible, series plan.
   - preproduction: character, location, prop, and style bibles; approved
     master references; issue breakdown; page plans; panel scripts;
     thumbnails; ledgers; reference plans; prompt packages.
   - production: page renders, reviews, repairs, lettering.
   - publishing: issue-level continuity review, editions, exports.
   - review: audits of any of the above.
3. Enforce the dependency order. The fact registry comes before the story
   bible. The bibles and the style bible come before master references.
   Approved masters come before any page cites them. Issue breakdown comes
   before page plans, page plans before panel scripts, and scripts before
   the ledger. A clean ledger comes before reference plans, reference plans
   before prompt packages, and prompt packages before generation. A render
   comes before its review, and a `pass` or `fixed` review comes before
   lettering overlays, the continuity state, and the edition.
4. Hold the canon gate. Before any generation, every entry in the story
   bible's `open_questions` with `blocking: true` has a `resolution`.
5. Hold the plan gate. Before prompts are compiled for an issue, run both
   commands and require zero errors:
   `node scripts/validate-workspace.js --root <workspace> --issue <ISS_ID>`
   and `node scripts/check-continuity.js --root <workspace> --issue <ISS_ID>`.
   An approved plan fixes intent. It approves no image.
6. Hold the cost gate. Before a live batch, list the pages or assets, the
   provider, the number of requests, and the estimated cost, and wait for an
   explicit yes. One confirmation covers exactly the batch shown. A larger
   batch, another provider, or a repair run is a new batch and needs its own
   confirmation. `generate-assets.js` runs dry by default and goes live only
   with `--live --yes`. Dry runs need no confirmation.
7. Keep generation sequential. Generate one page, open the returned file,
   review it, and only then let it serve as a reference for the next page.
8. Hold the review gate. A page moves to `status: reviewed` only when the
   review of its `current_render` has verdict `pass` or `fixed`. Human
   approval is a separate decision recorded in `human_approval` on the
   review. Never let the agent that generated a page be its only reviewer.
9. Hold the repair limit. When a review's `repair_cycle` reaches
   `repair_policy.max_cycles` and the page is still flagged, stop
   generating. The next work is on the plan or the references, and the user
   hears what decision is needed. A touch-up the user asks for past
   `repair_policy.touch_up_warning` waits for their choice between touching
   up anyway and a redraw from the plan.
10. Run approvals. Bibles and reference assets move `draft`, `review`,
    `approved`, and only an explicit sign-off from the user or the
    editor-in-chief sets `approved`. Approved assets are immutable: a change
    is a new `_V##` version, and the old one becomes `superseded` in the
    manifest.
11. Propagate upstream changes. When a canon fact changes, read its
    `affects` list and walk downstream: wardrobe, dialogue, references,
    page files, prompt packages, renders. Mark what is now stale and send it
    back through its gate. A user change reaches every dependent artifact or
    it has not been applied.
12. Resume from the files. For each page read `status`, `current_render`,
    and the review file, and pick the next step:

    | State on disk | Next step |
    |---|---|
    | `planned` | `/panel-script` |
    | `scripted`, ledger not clean | `/panel-ledger` |
    | `scripted`, ledger clean | `/reference-plan`, then compile prompts |
    | `prompted` | `/generate-pages` (cost gate) |
    | `rendered`, no review file | `/visual-review` |
    | review `flagged`, cycles left | `/repair-page` |
    | review `flagged`, cycles used | fix the plan or references |
    | `reviewed`, overlay mode, no lettered file | `/lettering` |
    | every page `reviewed` | `/continuity-review`, then `/build-edition` |

    For a picture of the whole issue, run
    `node scripts/build-board.js --issue <issues/ISS_001 dir>`.
13. Keep a run log per session: what was produced, what passed which gate,
    what is blocked and by which missing artifact. Report mechanical
    validation and visual review as two separate lines.
14. Escalate a failing gate to the user. A gate that fails is information
    about the project, and routing around it hides that information.

## Outputs

- Updated status fields on the series plan, issues, pages, and assets.
- A ready/blocked report per phase, each blocked item naming the artifact
  that blocks it.
- One recorded cost confirmation per live batch.
- A resume point: the next command and the page or asset it applies to.

## Quality Bar

- No artifact was built from an unapproved, stale, or unreviewed source.
- Every live batch has an estimate and a confirmation that match its
  contents.
- Every blocked item names the exact file that blocks it.
- The phase and the next step can be reconstructed from the files alone.
- No page has `status: reviewed` or `approved` without a `pass` or `fixed`
  review of its current render.
- The session report keeps script results apart from visual verdicts.

## Common Failure Modes

- Skipping the ledger audit to keep momentum, then paying for renders that
  must be redone.
- One cost confirmation reused for a second, larger batch.
- Approval read into silence instead of a recorded sign-off.
- A whole issue generated in parallel, so no page had a reviewed neighbor to
  condition on.
- A third and fourth repair attempt on the same page while the character
  sheet that caused the failure stays ambiguous.
- A changed canon fact applied to the script and left out of the wardrobe
  file and the prompts.
- "All tests pass" reported as if it said anything about the drawings.
- Resuming from memory of the last session and regenerating pages that
  already had reviewed renders.

## Related Agents

- editor-in-chief
- production-qa

## Related Commands

- project-init
- full-production

## Notes

Hooks enforce parts of this mechanically: `validate-after-write`,
`protect-approved-assets`, `detect-continuity-drift`, and
`require-cost-confirmation`. Orchestration still owns the order of work and
the job of making a blockage visible.

`/smart-page` is a shortcut through the middle of preproduction for one
scene. It passes the same gates in the same order.

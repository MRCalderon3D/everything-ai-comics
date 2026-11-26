---
name: image-generation
description: Generate pages and reference art through image providers with dry-run, provenance, and cost discipline.
origin: everything-ai-comics
category: generation
---

# Image Generation

## Purpose

Run compiled prompt packages through an image provider to produce page
renders and reference art. Every run is dry by default, every paid call is
confirmed first, every returned file is opened and saved as a versioned
candidate, and every file gets a generation record that says only what the
tool reported.

## Use When

- A page has a compiled prompt package and is next in line.
- A character sheet, location plate, or look master needs rendering.
- A repair package is ready to be run against a flagged render.

## Inputs

- A compiled prompt package (`prompt-package` schema) whose `source_hashes`
  match its sources.
- The provider adapter and its capabilities: fal, replicate, comfyui,
  gemini, harness-native, or manual (`manifests/image-providers.json`), with
  the environment variables the provider requires.
- The page's `continuity` block and the review status of the previous page.
- Confirmation of scope and cost from the user or the orchestrator.

## Process

1. Check the order. Pages are generated one at a time, in reading order.
   When `continuity.attach_previous_render` is true, the previous page's
   render has been opened and reviewed before this one starts, because this
   page will copy its setting, including its mistakes.
2. Check the provider against the task: enough reference slots for the
   plan, the page's aspect ratio, `textRendering` for in-image lettering,
   `imageEditing` for a repair. `harness-native` and `manual` call no
   network; they write a handoff for the harness's own image tool or for a
   person.
3. Dry-run first, always:
   `node scripts/generate-assets.js --page <page.yaml>` (or
   `--package <prompt-package.yaml>` for an asset). It writes the request
   and a generation record with `status: dry_run` under
   `production/generations/`. Read what would be sent: prompt, references
   in order, parameters.
4. State the cost and get an explicit yes. `--issue <issue dir>` in dry-run
   mode is the way to estimate a whole issue. Live calls need
   `--live --yes`; a missing environment variable aborts the run, and the
   answer is to set the variable, never to paste a credential into a file
   or a prompt.
5. Run the live call for one page. Never loop live calls over an issue
   without a review between pages.
6. Open the actual returned file. A successful call means an image exists.
   It says nothing about whether the page is right, or whether the file is
   a full page at all.
7. Save the file as the next versioned candidate:
   `issues/<ISS_ID>/pages/<PG_ID>/renders/<PG_ID>_V##.png`. Take the next
   free number. A file already in `renders/` is never overwritten, renamed,
   or deleted.
8. Complete the generation record (`GEN_<page-id>_<attempt##>`):
   `provider`, `prompt_package`, `output_render`, `media_files`, `status`,
   `created_at`. Write `model`, `cost.amount`, and `seed` only if the tool
   reported them. Otherwise set `model: unreported`, `cost.amount: null`
   with `reported: false`, `seed: null`, and list them in
   `metadata_unavailable`. Never invent a value to fill the form.
9. Set the page's `current_render` to the new render and `status` to
   `rendered`. Hand it to `/visual-review`. The specialist who generated
   the page does not sign off its review.
10. Stop on failure. A failed or empty response is recorded with
    `status: failed` and its `response.error`. A render with defects goes
    to `/repair-page` and is not rerolled here.

## Outputs

- Page renders under `issues/<ISS_ID>/pages/<PG_ID>/renders/`, or reference
  art under the entity's `refs/` directory.
- One generation record per attempt under
  `production/generations/<PG_ID or ASSET_ID>/` (`generation-record`
  schema), dry runs included.
- `current_render` and `status: rendered` on the page.

## Quality Bar

- No live call without a dry run read first and a recorded confirmation of
  cost.
- Every image file has a generation record, and every record's
  `media_files` exist on disk.
- No render file was overwritten: version numbers only go up.
- `model`, `cost.amount`, and `seed` hold reported values or their
  unavailable markers, and `metadata_unavailable` lists exactly the ones
  not reported.
- The returned file was opened before the page status changed.
- No page was generated with an unreviewed previous render attached.

## Common Failure Modes

- Batch generation of an issue. Page 2 has the wrong face, and pages 3 to
  8 have already copied it from the attached render.
- Reporting success from the tool's return value without opening the file.
  The "page" is a single illustration with no panels.
- Saving a second attempt over `V01`, which destroys the evidence the
  review file refers to.
- Filling `model` and `cost` with plausible guesses because the fields
  looked empty.
- A live run inside a loop with `--yes` hard-coded.
- Running a stale package after the page or the style block changed.
- Rerolling the same package five times in the hope of a better draw. If
  the plan is ambiguous, every draw is ambiguous.
- Treating the generating agent's own glance at the image as the review.

## Related Agents

- image-generation-specialist
- prompt-director

## Related Commands

- generate-pages

## Notes

`scripts/generate-assets.js` wraps the provider adapters and enforces the
dry-run default and the environment checks; `hooks/require-cost-confirmation.js`
blocks live runs that lack confirmation. `/visual-development` and
`/repair-page` send their generation through this same procedure. The rules
are `rules/image/image-generation.md`, `rules/image/page-generation.md`,
`rules/common/cost-control.md`, and `rules/common/visual-evidence.md`.

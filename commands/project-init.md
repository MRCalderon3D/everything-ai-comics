---
description: "Scaffold a production/ workspace: project.yaml, directory layout, and phase plan."
---

# /project-init

## Purpose

Create the `production/` workspace that every other command reads and writes.
The command fixes the project's identity in `project.yaml` (format, page size,
language, color mode, lettering mode, provider, repair limit), builds the
directory layout from `docs/conventions.md`, copies the starter files, and
writes down the order of the phases with their gates. Later commands read
these answers instead of asking again.

## Use When

- Starting a comic from nothing, before any source text is analyzed.
- Bringing an existing story or script into the scaffold. Run this first,
  then `/source-analyze`.
- A workspace has lost directories or its `project.yaml` no longer validates.
  Existing files are kept unless the user asks for a repair.
- A second production starts in the same clone. Give it its own root
  (`production-<slug>/`); workspaces never share assets or continuity.

## Inputs

Anything missing is asked in one batched interview, each question with a
recommended default (`rules/common/ask-dont-assume.md`). Nothing is defaulted
silently.

- `title` (string, required): working title.
- `target` (path, optional, default `./<title-slug>`): project directory;
  `production/` is created inside it.
- `comic_format` (enum, optional, default `paged`): `paged` | `webtoon`.
  Selects the format rule layer.
- `publication` (enum, required): `strip` | `one-shot` | `miniseries` |
  `ongoing` | `graphic-novel` | `webtoon-series`.
- `language` (string, optional, default `en`): language of the lettering.
- `reading_direction` (enum, optional, default `ltr`): `ltr` | `rtl`.
- `page` (object, required): `aspect_ratio`, `width_px`, `height_px`.
  Suggested for paged: `2:3` at 2000 x 3000. For a print deliverable also
  `trim_mm`, `bleed_mm`, and `safe_margin_mm`.
- `color_mode` (enum, required): `monochrome` | `limited` | `full_color`.
- `lettering_mode` (enum, required): `in_image` | `overlay`.
- `image_provider` (string, optional, default `harness-native`): an ID from
  `manifests/image-providers.json`.
- `deliverables` (list, optional): `pdf` | `cbz` | `web` | `images` | `epub` |
  `social-carousel` | `print`.
- `rating` and `violence_treatment` (optional): written to `content`.
- `max_repair_cycles` (int, optional, default 2): `repair_policy.max_cycles`.
- `--force` (flag, optional): overwrite an existing `project.yaml`. Starter
  files that already exist are always kept.

## Invokes Agents

- editor-in-chief
- production-qa

## Required Skills

- production-orchestration

## Process

1. Look for an existing workspace root (a directory holding `project.yaml`)
   in the target. If one exists, report its state and stop, unless the user
   asked to repair it.
2. editor-in-chief interviews for every missing input in one pass. Check the
   chosen provider's `capabilities` in `manifests/image-providers.json` while
   asking: the page `aspect_ratio` has to be in its `aspectRatios`, and when
   `textRendering` is `unreliable` or `none` the recommended lettering mode
   is `overlay`.
3. Run `node scripts/create-project.js --title "<title>" --target <dir>
   --format <paged|webtoon>`. It creates the layout (`story/source/`,
   `style/`, `characters/`, `locations/`, `props/`, `references/` with
   `inbox/`, `style/`, and `docs/`, `issues/`, `generations/`,
   `continuity/`, `editions/`) and copies the starter story bible, series
   plan, style documents, and reference registry from `templates/`.
4. Write the interview answers into `project.yaml`: `title`, `comic_format`,
   `publication`, `logline`, `genre`, `language`, `reading_direction`,
   `page`, `color_mode`, `lettering.mode`, `default_providers.image`,
   `deliverables`, `content`, and `repair_policy.max_cycles`. Leave
   `style.look_refs` empty until `/visual-development` has an approved look
   master.
5. Write the phase plan for this publication: the commands in order, the
   approval gate that closes each phase, and which phases can spend money.
   A one-shot plans a single issue; a series repeats the issue phases per
   issue. Put the plan in the `notes` field of `project.yaml` and show it to
   the user.
6. Ask where the source text is and copy it into
   `production/story/source/`. The files stay as the user wrote them.
7. production-qa runs `node scripts/validate-workspace.js --root production`
   and compares the directory tree with the layout in `docs/conventions.md`.
   Report any difference before finishing.
8. Run the self-evaluation gates on `project.yaml` (schema, rules, quality
   bar, improvement pass, per `rules/common/self-review.md`). Apply the
   clear fixes and report the verdict.

## Outputs

- `production/project.yaml`, validates against `schemas/project.schema.json`.
- `production/story/story-bible.yaml` and `production/story/series-plan.yaml`,
  starter files (`schemas/story-bible.schema.json`,
  `schemas/series-plan.schema.json`).
- `production/story/source/`, the user's source text.
- `production/style/style-bible.md`, `style-block.txt`, and
  `color-script.md`, starter documents (no schema).
- `production/references/manifest.yaml`, the empty reference registry.
- The directory layout from `docs/conventions.md`.

## Notes

- This command generates no images and costs nothing.
- `comic_format` decides which format layer every later command loads:
  `rules/paged/` or `rules/webtoon/`. In a webtoon project a page is one
  scroll segment, so `page.width_px` and `page.height_px` describe a segment.
  Changing the format after pages are planned means replanning them.
- The provider and the lettering mode set here are inherited by
  `/smart-page`, `/generate-pages`, and `/lettering`. Change them in
  `project.yaml`, never in a single prompt.
- Escalate to the user when the provider cannot produce the requested aspect
  ratio, or when the publication type and the page budget they describe do
  not fit each other.
- Next step: `/source-analyze`. For the guided pipeline, `/full-production`.

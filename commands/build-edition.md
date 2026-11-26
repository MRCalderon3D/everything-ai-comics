---
description: Assemble reviewed pages into an edition and export PDF, CBZ, and web reader.
---

# /build-edition

## Purpose

Turn an issue's reviewed pages into something a reader can open. An
edition is a list: the exact render that ships for every page, in reading
order. From that list the command exports a PDF, a CBZ, and a web reader.
Editions are never rebuilt over each other. The pilot went through seven
of them, and a later build overwrote earlier exports. Here a corrected
edition gets a new ID and says what it replaces and what changed.

## Use When

- `/continuity-review` has passed for the issue and every page stands on a
  render with verdict `pass` or `fixed`.
- A reading copy of work in progress is needed (`--draft`).
- A published edition needs a correction. That is a new edition.

## Inputs

- `issue` (ID, required): the `ISS_###` to assemble.
- `formats` (list, optional, default the `pdf`, `cbz`, and `web` targets in
  `deliverables` of `project.yaml`, else `pdf,cbz`): export formats.
- `label` (string, optional, default `first edition` or the next ordinal):
  the edition's human label.
- `supersedes` (ID, optional): the `ED_<issue>_##` this edition corrects.
- `--draft` (flag, optional): build although some renders lack a passing
  review. Every export is marked as a draft.

## Invokes Agents

- prepress-specialist
- editor-in-chief
- production-qa

## Required Skills

- edition-assembly

## Process

1. Check that the issue is ready. Every page has a `current_render`, the
   review of that render has verdict `pass` or `fixed`, and
   `production/continuity/<ISS_ID>.final-state.yaml` exists with no
   blocking entry in `open_issues`. If anything falls short, stop, or build
   a draft and say that it is one.
2. Take the next edition ID for the issue (`ED_<issue>_##`). An ID is never
   reused, even for a build that failed.
3. Write `production/editions/<ED_ID>/edition.yaml`: `id`, `issue`,
   `title`, `label`, `status: draft`, `supersedes`, `changes`, `pages`, and
   an empty `exports` list.
4. List the pages in page-number order, once each, with no gaps. For each,
   copy `render` from the page's `current_render` after confirming its
   review, and set `file` to that image's path relative to the workspace
   root. Do not take the newest file in `renders/`; it may be a rejected
   attempt.
5. Overlay lettering: run `/lettering` for any page without a lettered
   output, flatten the SVG over the render in a browser or a vector tool,
   and set `lettered_file` to the flattened PNG or JPEG. Its file name
   starts with the render ID (`<RENDER_ID>.lettered.png`); the build
   rejects an SVG and a file named for another render. In `in_image` mode
   leave it `null`.
6. For a correction, set `supersedes` to the earlier edition and list in
   `changes` which page now uses which render and why ("PG_001_002 uses V02
   instead of V01: Oskar's face corrected in panel 3"). The earlier
   edition's directory is left as it is.
7. production-qa validates before anything is built: `node
   scripts/validate-workspace.js --root production --issue <ISS_ID>`.
8. Build: `node scripts/build-edition.js --edition
   production/editions/<ED_ID>/edition.yaml --formats pdf,cbz,web`. The
   script refuses a render without a `pass` or `fixed` review unless
   `--draft` is given, and it skips an export file that already exists.
   Without `--formats` it builds the `pdf`, `cbz`, and `web` targets listed
   in `deliverables`, or `pdf` and `cbz` when none is listed. Keep `--force`
   for rerunning a build nobody has received yet. It replaces exports only
   while the edition's status is `draft` or the build is `--draft`; on a
   `reviewed` or `published` edition the script stops with
   `force-not-draft`. Once an export has gone to anyone, the answer is a
   new edition.
9. Open every export. Count the pages, read them in order, and confirm
   each page is the listed render. Check the page size in the PDF, the
   sort order of the files in the CBZ, and that the web reader advances in
   the project's `reading_direction` or scrolls as one column for a
   webtoon. Confirm `exports` now lists each file with `format`, `file`,
   and `built_at`.
10. editor-in-chief moves the status on evidence. `draft` becomes
    `reviewed` when the exports have been opened and checked. `reviewed`
    becomes `published` when the user says the edition has gone out; then
    set the issue's `status` to `published` in `issue.yaml` and in the
    series plan. A draft build never becomes `published`.
11. Run the self-evaluation gates on the edition file and write the
    delivery note: the current render of every page by filename, the
    rejected versions kept for comparison, what was repaired since the
    last edition, what was visually rechecked, and what still needs a
    decision. Report script validation and visual review as separate
    lines. Drafts and flagged pages are not described as approved.

## Outputs

- `production/editions/<ED_ID>/edition.yaml`, validates against
  `schemas/edition.schema.json`.
- `production/editions/<ED_ID>/exports/`: the PDF, the CBZ, and the web
  reader directory, named
  `<title-slug>-<issue number>-ed<edition number>[-DRAFT]` with the
  extension `.pdf` or `.cbz`, or the suffix `-web` for the reader directory
  (`the-night-ferry-001-ed01.cbz`, `the-night-ferry-001-ed01-web/`).
  `-DRAFT` marks a draft build.
- `production/issues/<ISS_ID>/issue.yaml` and
  `production/story/series-plan.yaml`, `status` updated on publication.
- The delivery note, in the conversation.

## Notes

- This command generates no images. It only reads renders that already
  exist.
- Only `pass` and `fixed` renders enter a non-draft edition. A page whose
  review is `flagged`, or missing, makes the whole build a draft.
- Other deliverables in `project.yaml` are prepared by hand from the
  edition. For `social-carousel`, name the pages or panels and the crop
  each needs. For `print`, state trim, bleed, and safe margin from the
  `page` block (`rules/paged/print-specs.md`). The scripts do not crop or
  composite images.
- Format differences: a paged edition exports one image per page. A
  webtoon edition exports the segments as one vertical column and follows
  `rules/webtoon/episode-deliverables.md`.
- `build-edition.js` records the exports by replacing only the `exports`
  block of `edition.yaml`, so comments elsewhere in the file survive and
  comments inside that block do not. When the block cannot be replaced
  safely it rewrites the whole file through the YAML library, loses the
  comments, and says so.
- Related: `/continuity-review` (gate), `/lettering` (overlay output),
  `/visual-review` (the verdicts this command reads), `/full-production`
  (runs this last).

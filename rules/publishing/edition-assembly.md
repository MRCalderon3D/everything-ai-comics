# Edition assembly

## Purpose

Make an edition a precise statement of what shipped: which render of every
page, under which label, replacing which earlier edition, and with what
review standing.

## Scope

Publishing layer. Applies to every `editions/<ED_ID>/edition.yaml`, to the
selection of renders for it, and to any report that describes an edition.
Used by `/build-edition` and `/full-production`. The files an edition is
exported to are covered by `export-formats.md`.

## Core Principles

- An edition names exact files. "The latest version of each page" is never a
  page list.
- Review standing travels with the page. Only reviewed renders enter an
  edition that is called anything other than a draft.
- A draft looks like a draft, in its status, in its label, and on its
  exports.
- Published history is kept. A correction is a new edition, and the old one
  stays.
- Reports use the words the files support. Nothing is called approved
  unless a person approved it.

## The page list

- `pages` lists every page of the issue once, in page-number order, with no
  gaps. Each entry names the `page`, the exact `render` that ships, and the
  `file` of that render relative to the workspace root.
- The render is chosen deliberately. It is normally the page's
  `current_render`. When an edition ships a different version, `changes` or
  `notes` says which and why.
- The file named in an entry is the file of that render: same page, same
  version number. An entry never points at a copy, a renamed file, or an
  image edited outside the pipeline.
- In overlay lettering mode each entry also names its `lettered_file`: the
  image exported from the overlay that `scripts/letter-pages.js` built on the
  listed render. Its file name starts with the render ID. An overlay built
  on another version of the page is not valid for this edition.
- Anything that precedes or follows the story pages (cover, credits, back
  matter) is listed in the edition's `notes` until it is planned as a page
  of the issue.

## Review standing

- An edition with status `reviewed` or `published` lists only renders whose
  review verdict is `pass` or `fixed`.
- A render with a `flagged` verdict or with no review file may appear only
  in an edition with status `draft`, built with `--draft`.
- Moving an edition to `published` is a human decision. An agent prepares
  the edition, reports its standing, and asks. It does not publish on its
  own authority (see `common/approval-policy.md`).
- A `fixed` verdict counts only when its findings carry recheck evidence
  against the render that ships. A fix verified on V02 says nothing about
  V03.

## Drafts

- A draft edition has `status: draft` and a `label` that says so ("review
  draft 2"). The build marks its exports: `-DRAFT` in every file name, a
  stamp on every PDF page, and a banner in the web reader.
- A draft may stop before the end of the issue. It may not skip a page in
  the middle.
- A draft is for reading and for collecting notes. It is not handed to a
  printer, uploaded to a platform, or sent out as the finished comic.
- Promoting a draft means changing its status after its pages qualify, then
  building again without `--draft`. Draft exports are not renamed into
  final ones.

## Corrected editions

- An edition that has left the team is never changed in place. A correction
  gets the next edition ID (`ED_001_02` after `ED_001_01`), with
  `supersedes` set to the edition it replaces.
- `changes` lists what differs, page by page: which render replaced which,
  and which finding or note prompted it ("PG_001_002: V02 replaces V01,
  Oskar's face corrected in panel 3").
- The superseded edition keeps its directory, its `edition.yaml`, and its
  exports.
- A new `label` distinguishes the editions for readers ("second edition",
  "corrected reading copy").

## Rejected versions stay on disk

- Renders that were rejected or superseded remain in `renders/` with their
  reviews and generation records. Assembly selects among them. It deletes
  nothing.
- No cleanup step removes old renders, old exports, or old editions as part
  of a build.
- When disk space forces an archive, a person moves whole editions or whole
  page directories out of the workspace and notes it in `project.yaml`.

## Describing an edition

- A delivery report lists the current page files by name, what was repaired,
  what was visually rechecked, and what still needs a decision.
- Mechanical validation and visual review are reported as two separate
  results (`common/visual-evidence.md`). A clean run of
  `scripts/validate-workspace.js` is never offered as evidence that the
  pages are right.
- NEVER describe a draft edition, a flagged page, or a page whose
  `human_approval` is `pending` as approved. Say "reviewed" for a `pass` or
  `fixed` verdict, and "approved" only when the review's `human_approval`
  says so.
- If any page of an edition carries an accepted minor finding, the report
  lists it.

## Validation

- `schemas/edition.schema.json` requires `id`, `issue`, `title`, `label`,
  `status`, `pages`, and `exports`, and restricts `status` to `draft`,
  `reviewed`, or `published`.
- `scripts/validate-workspace.js` fails an edition that lists a page twice,
  out of page-number order, or with a gap, an entry whose render belongs to
  another page or whose file is missing, and a non-draft edition that lists
  a render without a `pass` or `fixed` review. For a draft the last case is
  a warning.
- `scripts/build-edition.js` refuses to build when a listed render lacks a
  `pass` or `fixed` review, unless it is run with `--draft`, which marks
  every export as a draft.
- `hooks/validate-after-write.js` re-validates `edition.yaml` on write.
- `supersedes` and `changes` on a corrected edition, and the wording of
  delivery reports, are checked by production-qa and the editor-in-chief.
- Publishing is human review. The tooling verifies the bookkeeping around
  it.

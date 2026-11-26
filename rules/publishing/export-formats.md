# Export formats

## Purpose

Define what each deliverable is, what goes into it, and which part of the
work the scaffold does itself, so an export is repeatable and nobody
mistakes a reading copy for a print file.

## Scope

Publishing layer. Applies to `deliverables` in `project.yaml`, to the
`exports` list of every `edition.yaml`, and to the files under
`editions/<ED_ID>/exports/`. Used by `/build-edition`. Print geometry is in
`paged/print-specs.md`, and vertical-scroll delivery in
`webtoon/episode-deliverables.md`.

## Core Principles

- Every export is built from an edition. No file is assembled from a folder
  of loose images.
- An export is never overwritten. Changed content means a new edition and
  new files.
- One page size throughout. A reader should never see the page jump in
  proportion from one page to the next.
- The scaffold automates assembly. Pixel work on the art (rasterizing,
  cropping, color conversion) belongs to tools made for it, and the rule
  says which.

## Deliverables

`project.yaml` declares the planned targets in `deliverables[].target`.

| Target | What it is | Built by |
|---|---|---|
| `pdf` | Reading copy, one comic page per PDF page | `scripts/build-edition.js` |
| `cbz` | Comic archive for reader apps | `scripts/build-edition.js` |
| `web` | Self-contained web reader | `scripts/build-edition.js` |
| `images` | One numbered image per page, as a folder and a zip | `scripts/build-edition.js` |
| `epub` | EPUB 3 with a fixed layout, one image per page | `scripts/build-edition.js` |
| `social-carousel` | Crops of pages or panels for social feeds | External image tool, from the edition's renders |
| `print` | Press-ready files to a printer's specification | External prepress tool, from the edition's renders |

- An edition's `exports` list records each file the build produced, with
  its `format` (`pdf`, `cbz`, `web`, `images`, or `epub`) and its `built_at`
  time. For the web reader the recorded file is its `index.html`, and for
  the images it is the zip.
- Without `--formats`, the build produces the `pdf`, `cbz`, `web`, `images`,
  and `epub` targets the project declares, and `pdf` and `cbz` when it
  declares none.
- Deliverables are declared before pages are planned, because they set the
  page ratio, the lettering size, and the safe margins.
- A target that the project does not declare is not built on speculation.

## PDF

- Pages appear in the edition's order, one per PDF page, all at the same
  page size. In a paged project with `page.trim_mm` set, the PDF page takes
  the trim size.
- The PDF from `build-edition.js` is a reading copy. It carries no bleed, no
  crop marks, and no color conversion, and it MUST NOT be sent to a printer
  as press-ready.
- A draft build stamps every page of the PDF, adds `-DRAFT` to every export
  name, and shows a banner in the web reader.
- In overlay lettering mode the build ships each entry's `lettered_file`,
  which has to be a PNG or JPEG. The SVG overlay is exported to an image
  first (see "What is left to external tools" below).

## CBZ

- A CBZ is a zip archive of the page images plus a `ComicInfo.xml` file at
  its root.
- Page files are named so that alphabetical order equals reading order:
  zero-padded page numbers of equal width, starting at the first page, with
  no gaps (`001.png`, `002.png`). Reader apps sort by name and ignore any
  other ordering.
- `ComicInfo.xml` carries at least the series title, the issue number and
  title, the page count, and the language from `project.yaml`. For
  `reading_direction: rtl` it declares right-to-left reading, so reader
  apps turn pages the right way.
- Images go into the archive as they are. Recompressing them is not part
  of the build.

## Web reader

- The web export is a static reader that opens from disk with no server and
  no network requests.
- A paged project shows one page at a time in reading order, honoring
  `reading_direction`. A webtoon project shows the segments as one
  continuous vertical strip.
- The reader presents the edition's renders as they are. It does not
  rescale them into different proportions or add content of its own.

## Images and EPUB

- The `images` export is the pages as loose files: a folder
  `<base name>-images/` and a zip `<base name>-images.zip` holding the same
  files. Names follow the CBZ rule, so alphabetical order is reading order.
  Each image is the listed render as it is, or the entry's `lettered_file`.
- The `epub` export is an EPUB 3 with a fixed layout: one image per page,
  each on its own page document with a viewport of the image's pixel size.
  The package declares `rendition:layout` as `pre-paginated` and the page
  progression from `reading_direction`, and it carries a navigation
  document.
- The `mimetype` entry is the first file of the EPUB archive and is stored
  uncompressed. Images are stored as they are.
- A draft EPUB says so in its title and shows a banner on every page.

## Cover

- An edition may name a cover render under `cover:`. When it does, the
  cover is the first page of every export. It is `000-cover.<ext>` in the
  CBZ, the web reader, the images, and the EPUB, so it sorts before page
  `001`.
- `ComicInfo.xml` marks that page as `FrontCover`, and the EPUB marks its
  image as `cover-image`.
- The cover passes the same review gate as a page. In a paged project it
  also joins the aspect-ratio comparison. A webtoon cover is not a scroll
  segment and is left out of the width comparison.
- An edition without `cover:` exports the pages alone, numbered from `001`.

## Social carousel and print

- A carousel is a selection made by a person or by the editor-in-chief: which
  pages or panels, in which order. Default limits to plan against: square
  (`1:1`) or `4:5` slides at 1080 px wide, and no more than ten slides.
  Check the platform's current specification before cropping.
- Slides keep the reading order of the source pages. A crop never cuts
  through a balloon or leaves a line without its speaker.
- Carousel slides and print files are derived from the renders of one named
  edition. The edition's `notes` record which.
- Print files follow `paged/print-specs.md`. Bleed, crop marks, color
  conversion, and imposition are prepress work.

## Exports never overwrite

- `build-edition.js` skips an export file that already exists and says so.
  File names are
  `<title-slug>-<issue number>-ed<edition number>[-DRAFT].<ext>`
  (`the-night-ferry-001-ed01.cbz` for `ED_001_01`), and the web reader is a
  directory with the same base name and a `-web` suffix
  (`the-night-ferry-001-ed01-web/`). The slug comes from the project title.
  Two editions never compete for a name.
- When pages change, create the next edition (`edition-assembly.md`) and
  build that. Do not rebuild an existing edition with different renders.
- `--force` exists for rebuilding the exports of a `draft` edition after a
  failed or interrupted build, and for rebuilding `-DRAFT` files with
  `--draft`. On an edition with status `reviewed` or `published` the script
  refuses it with the error `force-not-draft` and writes nothing. That
  edition is corrected with a new edition ID that sets `supersedes` and
  `changes`.
- Files that left the workspace (sent to a reader, uploaded, printed) are
  identified by edition ID in any later conversation about them.

## Consistent page geometry

- Every page render in an edition has the project's `page.aspect_ratio` and
  the same pixel size. A page that came back at another size is regenerated
  or repaired before it enters an edition. In a paged project the build
  tolerates a difference of up to 2% between pages with a warning and stops
  beyond that.
- The two halves of a double-page spread are two pages of the normal size
  (see `paged/page-turn-grammar.md`).
- Webtoon segments share one width. Their delivery slicing follows
  `webtoon/episode-deliverables.md`.
- NEVER pad, stretch, or letterbox a page inside an export to hide a size
  mismatch.

## What is left to external tools

| Task | Why it is external | Tool |
|---|---|---|
| Flattening `<RENDER_ID>.lettered.svg` to a raster image | The scripts have no rasterizer | A browser or a vector editor |
| Cropping and resizing carousel slides | The scripts do not edit pixels | Any image editor |
| Press-ready PDF with bleed and marks, color conversion, imposition | Printer-specific prepress | A layout or prepress application |
| Slicing webtoon segments to platform sizes | Platform-specific | An image editor or the platform's uploader |
| Uploading and distribution | Outside the workspace | The platform |

Every file produced this way is saved beside the edition's exports and
named with the edition ID. The prepress-specialist records the tool and the
settings in the edition's `notes`.

## Validation

- `schemas/project.schema.json` restricts `deliverables[].target` to the
  targets in the table above, and `schemas/edition.schema.json` restricts an
  export's `format` to `pdf`, `cbz`, `web`, `images`, or `epub`.
- `scripts/build-edition.js` builds only from an `edition.yaml`, applies the
  review gate of `edition-assembly.md`, and skips an existing export unless
  `--force` is passed. It refuses `--force` on an edition whose status is
  not `draft` (`force-not-draft`), unless the build is `--draft`. In a paged
  project it compares the aspect ratio of the listed pages and stops when
  they differ by more than 2%. In a webtoon project it compares widths and
  warns. It rejects an SVG listed as `lettered_file`, and a WebP page when
  `pdf` is among the formats.
- `hooks/protect-approved-assets.js` blocks a direct write over an existing
  file under `editions/*/exports/`.
- `scripts/validate-workspace.js` checks that every file an edition lists
  for its pages and its cover exists on disk.
- A `--force` rebuild of a draft leaves no mark beyond a newer `built_at`
  on the export. Production-qa reads the `built_at` times at release review
  and confirms the exports were built after the last change to the page
  list.
- The order of pages in a reader app, the look of the web reader, and the
  state of anything made with an external tool are checked by opening the
  export. The prepress-specialist does this for every format before an
  edition is reported as built.

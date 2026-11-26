# Naming conventions

## Purpose

Pin the single ID scheme every artifact uses, so references between issues,
pages, panels, assets, renders, and reviews resolve without ambiguity and
scripts can read identity from a name alone.

## Scope

All layers. Governs every ID and filename created inside a workspace and
every cross-reference inside structured files.

## Core Principles

- IDs are UPPERCASE with underscores. Filenames are lowercase-kebab or the ID
  itself. Nothing else.
- An ID, once assigned, is permanent. NEVER renumber or reuse an ID, even for
  a deleted entity. Gaps are fine.
- Every cross-reference uses the full ID, never a display name or nickname.
- A child ID carries its parents' numbers, so `PN_001_004_03` can be read
  without opening a file: issue 001, page 004, panel 03.

## ID scheme

- Issues: `ISS_###` (`ISS_001`). The issue is the publication unit. A chapter
  or a webtoon episode is an issue.
- Scenes: `SC_<issue>_##` (`SC_001_02`), numbered within the issue.
- Beats: `BT_<issue>_<scene>_##` (`BT_001_02_01`), ordered within the scene.
- Pages: `PG_<issue>_###` (`PG_001_004`). In `webtoon` format a page is one
  scroll segment. Reading order comes from the page's `number` field and the
  `continuity` chain, so a page inserted late takes the next free ID.
- Panels: `PN_<issue>_<page>_##` (`PN_001_004_03`). Reading position comes
  from the panel's `order` field.
- Lettering elements: `L##` (`L01`), unique within a page.
- Renders: `<PAGE_ID>_V##` (`PG_001_004_V02`). A render is one candidate
  image of a page. A repair always takes the next version number, and earlier
  files stay on disk.
- Entities: `CHAR_*` characters, `LOC_*` locations, `PROP_*` props, `LOOK_*`
  style assets. The name part is uppercase letters, digits, and underscores,
  starting with a letter (`CHAR_MARA`, `LOC_FERRY_DECK`).
- Assets: the entity ID, a short kind, and a version `_V##`
  (`CHAR_MARA_TURN_V01`). The kind tags the scripts write are `TURN`,
  `EXPR`, `WARD`, `PLATE`, `PROP`, and `DETAIL`; a look page has none
  (`LOOK_NOIR_INK_V01`). Approved masters carry `_MASTER` before the
  version: `CHAR_MARA_TURN_MASTER_V02`. A generated candidate never takes
  the `_MASTER` name; it gets one when it is approved. The entity of an
  asset is its leading entity ID, and `references/manifest.yaml` states it
  explicitly.
- Wardrobe states: `WARD_<CHARACTER>_<NAME>` (`WARD_MARA_OILSKIN`).
- Canon facts: `FACT_###` (`FACT_001`), numbered in the story bible.
- Prompt packages: `PP_<page-or-entity-id>_<PROVIDER>`, with the provider ID
  in uppercase (`PP_PG_001_001_HARNESS-NATIVE`). A per-panel package adds
  `-P##` (`PP_PG_001_002_FAL-P03`), and a reference-sheet package adds the
  kind tag (`PP_CHAR_MARA_FAL-TURN`).
- Generation records: `GEN_<page-id>_<attempt##>` for pages
  (`GEN_PG_001_001_01`) or `GEN_<entity-id>_<attempt##>` for reference art
  (`GEN_CHAR_MARA_01`). Attempt numbers are two digits, sequential per page
  or entity, never reused.
- Review findings: `F##` (`F01`), unique within a review file.
- Editions: `ED_<issue>_##` (`ED_001_03`). A rebuilt edition gets the next
  number.

Namespaces are exclusive. `LOOK_*` belongs to the comic's visual language
only. Anything a character wears is a `WARD_*` state in that character's
`wardrobe.yaml`, never a `LOOK_*` asset: the prefix decides which role a
reference plays when it is attached to a request.

## Lowercase identifiers

- Map levels, landmarks, and exits (`deck`, `wheelhouse`, `crates`,
  `ladder`) and persistent state tags (`soaked`, `cut_left_hand`) are
  lowercase with underscores, starting with a letter.
- Provider IDs are lowercase with hyphens (`harness-native`, `comfyui`).
- State tags are part of the continuity record. Once a tag is in use, keep
  its spelling: `cut_left_hand` and `left_hand_cut` are two different tags to
  the ledger audit.

## File naming

- Structured data is YAML. Human documents are Markdown. The frozen style
  block is plain text (`style/style-block.txt`).
- Entity directories are named by ID. Fixed per-entity files keep their
  conventional lowercase names: `character.yaml`, `wardrobe.yaml`,
  `location.yaml`, `map.yaml`, `prop.yaml`.
- Issue and page directories are named by ID and hold `issue.yaml` and
  `page.yaml`. A scene file is its ID: `scenes/SC_001_01.yaml`.
- Files named after an artifact use the ID verbatim: `PG_001_002_V02.png`,
  `GEN_PG_001_002_02.yaml`, `CHAR_MARA_TURN_MASTER_V01.png`. The request
  file beside a generation record is `GEN_PG_001_002_02.request.json`.
- A review is `<RENDER_ID>.review.yaml`. A lettered overlay is
  `<RENDER_ID>.lettered.svg`. An end-of-issue state is
  `<ISS_ID>.final-state.yaml`.
- A prompt package file is named after its provider: `prompts/fal.yaml`.
  A per-panel package adds the panel ID (`prompts/fal.PN_001_002_03.yaml`),
  a sheet package the sheet kind (`refs/prompts/fal.turnaround.yaml`), and
  a look package the look ID
  (`references/style/prompts/fal.LOOK_NOIR_INK.yaml`). A wardrobe package
  adds the outfit ID (`fal.wardrobe.WARD_MARA_OILSKIN.yaml`), a detail
  package a lowercase-kebab slug of its subject
  (`fal.detail.torn-left-cuff.yaml`), and a plate for a non-default time
  of day that state (`fal.plate.dusk.yaml`).
- Everything else is lowercase-kebab (`reference-plan.yaml`,
  `story-bible.yaml`, `series-plan.yaml`). NEVER use spaces, camelCase, or
  non-ASCII characters in a filename.

## Validation

- The schemas in `schemas/` regex-check every ID field against the patterns
  listed in `docs/data-model.md`.
- `scripts/validate-workspace.js` runs those schemas, checks that the ID
  inside a file matches its path, and rejects a page, reference plan, or
  page prompt package that cites an unregistered asset or a render that is
  not on disk. In `references/manifest.yaml` it rejects a repeated asset ID
  and an `entity` that is not the prefix of the asset ID.
- `scripts/check-continuity.js` fails when a page names a character, prop,
  location, wardrobe state, level, or landmark that does not exist in the
  workspace (ledger rule 11).
- `hooks/validate-after-write.js` applies the schema patterns on write.
- Renaming an existing ID requires human review. Validation treats the old
  references as broken.

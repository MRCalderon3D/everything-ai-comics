---
description: "Generate and iterate the master references: character sheets, location plates, and look pages."
---

# /visual-development

## Purpose

Produce the reference images every page conditions on: the look page that
fixes the drawing style, the character sheets that fix identity, the
location plates, and the prop references. Each candidate is generated from
the bibles, opened, checked against them, and offered to the user. An
approved image becomes a master, is registered in the reference manifest
with one default role, and from then on outranks any prompt.

## Use When

- The bibles are in `review` or `approved` and list planned sheets that do
  not exist yet.
- A bible changed and a master no longer matches it. The new sheet is a new
  version; the old one is marked `superseded`.
- A review traced an identity failure to a missing reference, such as a
  secondary character who never got a sheet.

## Inputs

- `target` (ID, optional): a single `CHAR_*`, `LOC_*`, `PROP_*`, or `LOOK_*`;
  default is every entity with planned sheets that are not registered.
- `provider` (string, optional, default `default_providers.image` in
  `project.yaml`): an ID from `manifests/image-providers.json`.
- `variants` (int, optional, default 2): candidates per sheet.
- `--live` (flag, optional, default off): call the provider. Without it the
  run is a dry run.

## Invokes Agents

- art-director
- character-designer
- environment-designer

## Required Skills

- visual-style-development
- character-sheet-generation
- location-design

## Process

1. Collect the planned sheets from the bibles and order them. The look page
   comes first, because every other sheet is drawn in that style. Then each
   character's turnaround, then the expression and wardrobe sheets that
   condition on the approved turnaround, then location plates and props. A
   sheet whose parent is not `approved` is blocked. On a "next" from the
   user with a parent still in review, state the blocker and ask for the
   verdict.
2. Design each sheet for reading, in the comic's own drawing style: faces
   clear, background plain, scale consistent between views. Keep dramatic
   lighting for the pages. A recurring secondary character gets at least an
   identity strip. For characters listed in each other's
   `visually_adjacent_to`, state the difference in the prompt of both
   sheets.
3. Write one asset-scoped prompt package per sheet (`page: null`, `asset`
   set to the entity ID) from the bible fields, the frozen style block, and,
   once it exists, the look master as a `style` reference. Nothing is
   written freehand. Save it beside the sheets in the entity's `refs/`
   directory.
4. Cost gate: estimate the batch (sheets x variants x provider rate), show
   it, and wait for an explicit confirmation. Run `node
   scripts/generate-assets.js --package <prompt-package.yaml> --provider
   <id>` for the dry run, and add `--live --yes` only after the user
   confirms. The hook `require-cost-confirmation.js` blocks a live call
   without it.
5. Save each returned image under the entity's `refs/` (the look under
   `production/references/style/`) with a versioned ID. Complete its
   generation record. When the tool does not report the model, the cost, or
   the seed, write `unreported` or `null` and list the field in
   `metadata_unavailable`.
6. Open every returned file. The owning designer compares it with the bible:
   each entry of `distinguishing_features`, the wardrobe layers, the map's
   levels and landmarks, the style bible's statements. Pick one candidate
   per sheet or order a re-roll with corrected wording. After the project's
   `repair_policy.max_cycles` rounds without a usable candidate, fix the
   bible text instead of rolling again.
7. Name the pick `<ENTITY>_<KIND>_MASTER_V##` and register it in
   `production/references/manifest.yaml`: `id`, `entity`, `kind`, `path`,
   `status: review`, `sha256`, and a single `default_role` (`identity` for
   a turnaround, `style` for a look page, `spatial_continuity` for a plate,
   `prop_consistency` for a prop, `wardrobe` for a wardrobe sheet).
8. Hand each image to the user with a review card: what the asset is, the
   features to verify taken from the bible, anything this image cannot show,
   and what approving it allows next. On approval set `status: approved` with
   `approved_by` and `approved_at`, add the asset ID to the entity file's
   `references`, and add an approved look master to `style.look_refs` in
   `project.yaml`. Then move to the next planned sheet without waiting to be
   asked.
9. Run `node scripts/validate-workspace.js --root production`, then the
   self-evaluation gates on the manifest entries and generation records.
   Report sheets approved, sheets waiting for a verdict, and spend against
   the estimate.

## Outputs

- `production/characters/<CHAR_ID>/refs/`, `production/locations/<LOC_ID>/refs/`,
  `production/props/<PROP_ID>/refs/`, and `production/references/style/`:
  candidate and master images with their prompt packages
  (`schemas/prompt-package.schema.json`).
- `production/references/manifest.yaml`, the registry with the new entries
  (no schema as a whole).
- `production/generations/<ASSET_ID>/GEN_<asset-id>_<attempt##>.yaml`, one
  per attempt; validates against `schemas/generation-record.schema.json`.
- `references` updated in the entity files, `style.look_refs` in
  `production/project.yaml`.

## Notes

- Cost warning: this is the first command that can spend money. Dry run is
  the default and a live batch always shows its estimate first. Cut
  `variants` before cutting sheets.
- An approved master is immutable. The hook `protect-approved-assets.js`
  refuses edits to it. A change is a new `_V##`, a new manifest entry, and
  `status: superseded` on the old one.
- A photograph or an outside drawing brought in through `/ingest-references`
  can condition a sheet. It does not replace the sheet: identity masters are
  drawn in the comic's style.
- With `harness-native` or `manual` the script writes a handoff package and
  calls no network. The harness image tool or a person produces the image,
  and steps 5 to 8 apply to the file that comes back.
- Related: `/character-bible`, `/location-bible`, `/prop-bible`,
  `/style-bible` (plan the sheets), `/reference-plan` (assigns approved
  masters to pages).

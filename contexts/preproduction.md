# Context: Preproduction

The design phase. Words become a visual system: a bible entry for every
character, location, and prop, one frozen style, and approved master
references for all of them. Most identity and geography failures are
prevented here, where a fix costs an edit to a YAML file.

## Goals

- `characters/<CHAR_ID>/character.yaml` and `wardrobe.yaml` for every
  recurring character, secondary ones included, with
  `distinguishing_features` and `visually_adjacent_to` filled in.
- `locations/<LOC_ID>/location.yaml` and `map.yaml` with levels, a side
  convention, landmarks, exits, and connections.
- `props/<PROP_ID>/prop.yaml` for every plot-relevant prop, with
  `hands_required`.
- `style/style-bible.md`, the frozen `style/style-block.txt`, and
  `style/color-script.md`.
- Approved `_MASTER` assets registered in `references/manifest.yaml`: a look
  master, a sheet per character, a plate per location.

## In scope

- Bible authoring and the cast lineup test: no two characters who could be
  mistaken for each other at panel size.
- Reference sheets in the comic's drawing style, on plain backgrounds with
  readable faces. Scene lighting waits for the pages.
- Ingesting user-supplied references from `references/inbox/` and recording
  what each one controls: identity, style, or wardrobe.
- Master generation through image providers, with dry-run first and a cost
  confirmation before a live batch.
- Lettering decisions that belong to the style: mode, font, case, word limits.

## Defer

- Page layouts, panel scripts, and the ledger. They need the maps and
  wardrobe IDs this phase produces.
- Page generation. A master is a reference, and no page is rendered until
  its plan exists.
- Canon changes. A new fact or a user change goes back through development.

## Typically active

- Commands: `/character-bible`, `/location-bible`, `/prop-bible`,
  `/style-bible`, `/visual-development`, `/ingest-references`.
- Agents: art-director, colorist, letterer, character-designer,
  environment-designer, continuity-editor (prop custody rules),
  image-generation-specialist (master generation).
- Rule layers: `common/` (asset-provenance, approval-policy, cost-control),
  `visual/` (character-consistency, location-consistency, visual-language),
  `image/` (image-generation, reference-roles), and `lettering/` for the
  style decisions. From the format layer, read `paged/print-specs` or
  `webtoon/episode-deliverables` before fixing page size and aspect ratio.

## Exit criteria → production

- Every entity the first issue needs has an `approved` bible entry and an
  approved master listed in `references/manifest.yaml`.
- The style block is frozen and `project.yaml` points at it and at the look
  master.
- Every pair of adjacent characters has a stated visible difference.
- `scripts/validate-workspace.js` is clean on the bibles and the registry.
- A human has approved the masters. Approved assets are immutable from here;
  a change is a new `_V##`.

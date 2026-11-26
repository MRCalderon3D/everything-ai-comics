---
name: character-sheet-generation
description: Produce reference sheets (turnarounds, expressions, wardrobe) that become approved identity masters.
origin: everything-ai-comics
category: visual
---

# Character Sheet Generation

## Purpose

Turn a locked character identity into reference sheets drawn in the comic's
own style. Pages attach these sheets as identity references, so each page
request points at the same drawing of the character and does not have to
describe them again from text.

## Use When

- A character file is ready and has no visual masters yet.
- A new outfit or a new identity version needs its own sheet.
- An existing sheet is too weak to hold identity: face in shadow, one view
  only, wrong drawing style.
- A recurring secondary character has started to change between pages.

## Inputs

- `production/characters/<CHAR_ID>/character.yaml` and `wardrobe.yaml`.
- The approved look master (`project.style.look_refs`) and
  `production/style/style-block.txt`.
- Identity photographs or costume references the user supplied, already
  registered by `reference-ingestion`.
- Provider capabilities from `manifests/image-providers.json`.

## Process

1. Check the preconditions. The character file has distinguishing features
   and an adjacency list, and a look master is approved. Without an approved
   look there is no style to draw the sheet in; stop and finish the look
   first.
2. Plan the set by role. A protagonist or antagonist gets a turnaround
   (front, three-quarter, profile, back, full figure), an expression sheet
   with the five or six expressions the script calls for, and one wardrobe
   sheet per outfit beyond the default. A recurring secondary character gets
   at least a small identity strip: front and three-quarter heads and one
   full figure. Background characters get nothing.
3. Write an asset-scoped prompt package (`page: null`, `asset: <CHAR_ID>`,
   id `PP_<asset-id>_<PROVIDER>`) and save it beside the sheets in the
   character's `refs/` directory. Its text comes from `prompt_summary`,
   `distinguishing_features`, and the outfit `description`, followed by the
   style block verbatim. Attach the look master with role `style`. Attach
   an identity photograph, if there is one, with role `identity`.
4. Ask for sheet conditions and nothing else: plain light background, even
   light, no cast shadow across the face, neutral stance, every figure at
   the same scale with feet on one baseline, heads the same size across an
   expression sheet. Dramatic lighting belongs on the pages. A sheet lit
   like a scene hides the features and teaches every later page the same
   shadow.
5. Dry-run first:
   `node scripts/generate-assets.js --package <prompt-package.yaml>`. Read
   the request it would send, confirm the cost, then repeat with
   `--live --yes`.
6. Open every returned file. Check that it is a drawing in the look's
   style: same line, same black placement, same degree of simplification as
   the look master. A grayscale portrait is not a stylized drawing, however
   good the likeness, and is rejected. The identity anchors have to survive
   the simplification.
7. Check agreement across views. The face at three-quarter and in profile
   is the same person as the front view. Sided features sit on the correct
   side in every view. Hands, cuffs, and accessories match the outfit.
8. Put the sheet next to the sheets of every character in
   `visually_adjacent_to`. Shrunk to panel size, the two must still be
   told apart at a glance. If they cannot, the design goes back to
   `character-consistency`.
9. Save candidates as `CHAR_<NAME>_<KIND>_V##` under
   `production/characters/<CHAR_ID>/refs/`. The selected one is saved as
   `CHAR_<NAME>_<KIND>_MASTER_V##` (for example `CHAR_MARA_TURN_MASTER_V01`)
   and registered in `production/references/manifest.yaml` with `entity`,
   `kind`, `path`, `status: review`, and `default_role` (`identity`, or
   `wardrobe` for an outfit sheet). Each generated file has its generation
   record under `production/generations/<ASSET_ID>/`.
10. Record approval per reference. The user approves each sheet
    individually; write `status: approved`, `approved_by`, and
    `approved_at`, then add the asset ID to `character.references` and to
    the outfit's `references`. Reuse approvals that exist and ask only about
    sheets that are new.
11. Correct a sheet by making the next version. The old asset becomes
    `superseded` and its file stays on disk.

## Outputs

- Sheet images under `production/characters/<CHAR_ID>/refs/`.
- Registry entries in `production/references/manifest.yaml`, with status and
  approval per asset.
- One generation record per image (`generation-record` schema).
- Updated `references` lists in `character.yaml` and `wardrobe.yaml`.

## Quality Bar

- Every sheet is drawn in the look master's style; none is a photograph or
  a grayscale render.
- The face is readable and the same person in every view and expression.
- Plain background, even light, consistent scale.
- Every outfit in `wardrobe.yaml` that appears on a page has a sheet or is
  covered by the turnaround.
- Every recurring secondary character has at least an identity strip.
- Every sheet has a registry entry, a status, and a generation record.
  Reference plans cite only assets with `status: approved`.

## Common Failure Modes

- Scene lighting on a sheet. Half the face is black, and every page that
  attaches it inherits a character with half a face.
- A photoreal or grayscale portrait accepted as the master. Pages then
  drift toward photographic rendering around that one character.
- A strong front view whose profile belongs to someone else.
- Mirrored anchors: the torn cuff on the left arm in one view and the right
  in the next.
- Expression sheets where each face changes proportions, so the "angry"
  head is effectively a second character.
- Regenerating the whole set when one view failed.
- No sheet for the deckhand who appears on six pages, because he is "only
  secondary".
- Citing a draft sheet from a reference plan before anyone approved it.

## Related Agents

- character-designer
- art-director

## Related Commands

- character-bible
- visual-development

## Notes

Generation itself follows `image-generation`: dry run, cost confirmation,
one record per file. Replacing a master means rechecking every reference
plan and prompt package that cited the old version. Approval rules are in
`rules/common/approval-policy.md`.

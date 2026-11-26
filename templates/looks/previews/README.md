# templates/looks/previews/

Sample pages for the look presets, one image per preset. They let a person
see a style before choosing it, and they let you compare looks side by side
because every sample shows the same page.

No sample has been drawn yet. This folder holds only the test scene and
this README until they are.

## What goes here

- One PNG per preset, named after the preset file:
  `<preset file stem>.png`, for example `noir-ink.png` for `noir-ink.yaml`.
- Every image draws the page in [scene.md](scene.md): one portrait page,
  three panels, the same character, place, prop, caption, and balloon.
- Drawn with the `codex-cli` image provider
  (`providers/image/codex-cli.js`), in its 2:3 frame.
- The prompt is the preset's `style_block` as it stands in the YAML file,
  followed by the scene. Nothing else is added for one preset and not the
  others.
- A preset added later gets its sample in the same change, drawn the same
  way.

A sample shows what the look can produce. It is not an approved look master
and nothing in a workspace points at it. A production still freezes its own
block and approves its own look page.

## Drawing a sample

1. Build the prompt from the preset's `style_block` and the text of
   `scene.md` below it.
2. Draw it twice with `codex-cli`. Compare the two against the preset's
   `drift_risks` and against each other. If they differ in the ways the
   preset lists, note it; if they differ in a way it does not list, add
   that to `drift_risks`.
3. Look at the better of the two against `scene.md`: the exact caption and
   balloon text, no extra text, the character's fixed features, the box in
   all three panels, hands drawn whole. Draw again if it fails. A script
   cannot make this call.
4. Save it here as `<preset file stem>.png` and add its row to the table
   below.

## Provenance

One row per file. Codex does not report a seed, and it names its image model
only sometimes, so those columns say `not reported` when it gives nothing.

| File | Preset ID | Provider | Model | Drawn on | Attempts | Reviewed by | Notes |
|---|---|---|---|---|---|---|---|

Columns:

- File: the PNG in this folder.
- Preset ID: the `id` of the preset at the time of drawing, for example
  `LOOK_NOIR_INK_V01`. When a preset's style block changes, its sample is
  drawn again.
- Provider: `codex-cli`.
- Model: the model Codex reported for the session or the image, or
  `not reported`.
- Drawn on: the date, as YYYY-MM-DD.
- Attempts: how many images were drawn before this one was kept.
- Reviewed by: who looked at it against `scene.md`.
- Notes: drifts seen between the two draws, and anything in the image that
  departs from the scene.

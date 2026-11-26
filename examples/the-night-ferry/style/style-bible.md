# Style bible: The Night Ferry

Status: approved
Look master: `LOOK_NOIR_INK_MASTER_V01`

## The look in one paragraph

Black ink on white paper and nothing between them. Night is solid black, and
the river, the deck, and the sky merge into it. Light is whatever the ink
leaves alone: one lamp in the wheelhouse, the moon on wet steel, and later a
searchlight. A page should read as black shapes at arm's length before any
face or prop can be made out.

## Line and inking

- Tool and line weight: brush for contours and fills, nib for faces and hands.
- Line variation: heavy, swelling and thinning. A contour stops where the form goes into shadow.
- Hatching: none used as grey. A few dry-brush strokes on wet steel and canvas.
- Solid blacks: about half of every panel. They describe night, water, and the shadow side of figures.

## Tone and texture

- No screentone, no wash, no gradient.
- Texture comes from dry brush on the deck plating and the tarpaulin.

## Color

- Color mode: `monochrome`.
- One spot color, signal red `#C0392B`, reserved for the light of a fired flare. No flare is fired in ISS_001, so both pages are pure black and white.

## Characters

- Faces are planes of light and shadow. Mara's broken nose and Oskar's round face must survive even when the eyes are lost in black.
- Mara and Oskar are told apart by silhouette first: a tall bare-headed figure in a long coat, and a small hooded one.
- Hands stay fully drawn. The story turns on what Mara holds.

## Environments

- The ferry is drawn with measured perspective in the wide panels and reduced to edges and reflections in the close ones.
- The bow is always screen left and the wheelhouse always screen right.
- The far bank never shows a light.

## Panels and gutters

- Even black borders, square corners, white gutters.
- No bleeds, no insets, no broken borders in ISS_001.

## Lettering

- Upper case, hand-lettered look, set by the image generator (`in_image` mode).
- White balloons with a thin black outline. Whispers use a dashed outline.
- White caption boxes with black text.
- Sound effects are heavy black letters drawn into the art, sitting on the thing that makes the sound.

## Never

- Grey of any kind: wash, gradient, soft shadow, screentone.
- Color other than the flare red, and that only when a flare has been fired.
- A lit window or lamp on the far bank.
- Mara with a hat or a hood. Oskar with his hood down.

## Frozen style block

Copy of `style-block.txt`. The file is the source.

```text
Black-and-white comic book page in a high-contrast ink noir style.
Line: brush and nib inking, heavy variable-weight contours that vanish where forms fall into shadow.
Blacks and shadow: large areas of solid spotted black; shadows drawn as flat black shapes with hard edges.
Tone: no grey tones, no gradients, no screentone; texture only from sparse dry-brush strokes.
Color: pure black ink on white paper.
Rendering: faces simplified into planes of light and shadow, light described by untouched white paper, silhouettes that read at thumbnail size.
Panels: clean black borders of even weight, white gutters.
Lettering: hand-lettered upper-case text in white balloons with a thin black outline, white caption boxes, sound effects as heavy black letters inside the art.
```

## References

| Asset ID | Role | What it fixes |
|---|---|---|
| `LOOK_NOIR_INK_MASTER_V01` | style | Line weight, amount of black, hard shadow edges. Attached to every request. |

## Change log

| Date | Change | Reason | New look master |
|---|---|---|---|
| 2026-11-26 | First version, built from the `noir-ink` preset. | Start of production. | `LOOK_NOIR_INK_MASTER_V01` |

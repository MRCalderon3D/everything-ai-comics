---
name: performance-direction
description: Direct character acting as visible, drawable behavior instead of emotion labels.
origin: everything-ai-comics
category: production
---

# Performance Direction

## Purpose

Fill the gap between a beat's emotion and the drawn figure: decide what each
character is visibly doing, and write that into the panel in place of the
emotion word. Image models overact by default. Ask for "terrified" and the
result is the stock scream, mouth wide and eyes bulging. A comic panel is one
frozen instant, so the acting has to live in a posture, a pair of hands, and a
look that a penciller could draw. The reader supplies the feeling from the
context and from the panels on either side. Direct the verb and leave the
adjective out.

## Use When

- `/panel-script` or `/smart-page` writes the cast rows of a panel. Every
  drawn character gets an `action` and an `acting` line.
- A thumbnail needs body-language notes.
- A rendered page reads overacted, blank, or emotionally disconnected from
  the panels beside it.

## Inputs

- The beat in the scene file and the panel's `moment` in `page.yaml`.
- `character.yaml`: `personality`, `voice`, `arc`, and the build the body has
  to act with.
- The panel's `framing.shot_size`, which decides where the acting can be
  seen.
- The `acting` and `state` of the same character in the neighboring panels.
- The panel's `lettering`, because the words already carry part of the
  performance.

## Process

1. Turn the emotion into a playable action: what is the character doing, to
   get what, against what resistance? "Afraid" cannot be drawn. "Holds her
   breath and listens toward the crates, one hand still on the wheel" can.
   Result direction ("looks sadder") is banned in page files and in prompts.
2. Pick the instant. A panel shows one position of the body, so choose the
   point of the gesture that reads best: usually the moment just before
   contact or the furthest reach of the movement. A hand halfway to the flare
   gun says more than a hand already holding it.
3. Put the acting where the framing can show it. In `extreme_wide`, `wide`,
   and `full` panels the posture acts: weight back, shoulders in, distance
   kept from another figure. In `medium_wide` and `medium` panels the hands
   act: white knuckles, a cuff tugged down over a cut. In `medium_close_up`
   and closer the eyes act and the mouth stays nearly still. Detail written
   for a close view is wasted in a wide one.
4. Set the intensity on purpose and say it in the `acting` line: suppressed
   (fighting not to show it), contained (visible and held, the default), open
   (fully expressed), or extreme (once per issue, if at all). Models render
   one notch hotter than asked. Write contained to get believable fear, and
   treat extreme in a prompt as a request for caricature.
5. Keep the throughline. A character's state moves from panel to panel the
   way positions do. Nobody goes from panic to calm across a gutter unless a
   panel or a labelled `ellipsis` resets them. For each panel, check the
   state the character inherits from the last appearance and the state handed
   to the next.
6. Let context act. A contained face beside the thing the reader fears reads
   as dread. A `subject` transition to shaking hands is louder than a
   grimace. When a face will not come out right, move the performance to the
   body, to an `insert`, or to the next panel.
7. Split the work with the lettering. If the balloon says it, the face does
   not have to repeat it. A silent panel puts the whole load on the body,
   so give it a specific action.
8. Give background figures one behavior each. They need a single verb (coils
   a rope, keeps watch astern) and no inner life.
9. Write `action` as the visible deed and `acting` as how the body does it:
   "Shoulders loose, eyes ahead." Both fields describe things on the surface
   of the drawing. Psychological narration ("she feels dread") stays out,
   because `prompt-compilation` copies these lines into the request.

## Outputs

- `action` and `acting` on every cast row of the page's panels
  (`page.schema.json`).
- Body-language notes for thumbnails.
- Notes to `sequential-storytelling` when an emotional change needs a panel
  of its own.

## Quality Bar

- Every `action` and `acting` line describes something a penciller could
  draw. No emotion adjectives and no interior states.
- Intensity is contained or lower unless the panel's `notes` argue for more.
  Extreme appears at most once per issue.
- The detail matches the framing: eyes in close panels, posture in wide ones.
- A character's acting in consecutive appearances connects without an
  unexplained jump.
- No two characters in a panel have the same acting line.

## Common Failure Modes

- Result direction: "looks scared" compiles into the stock scream.
- Emotion-word prompts ("terrified boy"). The model's overacting started in
  the page file.
- Eye detail written for a wide panel where the face is a dot, and nothing
  left to say when the close-up comes.
- Panic in one panel and serenity in the next, with no beat between.
- Every figure in a crowd directed in full, so the eye has no actor to find.
- The face repeating the balloon: a shouted line, a shouting mouth, and
  speed lines, all saying one thing.
- A wounded character acting healthy because the acting ignored the `state`
  tags on the row.

## Related Agents

- penciller
- comic-writer

## Related Commands

- panel-script
- smart-page

## Notes

Playable actions come from actor direction (Judith Weston, *Directing
Actors*). Will Eisner makes the matching case for the drawn figure in *Comics
and Sequential Art*: posture and gesture reach the reader before the face
does. The same two ideas work as the brakes on a generation model's habit of
overacting.

Acting depends on physical state. Read the row's `state` tags before writing
the line: a character with a cut hand favors it, and one who has been carried
does not stand up straight in the next panel.

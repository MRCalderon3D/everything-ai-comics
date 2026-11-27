---
name: Comics studio
description: A drawing desk for making one comic with AI, from story to published edition.
colors:
  board: "#eceef2"
  sheet: "#ffffff"
  sheet-2: "#f5f6f8"
  sheet-3: "#e7e9ee"
  ink: "#1b1a22"
  ink-2: "#4a4956"
  ink-3: "#696876"
  line: "#d8dae1"
  line-2: "#c3c6cf"
  panel-ink: "#1b1a22"
  non-photo-blue: "#2357c4"
  non-photo-blue-wash: "#e5ecfb"
  process-yellow: "#ffd23d"
  process-magenta: "#c2185f"
  process-magenta-wash: "#fbe5ee"
  ok: "#17734c"
  ok-wash: "#e0f2e9"
  bad: "#b3261e"
  bad-wash: "#fbe7e5"
  warn: "#855600"
  warn-wash: "#fff1cc"
  art-bg: "#dfe2e8"
  lightbox-board: "#15161c"
  lightbox-sheet: "#1e2028"
  lightbox-ink: "#edecf3"
  lightbox-blue: "#8fb2ff"
  lightbox-magenta: "#ff73ab"
typography:
  display:
    fontFamily: "Bahnschrift, DIN Alternate, Avenir Next Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Bahnschrift, DIN Alternate, Avenir Next Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.1
  title:
    fontFamily: "Bahnschrift, DIN Alternate, Avenir Next Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.1
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Helvetica Neue, Noto Sans, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Helvetica Neue, Noto Sans, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  art: "3px"
  ctl: "8px"
  box: "12px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
components:
  button-primary:
    backgroundColor: "{colors.process-yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ctl}"
    padding: "7px 16px"
    height: "38px"
  button-default:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ctl}"
    padding: "7px 16px"
    height: "38px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.non-photo-blue}"
    rounded: "{rounded.ctl}"
    padding: "7px 16px"
  button-danger:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.ctl}"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ctl}"
    padding: "8px 11px"
    height: "40px"
  chip:
    backgroundColor: "{colors.sheet-3}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  panel:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.box}"
    padding: "24px"
  caption-box:
    backgroundColor: "{colors.process-yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.art}"
    padding: "18px 20px"
---

# Design System: Comics studio

<!-- Recorded from the code by an Impeccable `document` pass (scan mode) that
ran without the owner present. The tokens are the values in
studio/web/css/base.css, which stays the source of truth: change a value
there and here together. The north star and the rule names are the agent's
reading of the existing world and wait for the owner's confirmation. -->

## Overview

**Creative North Star: "The Drawing Desk"**

The studio looks like the desk a comic is made on. Surfaces are bristol
board and paper in the light theme, and the same desk on a lightbox in the
dark one. Artwork sits in inked panel borders with square corners. Colour is
taken from the print process and each colour has one job: non-photo blue for
anything the person can use, process yellow for the one thing to do next,
process magenta for work the AI is doing right now. Everything else is ink
on paper.

It is a tool people work in for hours, so it stays quiet: one family of
body text, a tight type scale, flat panels with hairline borders. The comic
world shows in a few places that carry meaning. The yellow caption box holds
the next step, with a halftone shadow. The path of the comic is a strip of
numbered panels. Drawings get an inked frame and a printed offset shadow
when they can be opened. three.js gives the shelf of comics, the style
gallery and the page being inked while it draws; every 3D stage has a flat
fallback and stands still with reduced motion.

**Key Characteristics:**
- The drawing is the largest thing on any screen that has one.
- One yellow thing per screen.
- State is said in words first; colour and outline support the words.
- Dark theme is the lightbox: same roles, light ink on a dark board.

## Colors

A print palette: ink and paper, plus three process colours, each with one job.

### Primary
- **Non-photo Blue** (`non-photo-blue`; `lightbox-blue` in dark): links, quiet buttons, focus rings, selection, the guide's caption, the "new" markers. Never decoration.

### Secondary
- **Process Yellow** (`process-yellow`, the same in both themes): the next step. The caption box, the primary button, the next step of the path, the selected style. Always with ink text and an inked edge.

### Tertiary
- **Process Magenta** (`process-magenta`; `lightbox-magenta` in dark): work that is running. The queue chip while a job runs, the running job's outline, the turning arc, the waiting card.

### Neutral
- **Board** (`board` / `lightbox-board`): the desk behind everything.
- **Sheet** (`sheet`, `sheet-2`, `sheet-3`): panels, fields, chips, from front to back.
- **Ink** (`ink`, `ink-2`, `ink-3`): text from primary to faint. `ink-3` is the floor for text; it passes 4.5:1 on board and sheet in both themes, so keep it off `sheet-3`.
- **Panel Ink** (`panel-ink`): the borders of artwork, the done steps of the path, the selected thumbnail.
- **Line** (`line`, `line-2`): hairlines and field borders.
- **States** (`ok`, `bad`, `warn` and their washes): verdicts, readiness, errors. Each has its own ink for text on a filled background (`--bad-ink` on a danger button).

### Named Rules
**The One Yellow Rule.** Process yellow marks the single next action of a screen. A second yellow element on the same screen is a bug.

**The Magenta Means Running Rule.** Magenta appears only while the AI is working. When the job ends, the colour goes with it.

## Typography

**Display Font:** Bahnschrift at 80% width (with DIN Alternate, Avenir Next Condensed, Roboto Condensed, Arial Narrow)
**Body Font:** Segoe UI Variable Text (with the platform's system UI face)
**Label/Mono Font:** Cascadia Mono (with Consolas, SF Mono, Menlo), for file text only

**Character:** a condensed, lettering-like face for titles over the system's own text face. The display face comes from the system because the policy forbids web fonts from the network; a self-hosted face is an open decision.

### Hierarchy
- **Display** (700, 3.25rem, line-height 1): project titles on the shelf and the project home.
- **Headline** (700, 2.5rem, 1.1): the `h1` of every screen.
- **Title** (650, 1.375rem to 1.875rem, 1.1): panel titles (`h2`), card names.
- **Body** (400, 0.9375rem, 1.55): everything else, at most 72ch per line.
- **Label** (600, 0.8125rem): hints, chips, metadata.

### Named Rules
**The No Skipped Levels Rule.** One `h1` per screen, then `h2`, then `h3`. Size comes from the class (`.panel-title`, `.doc-title`), never from picking a lower level.

## Layout

Three columns: the path of the comic on the left (216 px, 196 px under 1360 px), the screen in the middle (at most 1480 px), the conversation on the right (380 px). The side columns resize by drag or arrow keys, collapse to rails, and focus mode hides both. Under 1240 px the conversation floats over the screen; under 1080 px the path becomes a rail of numbers; under 760 px both are drawers and the top bar keeps only icons (under 560 px the language moves to Settings).

A working screen is a bench of two parts: what is being made and its artwork, with the larger share for the art. The bench stacks, art first, when the screen is under 820 px wide; a check (verdict beside drawing) stays side by side down to 720 px.

Spacing is a 4 px grid (`s1` to `s7`). Groups inside a panel use 12 px; panels and sections use 24 px.

## Elevation & Depth

Flat by default. Panels are sheet on board with a hairline. Depth appears for three reasons only: a soft lift (`--lift`) under the selected step of the path and segmented choices; a printed offset shadow (a hard ink or yellow shadow) on things the comic world owns, such as the primary button, a drawing that opens, the selected style and the caption box; and a wide soft shadow under what floats (dialogs, drawers, toasts).

### Named Rules
**The Printed Shadow Rule.** A hard offset shadow belongs only to comic objects (the primary button, artwork, the caption box, the chosen style). Chrome never gets one.

## Shapes

Corners by role: artwork is a panel (3 px), controls are soft (8 px), containers are softer (12 px), chips are pills. Outlines carry state: a whole border in the state's colour, dashed for something optional, accepted or draft. A bar down one side of a box is not used.

## Components

### Buttons
- **Shape:** soft corners (8 px), 38 px tall, 32 px small, 48 px large.
- **Primary:** process yellow, ink text, a 2 px ink edge and a 3 px printed shadow that collapses on press.
- **Default:** sheet with a `line-2` border; hover darkens the border.
- **Quiet:** non-photo blue text, wash on hover.
- **Danger:** `bad` fill with `--bad-ink` text in both themes.

### Chips
- **Style:** pill, `sheet-3` with `ink-2`; state chips use the state's wash and colour.

### Cards / Containers
- **Panel:** sheet, 1 px line, 12 px corners, 24 px padding. Inside a panel a plain note is a line of text and a verdict is a band of colour, never a box in a box.

### Inputs / Fields
- **Style:** sheet, `line-2` border, 8 px corners, 40 px tall.
- **Focus:** the border turns non-photo blue with a 3 px ring of the same colour at 30%.

### Navigation
- **The path:** numbered panels; inked when done, yellow when next, dashed when optional, a split fill while in progress. A count of what is new sits on the panel, red for failures and questions.

### The Caption Box (signature)
The yellow box with an inked edge and a halftone shadow that holds the next step. One per screen.

### The Conversation
Messages from the person in non-photo blue bubbles; the AI on paper. Action cards are inked boxes that say what will run, with which tool and how long it usually takes. Results come back outlined in the colour of how the job ended. The guide speaks in a blue caption while it is the current step.

## Do's and Don'ts

### Do:
- **Do** keep the artwork the largest element on any screen that has one.
- **Do** say every state in words (a verdict, a job state, a step state) and use colour and outline to support it.
- **Do** use the names of things in front of the person ("Page 2", "issue 1") and keep IDs and file paths under "Details", "Show the file" or "Advanced".
- **Do** add every new string to both `en.js` and `es.js`.
- **Do** keep standalone small controls at least 24 px tall.

### Don't:
- **Don't** use a bar down one side of a box for state; use the whole outline, a wash, or a label.
- **Don't** put a second yellow element on a screen.
- **Don't** use magenta for anything but running work.
- **Don't** nest a bordered box inside a panel.
- **Don't** load anything from another host; the policy is `default-src 'self'`.

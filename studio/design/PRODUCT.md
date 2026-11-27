# Product

<!-- impeccable:product-schema 1 -->

Written by an Impeccable `init` pass that ran without the owner present.
Every fact below comes from the owner's written brief, `TODO.md` and the
code. Lines marked "(inferred)" are the agent's reading and wait for the
owner's confirmation.

## Platform

web

## Users

One person making a comic on their own computer. Some are comic makers who
know nothing about AI tools and only want to tell a story and see it drawn.
Others are power users who know Claude Code and Codex and want to choose the
model per job, read the plan files and drive everything from the chat. Both
use the same screens; the second group finds its details one click away.

They work in Spanish or English. The studio follows the comic's interface
language and the person can switch it at any time.

## Product Purpose

A local web app that takes one comic from the first idea to a published
edition: story, style, characters, places, page plans, drawn pages, checks,
corrections, cover and the files to read (PDF, CBZ, EPUB, web reader).
Claude Code plans, writes and reviews; Codex draws. Every step is saved as a
git commit, so anything can be undone from History.

Success is a person who never used the studio reaching a published comic
without guessing the next step, while the story stays theirs: the AI proposes
text and the person accepts, edits or rejects it.

## Positioning

The studio runs the person's own installed CLI tools on their own machine,
through a scaffold of rules, schemas and checks that keeps characters, places
and lettering consistent from page to page. Nothing is uploaded. Approvals
are always the person's.

## Operating Context

- Sessions are long and jobs take minutes: drawing one page is two to five
  minutes, a batch of pages much more. The person keeps working on other
  screens while jobs run, and the studio has to show what finished while
  they were elsewhere.
- The three columns are the path of the comic (left), the work (middle) and
  the conversation (right). Side columns can be resized, collapsed or hidden
  (focus mode); below tablet width they become drawers.
- The conversation can do what the screens do through action cards, and a
  guide mode can lead a newcomer from an empty project to a published comic.
- A practice mode (`STUDIO_FAKE_AI=1`) draws placeholder art without calling
  any tool.

## Capabilities and Constraints

- Plain ES modules with no build step and no runtime dependencies. three.js
  is vendored under `studio/web/vendor/` and used for a few moments only: the
  shelf of comics, the style gallery, and a page being inked while it draws.
- Strict Content Security Policy (`default-src 'self'`): no CDN, no web
  fonts from the network, no inline scripts.
- Every visible string lives in `studio/web/js/i18n/en.js` and `es.js` with
  the same keys.
- The scaffold's vocabulary (IDs such as `PG_001_002`, file paths, verdict
  codes) exists underneath. In front of the person it is replaced by names
  ("Page 2"); the raw values stay under "Details", "Show the file" or
  "Advanced".

## Brand Commitments

- The artwork is the largest thing on screen on every screen that has art.
- Light and dark themes. The owner prefers dark (inferred: dark is the theme
  to judge first).
- Motion respects `prefers-reduced-motion`; 3D only where it adds something,
  never behind a form.
- Plain words: controls name their action, waiting states say what is
  happening and how long it usually takes.

## Evidence on Hand

- Owner's wishes: `TODO.md` items 1 (modern interface with motion, usability
  first), 7 (resizable and collapsible columns), 12 (what changed while away)
  and 17 (the chat can guide the whole comic).
- Screenshots of the real studio in `docs/images/`.
- No user testing notes yet. The test with a person who never used the
  studio (TODO item 1) has not happened.

## Product Principles

1. One obvious next action per screen. The yellow "Next" box is that action;
   nothing else on the screen competes with it.
2. The story is the person's. AI text arrives as a proposal, part by part.
3. Waiting is visible. Every job says what it is doing, how long it usually
   takes and that the person can keep working.
4. Details one click away. Names in front, IDs and files behind a disclosure.
5. Everything can be undone, and the studio says so when it matters.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast in both themes, visible keyboard focus, targets of
at least 24 by 24 px, labelled controls, one `h1` per screen with no skipped
heading levels, keyboard-movable resize handles, and status that never rests
on colour alone (every verdict is also words).

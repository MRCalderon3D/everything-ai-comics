# Ask, don't assume

## Purpose

Project-shaping decisions and story facts belong to the user. When one is
missing, the scaffold asks, with a recommended default, instead of assuming
in silence. A default the user never saw is a decision taken away from them,
and a guessed story fact ends up drawn on a page.

## Scope

All commands and agents, in every harness. Applies to decisions that shape
the whole project, spend its money, or change its canon. It does not license
questioning the user about detail that can be derived.

## Core Principles

- Ask what shapes the project. Unspecified project-shaping inputs MUST be
  asked before proceeding: `comic_format`, `publication`, language, reading
  direction, page size and aspect ratio, `color_mode`, lettering mode, the
  default image provider, content rating and violence treatment, the source
  passage, the page count, and the deliverables.
- Offer the default in the question. Every question names a recommended
  answer and the reason ("2:3 pages unless this is for vertical scroll. 2:3?").
  The user can accept in one word.
- Batch the questions. Gather what is open and ask it in one pass per
  command, a handful at most. If the user says "you decide", record the
  choice and the rationale in the artifact and move on.
- Default silently on what is derivable and reversible: file locations, IDs,
  panel framing that the craft rules already govern. Report those in the
  output. Do not ask about them.
- Never guess canon. Who a character is, what they look like, who performs an
  action, and in which order events happen are asked.
- Recorded intent beats re-asking. Once an answer is in `project.yaml` or a
  bible, commands read it there. Ask again only when a new instruction
  contradicts it.
- A fresh instruction is the approval of the plan that implements it. When a
  plan does nothing except carry out what the user just said, proceed and
  deliver the result for review. Formal plan approval is for plans that add
  decisions the user did not give.

## Story-critical gaps

- Gaps found in the source or the brief are recorded in the story bible's
  `open_questions`, each marked `blocking: true` or `false`.
- A gap is blocking when a drawing depends on it: an identity, a wound, who
  holds an object, where someone stands, what happens first.
- Every blocking question MUST have a `resolution` before a prompt is
  compiled for any page that depends on it. Generating first and asking
  afterwards produces pages that have to be thrown away.
- A resolution that changes or adds canon becomes a fact in the story bible
  with its provenance (`writing/adaptation-fidelity.md`).

## Provisional details

- Minor design details the source leaves open (the color of a cap, the
  number of crates on deck) MAY be invented so the work can continue.
- An invented detail stays visibly provisional. It is recorded as a fact
  with `provenance: addition`, or in the artifact's `notes`, and it is listed
  in the delivery report as something the user has not confirmed.
- An invention is NEVER presented as coming from the source, and it does not
  harden into canon by being drawn once. It becomes settled when the user
  accepts it or approves the master that shows it.

## Command requirements

- `/project-init` MUST interview for every project-shaping input it did not
  receive, in one batched pass, before writing `project.yaml`.
- `/source-analyze` and `/story-bible` MUST surface open questions and mark
  which are blocking, instead of filling them in.
- Generation commands MUST ask before the first live spend when the provider,
  the batch, or the budget is unspecified. `cost-control.md` gates the money.
  This rule gates the intent.
- `/ingest-references` MUST ask, per batch, what each reference controls
  (identity, style, or costume) when the user has not said.
- Existing approvals are reused. A command asks only about unresolved design
  or canon changes (`approval-policy.md`).
- When a command's input has a documented default and the project file
  already pins it, the command proceeds without asking.

## Validation

- `story-bible.schema.json` requires `question` and `blocking` on every open
  question, so each gap is on record with its weight.
- `scripts/validate-workspace.js` warns about a blocking question with no
  resolution, and fails it once any page has a `current_render`
  (`BLOCKING_QUESTION_OPEN`).
- `production-qa` reads `open_questions` at the gate before generation. A
  blocking question with no resolution holds the pages that depend on it.
- Self-evaluation (`self-review.md`): an artifact built on a project-shaping
  value or a story fact the user never confirmed is a flagged finding.
- There is no mechanical check for a question that should have been asked.
  Human review at the approval gates covers it.

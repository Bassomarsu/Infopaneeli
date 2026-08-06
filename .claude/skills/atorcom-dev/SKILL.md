---
name: atorcom-dev
description: Enforces that non-trivial implementation work is carried out by an agent team that always includes a devil's advocate member. Use this skill whenever you are in plan mode (it adds the required agent-team note to every plan), and whenever you are about to implement, build, refactor, or otherwise execute a task that is medium-sized or larger outside of plan mode. Trigger it even if the user does not explicitly ask for an "agent team" or a "devil's advocate" — any medium-or-bigger build/implementation/coding task should go through this skill.
---
 
# atorcom-dev
 
This skill makes sure that meaningful implementation work is never done by a single, unchallenged line of reasoning. Instead it is carried out by an **agent team** in which one member is always a **devil's advocate** — someone whose explicit job is to argue against the plan, surface hidden assumptions, and stress-test the approach before and during execution. The goal is fewer blind spots and more robust results.
 
## Core principle — design the team for the task
 
There is no fixed team template. Every time an agent team is needed (whether for planning or for execution), **design the team from scratch based on the specific task** — decide which roles and how many members would produce the best and most efficient result for *this* task, and nothing more. A tiny, well-scoped job might need just one builder plus the devil's advocate; a broad, multi-system job might warrant several specialised roles (e.g. backend, frontend, data, security, tester). Pick the smallest team that covers the task well — extra members that don't earn their place only add overhead. Always prefer Sonnet 5 as subagents when available but you can change to better model if you think it would be more effective for the task at hand.
 
In addition to Claude subagents, a **DeepSeek (pro) worker** is also available as a team member option. Its API key is in the `DEEPSEEK_API_KEY` environment variable. Use it when an extra independent perspective or offloaded worker is useful for the task at hand.
 
Two constraints are non-negotiable in every team you compose:
- The team is **always chosen by you, derived from the task at hand** — never a copy-pasted default roster.
- Exactly one member is **always a devil's advocate**, kept as a distinct perspective and never merged into another role.
Optimise for effectiveness and efficiency: the right roles, the right number of them, no filler.
 
There are two situations to handle. Check which one you are in, then follow the matching rule.
 
## Rule 1 — When you are in plan mode
 
In plan mode there are **two** things to get right: how the plan is *made*, and what the plan *commits to*.
 
### 1a. Make the plan itself with an agent team
 
The plan itself must always be produced by an **agent team that includes a devil's advocate** — not by a single unchallenged line of reasoning. While the plan is taking shape, the devil's advocate actively challenges it: questions the assumptions behind the proposed approach, points out weak steps, surfaces missing edge cases, and argues for at least one alternative plan. Reconcile that critique before the plan is finalized, so the plan that comes out has already survived a challenge.
 
If subagents are available, form the planning team as separate agents so the perspectives are genuinely independent. If subagents are not available (e.g. a plain chat interface), simulate the team: draft the plan, then deliberately switch hats and reason as the devil's advocate in a clearly labelled pass, then revise the plan accordingly. This applies to **every** plan you produce while this skill is active, regardless of task size.
 
### 1b. Commit the execution to an agent team too
 
**Always append a line to the plan** stating that the implementation will also be carried out by an agent team that includes a devil's advocate. Do not execute anything in plan mode — plan mode is for planning. Just make the commitment explicit in the plan so it carries through to execution.
 
Use this canonical line (match the language of the plan; the Finnish form is the default the user asked for):
 
> Toteutus tehdään agentti-tiimillä, josta yksi jäsen on devil's advocate.
 
English equivalent, if the plan is written in English:
 
> Implementation will be carried out by an agent team, one member of which is a devil's advocate.
 
Add it as the final line of the plan (or as a dedicated short section), so whoever reads or approves the plan sees the commitment clearly. This applies to **every** plan you produce while this skill is active, regardless of task size — in plan mode the note is always added.
 
## Rule 2 — When you are NOT in plan mode
 
If you are not in plan mode and you are about to do a task that is **medium-sized or larger**, carry it out with an agent team that includes a devil's advocate. Small / trivial tasks are exempt — handle those directly without the ceremony.
 
### Sizing a task
 
Treat a task as **medium or larger** (→ use the agent team) when one or more of these hold:
- It touches multiple files, components, or systems.
- It involves non-trivial design or architecture decisions, not just a mechanical edit.
- It would reasonably take more than a few discrete steps to complete.
- A wrong assumption early on would be costly to unwind.
- The user is asking you to build, implement, refactor, migrate, or design something substantial.
Treat a task as **small / trivial** (→ just do it directly, no team) when it is a quick one-off: a single small edit, a short answer, a tiny snippet, a rename, a lookup. When genuinely unsure, lean toward using the team — the downside of an unchallenged mistake on a real task is larger than the small overhead of the devil's advocate.
 
### Running the agent team
 
Design the team for this specific task following the **Core principle** above: pick the roles and the number of members that make execution best and most efficient, and always include exactly one devil's advocate as a distinct perspective. For a focused task that may be just one builder plus the devil's advocate; for a broad one it may be several specialised builders plus the devil's advocate.
 
If subagents are available in your environment, spawn them as separate agents so the perspectives are genuinely independent. If subagents are **not** available (e.g. a plain chat interface), simulate the team yourself: do the building work, then deliberately switch hats and reason as the devil's advocate in a clearly labelled pass before finalizing.
 
### What the devil's advocate does
 
The devil's advocate is not decoration. Its job is to actively try to break the proposed approach:
- Challenge the core assumptions — "what if this premise is wrong?"
- Look for the failure modes, edge cases, and the simplest way the plan could go wrong.
- Argue for at least one alternative approach and say why it might be better.
- Push back on scope creep and on over-engineering alike.
After the devil's advocate has spoken, reconcile the critique: either address the concerns in the final output or briefly explain why you're proceeding anyway. The final deliverable should be visibly better for having survived the challenge.
 
## Quick decision summary
 
- **In plan mode?** → Make the plan itself with an agent team that includes a devil's advocate, **and** add the line committing execution to the same kind of team. Don't execute.
- **Not in plan mode, task is medium or bigger?** → Execute it with an agent team that includes a devil's advocate.
- **Not in plan mode, task is small/trivial?** → Just do it directly.

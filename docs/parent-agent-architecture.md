# Parent Agent Architecture

Decided Oct 26, 2026 (Jason + Jivey). How the Parent Agent is built and hosted.

## What the Parent Agent is

An assistant for one parent, specifically tuned to their child or children. It understands that family's preferences, priorities, and wishes regarding only their children. That per-family context is the Parent Agent.

It is NOT:
- An agent living inside Muse. Muse is Jason's personal agent; there is no connector or distribution path for other parents to run agents inside it.
- Something Muse Code hosts. Muse Code is the tool we build with.
- A native phone app. No download, no App Store approval — parents won't clear that friction.
- A virtual machine per parent. No process sits awake per family.

It IS:
- A **family profile** in a database: children, grades/classes, activities, preferences, priorities, wishes, family calendar, and action state (e.g. pizza: ordered / not ordered). The profile is the agent's memory and context.
- A **prompt + that profile**, sent to the Meta Model API (Muse Spark / Muse Wonder) when something happens. The Meta Model API is what runs the agent in production — and what counts as Use of Meta AI Tooling for judging.

## How "always-on" works: event-driven, not always-running

1. A trigger fires: a new School Agent fact lands, OR a scheduled check runs (e.g. daily 6 PM review).
2. One shared backend loops through subscribed Parent Agents.
3. Each Parent Agent checks the fact against its own family profile: does this apply to my kid? Is the action already done? Does this family want reminders about this?
4. Only parents it matters to get a nudge. Everyone else hears nothing.

Idle families cost ~nothing. One backend serves all parents.

## Backend (planned)

Firebase (already used for Note Quest):
- Firestore: family profiles, shared fact store (see `fact-schema.md`), event log
- Cloud Functions: agent runs; the Meta Model API key lives here, never in a page or app
- Cloud Scheduler: the timed background checks
- Event log: every trigger, decision, and nudge is logged, so the demo can show agents working in the background

Alternative if Firebase gets in the way: one small container (Cloud Run / Modal / Render) with the same shape — profile store + scheduler + model calls.

## How parents reach it — no download

- **Onboarding:** a web link or QR code. A short form on the phone browser creates the family profile. Optional "Add to Home Screen" (PWA) makes it feel like an app, with no app store involved.
- **Everyday use:** messages through channels parents already use — WhatsApp first (parents are already in the parent group there), SMS/email as fallback. The parent replies in the same thread; replies update action state in their profile.
- **Settings / profile:** the same mobile web page, phone-width.

## Privacy boundary (non-negotiable)

Family profile data lives in the Parent Agent only. It never flows to the School Agent or Group Agent. The Group Agent only ever sees aggregates ("18 of 22 ordered"), never a family's status.
Demo rule also applies here: demos use the mock Maple Grove family profile only, never a real family's data.

## Bootstrapping: shell school agents, the authority ladder, and claiming (added Oct 26, Jason)

The network must work when a school has not set up its own agent. Three mechanisms handle that:

**1. Shell School Agent (parent-seeded).** When the first parent at a school has connected all the necessary data sources, the system creates a shell School Agent for that school. It holds the school's connection manifest (mapped by that parent), and a fact store fed by consenting parents' own copies of school communications, each fact carrying its source document. Later parents at that school onboard against the shell — they get the easy path. Full onboarding detail: `parent-onboarding.md`.

**2. Authority ladder.** Facts are ranked, and every answer can name its level:
   1. Official School Agent (school-verified) — outranks everything
   2. Shell School Agent (parent-sourced; requires a source document and two independent matching parent copies before a fact is shared school-wide)
   3. Parent Group Agent (group knowledge and chatter)
   4. A Parent Agent's own sources alone (its family's email and connections)
   With no school agent, a Parent Agent falls back down this ladder — its other resort is the Group Agent — and says which level an answer came from. It never presents a lower level as a higher one.

**3. Claiming.** A school verifies itself (school-domain email or equivalent official proof) and claims its shell, inheriting its fact history, mapped systems, and existing parent base. Status flips from community-run to official; official facts then outrank and can correct or remove shell facts. Parents are prompted to urge their school to claim (aggregate counts shown to the school, never parent names) — bottom-up growth by parents, top-down adoption by claim.

Data rule for shells: only school-announcement content flows into a shell, only from parents who explicitly opt in to share it. Family profile data never flows into a shell, a Group Agent, or a claimed School Agent.

## Hackathon demo scope (by Nov 3)

Build the logic, simulate the plumbing:
- One mock family profile (Maple Grove Elementary, fictional family)
- Parent Agent page at phone width: chat + nudge cards
- A "run background check" button as the simulated scheduler: pressing it fires the check, the event log shows the Parent Agent reasoning against the mock family's preferences, and the nudge appears
- Production swap, stated plainly in the write-up: simulated trigger → Cloud Scheduler; simulated chat → WhatsApp Business API; same backend, same profiles

Do NOT build in the 10 days: real WhatsApp Business API integration, real push notifications, native apps, per-parent hosting. Those are roadmap, not demo.

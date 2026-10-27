# Parent Onboarding

Decided Oct 26, 2026 (Jason + Jivey). How a parent connects their scattered school systems to their Parent Agent.

## The problem (Jason's framing)

A parent's school life is scattered across separate systems: SchoolMessenger for announcements, Healthy Hunger for hot lunch ordering, their own email inbox, a separate school bus website, a calendar, and more. The parent has to connect these elements to their agent — and the more they connect, the more useful the agent gets. Onboarding has to make that easy, or parents won't finish it.

## Core principle: the parent never names a system

The agent already knows what to connect, because the school tells it.

When a school is set up, its School Agent publishes a **connection manifest**: which systems that school uses and what each one is for — e.g. announcements via SchoolMessenger, lunch ordering via Healthy Hunger, this bus service and route board, email for everything else.

A parent joins by picking their school (or tapping the school's invite link / QR code). Their school's connection list is already waiting, labelled in parent language ("School announcements", "Lunch orders", "Bus delays"), not vendor names.

If there is no School Agent for their school (standalone mode), the parent picks systems from a general catalogue, or the agent works from email alone.

## Three layers — never all at once

Asking for everything up front kills signup. Onboarding is progressive:

### Layer 1 — Two minutes, no passwords (signup)
- Pick school (or use invite link)
- Add child/children: name (mock in demos), grade, class
- Phone number for messages (WhatsApp)
- Priorities: tap what matters — deadlines, lunch orders, bus delays, forms, events
- Done. The agent is already useful from School Agent announcements alone. No login is requested at this layer.

### Layer 2 — One-tap email (the catch-all)
- Connect Gmail / Outlook in one tap, read-only, filtered to school-related senders only
- This is the most powerful single connection: SchoolMessenger notices, Healthy Hunger order confirmations, teacher emails, and receipts all arrive by email
- The agent can often establish action state ("lunch: ordered") from an email receipt without ever logging into the ordering portal

### Layer 3 — Deep connections, just in time (after signup)
One at a time, prompted when each becomes relevant — never as a signup checklist:
- "Pizza orders open Monday. Connect lunch ordering now (about a minute) and I'll check your orders for you."
- **Announcements portal (e.g. SchoolMessenger):** parent signs in once, on the real site, through secure credential storage — credentials are never typed into chat or stored in plain text. The agent reads announcements from then on.
- **Lunch ordering (e.g. Healthy Hunger):** portal sign-in as above; email receipts (Layer 2) are the low-effort fallback and may be enough on their own.
- **School bus:** usually no login at all — the parent enters their route number and the agent watches the public delay board for that route/school.
- **Calendar:** one tap, so nudges become calendar holds.

Skipping a connection is always fine. The agent states plainly what it can't do yet.

## Two mechanics that make it feel smart

1. **Coverage meter.** The parent sees what their agent can and can't see: "Your agent can see announcements and email — 60%. It can't check lunch orders or bus delays yet." Each new connection visibly buys something specific.
2. **Discovered connections.** Once email is connected, the agent suggests connections based on evidence: "I found lunch-order receipts in your mail — want me to track lunch orders?" The parent never had to know that system existed as a separate thing.

## Privacy rules for onboarding

- Read-only access wherever possible; school-sender filtering for email, not a full inbox read.
- Credentials only through secure storage, only on the real site's sign-in — never collected in a form we build, never in chat.
- Family data collected here belongs to that family's Parent Agent only (see parent-agent-architecture.md). It never flows to the School or Group Agent.
- Demos use mock onboarding data only (Maple Grove Elementary, fictional family) — no real logins or real school data on screen, ever.

## When the school is NOT participating (added Oct 26, Jason)

The manifest path above only works when a school has set up its agent. The system must also work when it hasn't — standalone mode is a core promise of the network, not an edge case.

In that case the parent DOES name the systems: onboarding flips from "your school's list is waiting" to "pick your school, then connect your sources by name" from the general catalogue — SchoolMessenger, Healthy Hunger, email, school bus, calendar. This is more work, and it falls mainly on the first parents at that school (see shell agent, below).

**Fallback resort — the Group Agent.** With no School Agent, the Parent Agent's other resort is the Parent Group Agent: it answers from what the parent group knows, plus whatever the shell agent (below) has collected, and it says plainly that its answers are group-sourced, not school-verified.

## The shell School Agent — parents seed a school

Once one parent at a school has connected all the necessary data sources, a **shell School Agent** is created for that school:

- The shell acts as that school's manifest for every later parent — parent #2 onward gets the easy, school-list-waiting path, because parent #1 already mapped the systems.
- Facts in the shell come from consenting parents' own copies of school communications (e.g. the newsletter in their SchoolMessenger / email). School-announcement facts may be shared upward with the contributing parent's explicit opt-in; family data never is.
- Every shell fact is labelled honestly: "from a parent's copy — not school-verified yet."
- **Two-copy rule:** a shell fact needs a source document, and at least two independent parent copies that match, before it is shared school-wide. One mistaken parent must not become everyone's misinformation. Confidence rises as more matching copies arrive.
- Duplicate shells for the same school are merged by school identity, not left to compete.

## The advocacy loop — parents recruit the school

Parents at an unclaimed school are urged to tell their school to set up / claim its agent:

- In the Parent Agent, in plain terms: "Your agent is working from your email alone. Your school hasn't claimed its agent yet — here's a ready-made message to send them."
- The school sees aggregate pull only, never names: "37 parents at your school are waiting."
- The Group Agent can carry the same message into the parent group, where it spreads parent-to-parent.

## Claiming — the school takes over its shell

When the school eventually sets up its agent, it **claims** the shell instead of starting cold:

- Verification: a school-domain email (or an equivalent official proof) establishes the claim.
- The school inherits the shell's fact history, mapped systems, and the parent base already using it — no restart, no migration.
- The badge flips from "community-run" to "official"; from then on, official school facts outrank shell facts, and the school can correct or remove shell facts.
- For the school, claiming something already built and already used by its parents is a much easier yes than a cold signup — this is the network's growth engine: bottom-up by parents, top-down by claim.

## Hackathon demo scope

One onboarding screen for the mock Maple Grove parent:
- Pick the school → add a fictional kid → tap priorities
- Connection tiles with statuses: Announcements (connected via school), Email (connected), Lunch orders (not connected), Bus route (not connected)
- Coverage meter at 60%
- No real logins, no real data, anywhere in the flow

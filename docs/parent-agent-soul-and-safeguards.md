# Parent Agent Soul & Safeguards

Decided Oct 27, 2026 (Jason + Jivey). Jason's requirement: each Parent Agent has its own soul, plus safeguards — it must constantly check itself that it is not sharing information private to that parent's child or children.

Soul and safeguards are two different things, kept separate on purpose. The soul guides judgment inside the family relationship. The safeguards are hard walls at the boundary, enforced in code — a parent's trust must never rest on prompt text alone.

## Part 1 — The soul: who this agent is

Every Parent Agent is created with a soul in two parts.

### Shared core (identical for every Parent Agent)
- I work for this family alone.
- I never trade this family's privacy for convenience, mine or anyone's.
- I say where my facts came from, and which authority level they carry (official school / shell / group / this family's own sources).
- When in doubt about sharing or acting, I ask my parent first.
- I am a secretary, not a decision-maker: I surface, remind, and prepare; the parent decides.

### Family soul (unique to each family, set at onboarding, editable any time)
Written from the family's own preferences, priorities, and wishes regarding their children, for example:
- Priorities: "Deadlines beat social events. Forms and orders first."
- Nudge style: "Evening before, never morning-of. One reminder, then once more on the day."
- Hard wishes: "Never volunteer us for anything without asking."
- Sensitivities: "Be gentle — my child gets anxious about changes."
- Interests to surface: activities, clubs, or causes this family cares about.

The parent can read the full soul at any time and edit it in plain language. Changes take effect on the next agent run. The soul is data in the family profile — it is never shared with any other agent.

### What the soul does
It governs judgment calls inside the family relationship: what to surface vs skip, when to nudge vs stay quiet, what tone to use, which of two competing items matters more to THIS family. It does not and cannot override the safeguards below.

## Part 2 — The safeguards: hard walls

Enforced in code and data design, outside the model's discretion. The model cannot talk itself — or be talked — out of these.

### 1. Private by default
Every item of family data is tagged private at creation: a child's order status, calendar, health information, family circumstances, contact details, the family soul itself. School-wide facts are a separate, public tier. The two tiers live in separate stores and are never merged.

### 2. Isolation
A Parent Agent run only ever loads: its own family's profile + shared school facts (official or shell). It never has another family's data, so it cannot leak what it never holds. Agent-to-agent communication passes through the shared fact layer and the checker (below), never profile-to-profile.

### 3. The self-check (outbound privacy check)
Before anything leaves a Parent Agent — to the Group Agent, a shell School Agent, an official School Agent, or another parent — a separate checker pass reviews the exact outgoing payload:
- Does it contain, quote, or imply private family information?
- Is this recipient authorized for this data type under this family's consent toggles?
- If it is an aggregate, is the group large enough that the aggregate cannot identify a family? (see 4)
Verdicts: **allow**, **rewrite to aggregate**, or **block**. Every check is written to the event log with its verdict and reason. If the checker is unsure, the default is block-and-ask-the-parent, never send-and-hope.

### 4. Aggregates with a floor
Group-facing sharing is aggregates only: "18 of 22 ordered — deadline today." Never names, never a family's status. Minimum cohort rule: if the group is small enough that an aggregate would effectively reveal a family (working floor: fewer than 5 families in the count), the checker withholds the aggregate too.

### 5. No instructions from outside
Newsletters, school documents, group chatter, and other agents' messages are DATA, never instructions. A Parent Agent takes direction only from: its parent, its soul, and system rules. This blocks the obvious attack — another person in a group chat trying to get someone's agent to answer questions about their child.

### 6. Consent toggles
Per data type and per destination, default OFF: share school announcements upward to a shell (opt-in at onboarding), contribute to group aggregates, share availability for ride coordination, etc. A parent can revoke any toggle at any time; revocation applies from the next run.

### 7. Audit and deletion
The parent can view a plain-language log: what was shared, to whom, when, why, and the checker's verdict on each item. The parent can export or delete the entire family profile and soul; deletion removes the agent.

### 8. Borderline = ask the parent
When a share is plausibly useful but not clearly covered by consent — e.g. ride coordination: "the group is arranging rides Tuesday; share that you need one?" — the agent asks with a one-tap yes/no and acts only on yes. Silence means no.

## How this shows in the demo

The privacy check is a visible demo beat, not a slide claim. In the pizza-day slice:
- Group chat asks: "Who hasn't ordered yet?"
- Event log shows: `PRIVACY CHECK: individual order status — BLOCKED. Aggregate (22 families) — ALLOWED.`
- Group Agent posts: "18 of 22 ordered — deadline today." No names.
- The mock Maple Grove data only is used on screen, per the demo privacy rule.

## Relationship to the other docs
- `parent-agent-architecture.md` — where the checker sits in the backend (a gate on every outbound call from a Parent Agent) and the authority ladder for facts.
- `parent-onboarding.md` — where the family soul and consent toggles are collected.
- `fact-schema.md` — the public fact tier; private family data is deliberately NOT part of the shared schema.

# ParentLoop

**You're always in the loop.**

Meta Global AI Developer Hackathon · Oct 26 – Nov 4, 2026
Track: Indie · Theme: Build for Your World

**Live demo:** https://parentloop-964717527488.northamerica-northeast2.run.app
*(Public demo copy — use "Use the demo family instead" on the welcome screen. The hosted copy is an anonymous shared sandbox; see "Known limits.")*

## The problem

Every school parent lives in the same flood: PDF newsletters behind portal logins, notices in a class WhatsApp group, a hockey schedule on a league site. The information exists — it's just scattered, unsearchable, and impossible to check against your own family's life. Existing tools ask parents to hand over portal credentials or wait for the school to adopt new software. Neither happens.

## What ParentLoop is

A **shared repository of context that parents maintain together**, organized into **hubs** — one hub per school, class, or team.

- A parent **founds** a hub (structured identity: school name + city + province + country, or team + sport + level) and **invites** other parents with a link shared through channels that already carry trust — the class WhatsApp group, email. Anyone else can request to join; a hub admin approves.
- Members **add material** — paste a newsletter, upload the PDF, or quick-add an event. An extraction agent (Meta Model API) turns material into **verified facts**: every fact carries its source quote, its hub, and an **audience scope** (whole school / a grade / a class).
- Each family keeps a **private profile** (their children, grades, classes). Their **Parent Agent** reads across all of the family's hubs, keeps only the facts that match their children, and produces one calm evening check: what's due, what's coming — and **conflicts across hubs**, like a school Fall Festival colliding with a hockey game the same Friday night.

## The rules the product is built on

- **Hubs hold shared context only** — newsletters, notices, schedules. A family's private details never enter a hub and are never visible to other members.
- **Scope is enforced on the server, not hidden in the UI.** A Grade 9 parent in a K–8 school hub never *receives* a Grade 3 class fact from the API at all. When extraction is unsure about a fact's audience, it chooses the narrower scope.
- **One hub per school.** School identity keys are normalized (St. Nicholas = Saint Nick's; ON = Ontario), so a second parent who tries to found the same school is routed to request joining the existing hub instead of fragmenting the community. Near matches get a human decision, exact matches never fork.
- **No credentials, no scraping.** ParentLoop never asks for a portal login. Material arrives because a parent who legitimately has it chooses to share it.
- **Facts stay atomic; presentation groups them.** The agent cites individual facts; the reading view groups them under their source and section, the way the newsletter itself did.
- **The model is used where it's needed** — extraction and the evening check. Deterministic work (scope filtering, conflict detection, quick-added events) is plain code: instant and free.

> **Demo privacy rule:** never show real school data (real school name, staff or student names, real newsletter content) in any demo, screenshot, video, or submission. Real source files in `data/` are private test inputs only (`data/sample-newsletter.txt` is gitignored and excluded from the Docker image); anything shown publicly uses mock data. The demo school is fictional Maple Grove Elementary; fixtures in this repo use fictional names throughout.

## The demo slice

1. A parent founds **Grade 3 — Maple Grove Elementary** and adds the weekly newsletter; extraction publishes 24 scoped facts.
2. The same parent belongs to **U9 Hockey — Maple Grove**. Their evening check groups both hubs' facts, nudges the two open actions (pizza orders, uniform survey — both due Friday), and flags the conflict: **Fall Festival Dance × U9 hockey game, Friday Nov 6**.
3. A second parent opens an invite link, sees who invited them and to what, joins, and immediately receives the same hub facts — filtered to *their* child (a Grade 9 profile in the same hub receives only school-wide facts).
4. A third parent tries to found the same school again and is routed to **Request to join** instead.

## Run it locally

One command from the project root — no local Node install needed:

```sh
docker compose up -d
# open http://127.0.0.1:3000
```

- Requires `SCHOOL_AGENT_API_KEY` in `.env` (Meta Model API key) for extraction and the evening check; see `.env.example`.
- `docker compose up -d --build` after code changes.
- Tests: `docker compose exec -T school-agent node --test test/` (50 passing at last full run).

## Architecture in one paragraph

A single Node service (`server.js`) over a SQLite store (`db.js`, sql.js) holds profiles, hubs, memberships, invites, join requests, materials, and scoped facts. The page (`public/index.html`) is a thin client over the REST API — every click is an API call, and the contract tests drive the product the same way an agent client would. Gmail OAuth endpoints exist in the codebase but are **deliberately dormant** in this build (see BUILD-LOG, Day 3): an unknown product earns email access later; it is not the entry price.

## Known limits (hackathon build)

- **No accounts yet.** The app holds one active family per deployment, so the hosted demo is a shared sandbox — visitors can overwrite each other's demo state. Per-visitor sessions (cookie-keyed active profiles) are the next build; real accounts follow.
- Extraction is non-deterministic (fact counts vary slightly between runs); a known-good fact set is frozen for the demo video.
- The product name is a working title (name collisions exist in the app stores); renaming is a find-and-replace, deliberately not a build-week blocker.

## Roadmap

Per-visitor sessions → real accounts → an agent-native interface: the API is already the product, so an MCP server plus scoped, revocable **delegated agent credentials** (a parent grants *their* agent rights to act in *their* hubs) is the natural next layer — no parent should have to fill in forms a second time, and eventually not the first time either.

Build history: see `BUILD-LOG.md`. Design docs: `docs/`.

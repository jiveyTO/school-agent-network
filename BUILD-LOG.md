# Build Log — School Agent Network

**Meta Global AI Developer Hackathon** (via Cerebral Valley) · Indie track · Build for Your World
**Build window: October 26 – November 4, 2026**

This project was started from scratch for this hackathon. No code in this repository existed before the build window opened on October 26, 2026. This log is updated as the work happens, and the git history in this repository is the timestamped record of the build.

The repository was created on October 27, 2026 to publish the work. Day 1 entries were recorded in the project notes on October 26 and are summarized here.

---

## Day 1 — Monday, October 26, 2026

- **Concept finalized: School Agent Network.** Three cooperating agents on one shared fact layer:
  - *School Agent* — the source of truth; turns school newsletters and notices into structured facts with provenance.
  - *Parent Agent* — a personal secretary for one family, tuned to their child: filters school facts to that family and acts on deadlines.
  - *Group Agent* — lives in the parent group chat; answers repeated questions from school-verified facts and shares privacy-safe aggregate counts only, never individual family information.
  - Each agent works on its own; together they are better. Authority order: official school > parent-seeded "shell" school agent > group > a parent's own sources.
- **Design docs written** (`docs/`): the shared fact schema (16 fields, source quote required on every fact), Parent Agent architecture (a family profile + a prompt, run event-driven from one shared backend), the three-layer onboarding design, and the Parent Agent soul & safeguards spec (private-by-default data tiers, an outbound privacy self-check on everything the agent sends, aggregates with a minimum cohort, audit log).
- **Bootstrapping design:** if the school doesn't participate, parents connect sources themselves, a parent-seeded "shell" School Agent is created for the school, and the school can later claim it and inherit its history.
- **Demo privacy rule set:** all demos use fictional Maple Grove Elementary data only. Real school material is a private local test input — it is gitignored, never committed, and never shown on screen.
- **Mock newsletter written** (`data/mock-newsletter.txt`): a fictional Maple Grove Elementary week (Nov 2–6) used as the demo input.
- **Phase 1 built** (with Muse Code): the School Agent — a small Node server (standard library only, no build step) that calls the Meta Model API from the server side and extracts the newsletter into `data/facts.json` exactly per the fact schema, plus a phone-width demo page with the newsletter, a Run button, the facts list, and an event log.
- **Phase 1 verified live:** a real API run extracted 22 facts; every fact's source quote checked verbatim against the newsletter; a re-run produced 23 (one announcement split in two) — extraction is non-deterministic, so a known-good `facts.json` will be frozen before the demo video is recorded.
- **Docker:** the run moved into `docker compose` (node:20-alpine, project mounted) so the server keeps running independent of any terminal session.

## Day 2 — Tuesday, October 27, 2026

- **Phase 2 built: the Parent Agent.**
  - Fictional demo family profile (`data/family-profile.json` — the Rivera family, Maya, Grade 3) with a family soul (priorities, nudge style, wishes) and tracked action states: pizza order *not ordered*, uniform survey *not done*.
  - New endpoint `POST /api/parent/run`: loads the school facts + the family profile, simulates Thursday, November 5, 2026, 7:30 PM, and makes a real server-side Meta Model API call. Result on the mock data: 23 facts checked → 22 relevant → 1 filtered out → 2 open-action nudges (pizza orders due, uniform survey due) plus a calendar hold for the pizza deadline.
  - The server validates every fact the model returns against the school fact layer, so the Parent Agent cannot invent facts. Every run's log ends with a server-appended **PRIVACY CHECK** line confirming family data stayed inside the Parent Agent.
  - Contract tests added for the family profile.
- **Phase 2 independently verified:** profile matches the design docs; no code anywhere in the project reads the private sample newsletter; the facts file re-validated (23 facts, source quotes verbatim, no real-school data present).
- **Demo page redesigned** for first-time parent users: warm product look, plain language, friendly cards with human dates and "Action needed / Good to know" chips, provenance kept as a small source quote under each card, the newsletter collapsed behind "Read the original," and the privacy check rendered as a highlighted banner. Presentation only — server, data, and endpoints unchanged (verified).
- **Partner credits:** applied to Baseten for Muse Spark Open credits (decision pending by email).
- **This repository created** and the code published, per the hackathon's public-repository submission requirement.
- **Google Cloud project created:** "School Agent Network" (project ID `school-agent-network`) — a new project for this product, linked to a billing account (Blaze pay-as-you-go) so the app can later deploy to Cloud Run for the judges.
- **New-parent onboarding built** (evening, with Muse Code):
  - The live store moved from JSON files to a **SQLite database** (`data/app.db`, gitignored) behind one module (`db.js`, sql.js — no native build). The Rivera JSON now seeds the database as the demo profile on first run.
  - First-run flow in the same app: welcome → family details → priorities → per-source connect screens (SchoolMessenger, Healthy Hunger, bus site — link + login details saved locally only, never returned by any API) → paste the school's latest newsletter to seed the School Agent. *Start over* and *Switch back to demo family* controls added.
  - **Gmail connects for real** via Google OAuth with exactly one scope — read-only (`gmail.readonly`). Tokens live server-side in the database only. A scan (last 30 days, capped at 50 messages) finds school newsletters (one click feeds one into the School Agent) and order receipts (a Healthy Hunger receipt sets the family's hot-lunch action to *ordered*, shown in the findings). With no OAuth credentials configured, the Gmail card shows a plain-language setup state instead of a broken button.
  - **Cloud Run readiness:** production `Dockerfile` + `.dockerignore` (excludes `.env`, the database, and the private newsletter file); the server honors the `PORT` env var; the OAuth return address derives from `PUBLIC_BASE_URL` so the same build runs locally and deployed.
  - **Verified independently:** all new/changed files read directly; database tables and the secret/token redaction rules confirmed in code; the OAuth auth URL requests exactly the read-only scope; the demo still seeds and the evening check still passes; contract tests extended (9/9 pass, including secret- and token-non-leakage). Live Gmail connect + scan wait on the owner's Google OAuth client setup — that is the next step, together with the first Cloud Run deploy.

## Day 3 — Wednesday, October 28, 2026

_(in progress)_

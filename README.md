# School Agent Network

Meta Global AI Developer Hackathon · Oct 26 – Nov 4, 2026
Track: Indie · Theme: Build for Your World

## The concept

Schools, parents, and parent groups each get their own agent. The agents cooperate and share context — but each one works on its own if it's the only one set up. The more agents in the network, the smarter each one gets. Nobody has to wait for everyone else to join before it works.

## The three agents

**School Agent — the source of truth**
Ingests newsletters, notices, and forms; publishes structured facts: deadlines, events, requirements, changes. Every fact carries provenance: what document it came from, when it was published.

**Parent Agent — the personal secretary**
Knows one family: the kid's grade and class, activities, the family calendar. Subscribes to School Agent facts and filters to what's relevant for your kid. Nudges like a secretary: "Pizza order form is due Friday — you haven't ordered yet." Creates calendar holds.

**Group Agent — the parent-group member**
Lives in the parent WhatsApp group (simulated group UI for the demo). Answers the repeated questions ("When is the form due? What do they wear for spirit day?") straight from School Agent facts, with the source named. Coordinates: who's volunteering, who's ordered, ride shares. Rolls a summary up, never individual family details.

## How they cooperate

- **Shared fact layer.** All three agents read and write one fact store. The School Agent outranks everyone: if group chatter conflicts with a school fact, the school fact wins and the Group Agent corrects the thread with a citation. See `docs/fact-schema.md`.
- **Consent boundaries.** Family-specific information (your kid's order status, your calendar) lives in the Parent Agent and never flows up to the Group or School Agent. The Group Agent only ever shares aggregates: "14 of 22 families have ordered."
- **Standalone modes.** Each agent runs alone. Joining the network upgrades each one.

## The demo slice

Maple Grove Elementary (fictional) pizza day, using mock data based on a real newsletter — see `data/mock-newsletter.txt`.

> **Demo privacy rule:** never show real school data (real school name, staff or student names, real newsletter content) in any demo, screenshot, video, or submission. Real source files in `data/` are private test inputs only; anything shown publicly uses mock data.

1. School Agent ingests the school newsletter → publishes "Pizza order deadline: Friday, $3/slice, form link."
2. Group Agent announces it in the group; a parent asks "is it due Thursday?"; Group Agent checks the School Agent and corrects: Friday, with the source.
3. Parent Agent checks its family: no order placed → nudges the parent Thursday evening and drops a calendar hold.
4. Group Agent posts Friday morning: "18 of 22 ordered — deadline today." No names.
5. Toggle test: turn the School Agent off and the Group Agent visibly degrades to guessing from chatter; turn it back on and it's authoritative again.

## Run Phase 1 (School Agent, Docker)

One command from the project root — no local Node install needed:

```sh
docker compose up -d
```

Then open http://127.0.0.1:3000 in a browser and press **Run School Agent**.

- Same Compose pattern as `~/Developer/Docker-Environment/Unified-Dev` (`container_name`, published port, project folder bind-mounted, `restart: unless-stopped`); see `docker-compose.yml`. The project folder is mounted at `/app` in a `node:20-alpine` container, so code and `data/facts.json` stay on the host.
- `.env` is read only inside the container by `server.js` (it is part of the mounted folder; Compose does not inject it). Copy `.env.example` to `.env` and set `SCHOOL_AGENT_API_KEY` first.
- Server listens on `0.0.0.0:3000` so Docker port publishing (`3000:3000`) reaches it. Stop with `docker compose down`. Logs: `docker compose logs -f`.

## Stack (planned)

- Meta Model API (Muse Spark / Muse Wonder) for all three agents — same model, three system prompts, three tool sets.
- One small backend: fact store (JSON/SQLite is fine), agent endpoints, simple event log so judges can see agents talking to each other.
- Front ends kept minimal: School Agent = upload + fact list; Parent Agent = chat + cards; Group Agent = WhatsApp-style chat mock.
- Build with Muse Code; $150 Meta Model API credits.

## Build order

1. Fact schema (`docs/fact-schema.md`)
2. School Agent end-to-end on a real newsletter: newsletter in → structured deadlines out
3. Parent Agent filtering + nudges
4. Group Agent Q&A against school facts
5. Cooperation layer: correction flow, aggregates-only rule, standalone toggles
6. Demo video — record by Nov 2; submission package finished Nov 3

Hard deadline: Nov 4, 9:00 PM ET.

Full plan: ~/workspace/your_files/hackathon-build-plan.md (in Muse's workspace)

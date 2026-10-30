# CLAUDE.md — school-agent-network (ParentLoop)

## Standing rule (owner-set, until revoked)

When a piece of work is finished and the full suite passes (`node --test test/`
green in the school-agent container): commit it, push to origin main, and
redeploy to Cloud Run — without asking first. Then report the commit hash,
test count, and Cloud Run revision. If tests fail, stop and report instead.

## Deploy recipe

From the project root, stage a clean copy (no `.env`, `.git`,
`data/app.db`, `node_modules`) into `unified-dev-env` at
`/tmp/parentloop-deploy`, copy `.env` in separately, then:

`gcloud run deploy parentloop --source . --project=school-agent-network
--region=northamerica-northeast2 --allow-unauthenticated --max-instances=1
--port=3000 --set-env-vars "SCHOOL_AGENT_API_KEY=...,SCHOOL_AGENT_MODEL=...,
SCHOOL_AGENT_API_URL=...,PUBLIC_BASE_URL=https://parentloop-964717527488.northamerica-northeast2.run.app"`

Read secrets only from the local `.env` inside the deploy container; never
print them. Remove `/tmp/parentloop-deploy` afterwards.

## Privacy (hard rules)

- The `data/app.db`, `.env`, and `data/sample-newsletter.txt` files are never
  committed, never enter the container image, and real family/newsletter data
  never appears in fixtures, placeholders, docs, or tests.
- The hosted Cloud Run copy is the public demo sandbox only (fictional Maple
  Grove / Rivera data). Real profiles live in the local Docker run.

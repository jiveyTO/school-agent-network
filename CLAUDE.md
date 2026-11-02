# CLAUDE.md — school-agent-network (ParentLoop)

## Standing rule (owner-set, until revoked)

When a piece of work is finished and the full suite passes (`node --test test/`
green in the school-agent container): commit it, push to origin main, and
redeploy to Cloud Run — without asking first. Then report the commit hash,
test count, and Cloud Run revision. If tests fail, stop and report instead.

## Deploy recipe

From the project root, stage a clean copy (no `.env`, `.git`,
`data/app.db`, `node_modules`) into `unified-dev-env` at
`/tmp/parentloop-deploy`, copy `.env` in separately, then run the deploy
from inside that directory:

```sh
set -a; . ./.env; set +a
for v in SCHOOL_AGENT_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APP_DB_GCS_BUCKET APP_DB_GCS_OBJECT; do
  eval "[ -n \"\$$v\" ]" || { echo "missing $v in .env"; exit 1; }
done
PAIRS=""
for k in $(grep -oE '^[A-Z_]+=' .env | tr -d '='); do
  eval "v=\$$k"; PAIRS="$PAIRS$k=$v,"
done
for v in SCHOOL_AGENT_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APP_DB_GCS_BUCKET APP_DB_GCS_OBJECT; do
  case "$PAIRS" in "$v="*|*",$v="*) ;; *) echo "missing $v in PAIRS"; exit 1;; esac
done
gcloud run deploy parentloop --source . --project=school-agent-network \
  --region=northamerica-northeast2 --allow-unauthenticated --max-instances=1 \
  --port=3000 \
  --set-env-vars "${PAIRS}PUBLIC_BASE_URL=https://parentloop-964717527488.northamerica-northeast2.run.app"
```

Rules (learned from brief 016, which broke live Google sign-in):

- The `--set-env-vars` value is always built mechanically from EVERY key in
  the project `.env` (at minimum `SCHOOL_AGENT_API_KEY`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_DB_GCS_BUCKET`,
  `APP_DB_GCS_OBJECT`) plus the hardcoded public
  `PUBLIC_BASE_URL`. Never deploy with a hand-written partial variable
  list, and never use a carry-forward list that enumerates only some
  variables — brief 016's deploy carried forward only
  `SCHOOL_AGENT_API_KEY`, silently dropping the Google vars, and
  revisions 00022–00025 repeated the same failure mode for the durable
  store vars (`APP_DB_GCS_BUCKET` / `APP_DB_GCS_OBJECT`, brief 021).
- The key-extraction pattern must stay portable: `grep -oE '^[A-Z_]+='
  ... | tr -d '='`. The old `(?==)` lookahead is unsupported by both BSD
  and GNU grep, silently matched nothing, and revision 00026 shipped with
  only `PUBLIC_BASE_URL` (auth + API key + durable vars all dropped). The
  `case` check on `PAIRS` aborts the deploy if any required name is
  missing from the built value — never remove it.

Read secrets only from the local `.env` inside the deploy container; never
print them. Remove `/tmp/parentloop-deploy` afterwards.

## Post-deploy gate (required before any deploy is reported done)

1. `GET /api/auth/status` returns `configured: true`.
2. `GET /api/auth/login` returns HTTP 302 to Google with the hosted
   callback URI.
3. Demo evening check still exactly 2 nudges, 3 conflicts, 28 relevant,
   1 set aside, PRIVACY CHECK line present.
4. Durability: boot logs show the durable store restore line (e.g.
   "database restored from hosted storage") and the ENGAGED line, and a
   fresh Google sign-in restores the account's family (not demo).

## Privacy (hard rules)

- The `data/app.db`, `.env`, and `data/sample-newsletter.txt` files are never
  committed, never enter the container image, and real family/newsletter data
  never appears in fixtures, placeholders, docs, or tests.
- The hosted Cloud Run copy is the public demo sandbox only (fictional Maple
  Grove / Rivera data). Real profiles live in the local Docker run.

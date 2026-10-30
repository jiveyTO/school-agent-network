# Classroom Auth Probe (throwaway)

Tests one question only: can a school-managed student Google account authorize this project's existing OAuth client to read that student's Google Classroom data, read-only?

This is a test spike. It is not wired into the app, stores nothing, and the whole `probe/` folder is disposable — delete it when the question is answered.

## Run it

```sh
node probe/classroom-auth-test.js
```

Open the printed Google sign-in URL and sign in with the **student's school account** (the account that actually has the classes). The probe prints the course count and names, then — for the first active course — coursework and announcement counts plus up to 3 coursework titles with due dates, and ends with exactly one verdict line: `VERDICT: WORKS`, `VERDICT: BLOCKED` (with Google's exact error), or `VERDICT: ERROR`.

Tokens live in memory only and are discarded when the script exits. Nothing is written to any file. Please do not copy terminal output with real class or assignment names into the build log — it is private test data.

## Registrations it depends on

1. **Classroom API enabled** in Google Cloud project `school-agent-network`.
2. **Redirect URI registered** on the project's OAuth client (the same client as the Gmail flow): `http://127.0.0.1:3001/classroom-probe/callback`

The probe reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the project's existing `.env` and never prints or saves them.

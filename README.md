# Mathwhiz AI Assistant Teacher: brain service

The "brain" service behind the Mathwhiz Academy AI Assistant Teacher. It
drives a Recall.ai meeting bot that joins a Zoom class as its own labelled
participant, "Assistant Teacher (AI)". During the class it tracks
participation, runs teacher-triggered check-ins that students answer by
direct message, privately nudges the teacher about silent students, and
flags safeguarding concerns to the teacher. At class end it compiles a
participation DRAFT and posts it to the Mathwhiz platform
(`POST /api/assistant/participation`) for the teacher to review and approve.
It never posts straight to a student's record.

Version 1 is rule-based: check-ins, nudges and templated replies. No LLM is
involved in the pilot.

## Run it

```bash
npm install
npm run build
npm start        # node dist/index.js, listens on process.env.PORT (default 8787)
```

Other scripts:

- `npm run demo` runs a fully local end-to-end demo (mock Recall harness
  plus a stub platform endpoint). No external calls, no credentials needed.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run bot:create-test -- <meeting-url>` creates a real Recall test bot
  for a live smoke test (needs the Recall env vars set).

HTTP surface:

- `POST /recall/webhook` receives Recall realtime and bot status webhooks.
  Every payload is signature-verified against the workspace verification
  secret; unverifiable payloads are rejected with 401.
- `POST /admin/start-session` and `POST /admin/end-session` drive a class
  session. Protect these at the host layer before any real deploy.

## Environment variables

All configuration comes from environment variables at runtime. No secret is
ever stored in this repo. Names only:

| Variable | Purpose |
| --- | --- |
| `RECALL_API_KEY` | Recall.ai workspace API key, sent as `Authorization: Token <key>`. |
| `RECALL_REGION` | Recall workspace region; fixes the API base host. Mathwhiz: `us-west-2`. |
| `RECALL_WEBHOOK_SECRET` | Recall workspace verification secret (`whsec_...`) used to verify webhook signatures. Webhooks fail closed without it. |
| `RECALL_REALTIME_MODE` | Live event delivery mode. Only `webhook` is implemented. |
| `PUBLIC_BASE_URL` | Public https URL of this service; Recall posts webhooks to `PUBLIC_BASE_URL/recall/webhook`. |
| `PLATFORM_BASE_URL` | Mathwhiz platform base URL. Default `https://app.mathwhizacademy.com`. |
| `MATHWHIZ_ASSISTANT_SECRET` | The platform's assistant secret, sent as the `x-mathwhiz-assistant-secret` header. Injected from the secret store at deploy time. |
| `BOT_DISPLAY_NAME` | The bot's in-meeting display name. Default `Assistant Teacher (AI)`. |
| `TRANSCRIPT_PROVIDER` | `recallai_streaming` (default) or `meeting_captions`. |
| `PORT` | HTTP listen port. Default `8787`. |

See `.env.example` for the template.

## Deploy on Railway

1. Create a new service in Railway from this GitHub repo. Railway detects
   Node, runs `npm install` and `npm run build`, and starts the service
   with `npm start`. Railway sets `PORT` automatically.
2. Set every environment variable listed above on the service.
3. Generate a public domain for the service (Settings, Networking,
   Generate Domain).
4. Set `PUBLIC_BASE_URL` to that domain (for example
   `https://<service>.up.railway.app`), with no trailing path. Recall posts
   webhooks to `PUBLIC_BASE_URL/recall/webhook`, so it must be the exact
   public address of the service.

// Configuration for the brain service. EVERYTHING comes from environment
// variables at runtime; no secret is ever written to a file in this repo,
// logged, or given a default. Missing required values fail fast at startup
// rather than halfway through a live class.
//
// Environment variables (see .env.example for the template, names only):
//
//   RECALL_API_KEY            REQUIRED (server + bot:create-test only).
//                             The Recall.ai workspace API key. Sent as
//                             `Authorization: Token <key>`. Custody: the
//                             secure vault / the host's env at deploy time.
//                             Never in chat, never in this repo.
//   RECALL_REGION             Recall workspace region; fixes the API base
//                             host https://{region}.recall.ai/api/v1.
//                             The Mathwhiz workspace is us-west-2 (verified
//                             Oct 26, 2026), which is the default.
//   RECALL_WEBHOOK_SECRET     REQUIRED (server only). The Recall WORKSPACE
//                             VERIFICATION SECRET, created in the Recall
//                             dashboard under Developers, API Keys &
//                             Secrets, Create Workspace Secret; format
//                             "whsec_...". Recall only sends the webhook-*
//                             signature headers once that secret exists,
//                             and /recall/webhook fails closed on any
//                             payload it cannot verify with this.
//   RECALL_REALTIME_MODE      How Recall streams live events to the brain.
//                             "webhook" (the pilot mode): each bot is
//                             created with a realtime_endpoints webhook
//                             pointing at PUBLIC_BASE_URL/recall/webhook.
//                             No other mode is implemented in the pilot;
//                             any other value fails fast at startup.
//   PUBLIC_BASE_URL           REQUIRED (server only). Public https URL of
//                             this service; Recall posts realtime webhooks
//                             and bot status changes to it.
//   PLATFORM_BASE_URL         Mathwhiz platform base URL. Default
//                             https://app.mathwhizacademy.com. The draft
//                             endpoint is {base}/api/assistant/participation.
//   MATHWHIZ_ASSISTANT_SECRET REQUIRED (server only). The platform
//                             assistant secret, sent as the
//                             x-mathwhiz-assistant-secret header. This is a
//                             REFERENCE to the platform's existing secret,
//                             held in the secret store and injected via
//                             env at deploy; it is not a new secret and
//                             must never be copied into this repo.
//   PORT                      HTTP listen port. Default 8787.
//   BOT_DISPLAY_NAME          The bot's labelled in-meeting name. Default
//                             "Assistant Teacher (AI)". It is the bot's own
//                             identity; never a teacher's name.
//   TRANSCRIPT_PROVIDER       "recallai_streaming" (pilot default) or
//                             "meeting_captions" (Zoom's built-in captions;
//                             kept as a config switch, not the default).

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type RealtimeMode = "webhook";

export interface ServiceConfig {
  port: number;
  publicBaseUrl: string; // public URL of this service, used as the Recall realtime webhook target
  botDisplayName: string;
  transcriptProvider: "recallai_streaming" | "meeting_captions";
  recall: {
    apiKey: string;
    region: string; // Recall workspace region; Mathwhiz workspace is "us-west-2"
    webhookSecret: string; // workspace verification secret (whsec_...), for verifying realtime webhooks
    realtimeMode: RealtimeMode; // pilot: "webhook" only
  };
  platform: {
    baseUrl: string;
    assistantSecret: string; // sent as x-mathwhiz-assistant-secret
  };
}

function realtimeMode(): RealtimeMode {
  const v = process.env.RECALL_REALTIME_MODE ?? "webhook";
  if (v !== "webhook") {
    throw new Error(`Unsupported RECALL_REALTIME_MODE: ${v} (the pilot implements "webhook" only)`);
  }
  return v;
}

export function loadConfig(): ServiceConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    publicBaseUrl: required("PUBLIC_BASE_URL"),
    botDisplayName: process.env.BOT_DISPLAY_NAME ?? "Assistant Teacher (AI)",
    transcriptProvider:
      (process.env.TRANSCRIPT_PROVIDER as ServiceConfig["transcriptProvider"]) ??
      "recallai_streaming",
    recall: {
      apiKey: required("RECALL_API_KEY"),
      region: process.env.RECALL_REGION ?? "us-west-2",
      webhookSecret: required("RECALL_WEBHOOK_SECRET"),
      realtimeMode: realtimeMode(),
    },
    platform: {
      baseUrl: process.env.PLATFORM_BASE_URL ?? "https://app.mathwhizacademy.com",
      assistantSecret: required("MATHWHIZ_ASSISTANT_SECRET"),
    },
  };
}

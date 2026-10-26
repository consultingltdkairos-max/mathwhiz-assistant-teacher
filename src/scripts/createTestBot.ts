// bot:create-test — create ONE Recall bot for a test meeting and print
// only its bot id and status. This is the live-session smoke test for the
// Recall wiring (Stage 0); it is run BY HAND, in a live session, never by
// the demo and never in CI.
//
//   RECALL_API_KEY=<from vault> npm run bot:create-test -- <meeting-url> [join-at-iso]
//
// - The API key is read from the RECALL_API_KEY environment variable at
//   run time ONLY. It is never printed, never logged, and never written
//   to a file by this script.
// - RECALL_REGION defaults to us-west-2 (the Mathwhiz workspace region).
// - PUBLIC_BASE_URL is used for the bot's realtime webhook target; if it
//   is not publicly reachable, the bot still joins and announces itself,
//   but no realtime events will arrive. A loopback default is used when
//   unset, and a note is printed.
// - No other env vars are required: this script does not start the
//   server, does not verify webhooks, and does not touch the platform.

import { randomUUID } from "node:crypto";
import type { ServiceConfig } from "../config.js";
import { RecallBotProvider } from "../bot/RecallBotProvider.js";
import { JOIN_ANNOUNCEMENT } from "../brain/SessionManager.js";

async function main(): Promise<void> {
  const [meetingUrl, joinAtArg] = process.argv.slice(2);
  if (!meetingUrl) {
    console.error("usage: npm run bot:create-test -- <meeting-url> [join-at-iso]");
    process.exitCode = 2;
    return;
  }

  const apiKey = process.env.RECALL_API_KEY;
  if (!apiKey) {
    console.error("RECALL_API_KEY is not set. Export it from the vault for this shell only; do not write it to a file.");
    process.exitCode = 2;
    return;
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787";
  if (!process.env.PUBLIC_BASE_URL) {
    console.log("note: PUBLIC_BASE_URL is unset; using a loopback webhook target, so realtime events will not be delivered.");
  }

  const cfg: ServiceConfig = {
    port: 0,
    publicBaseUrl,
    botDisplayName: process.env.BOT_DISPLAY_NAME ?? "Assistant Teacher (AI)",
    transcriptProvider: "recallai_streaming",
    recall: {
      apiKey,
      region: process.env.RECALL_REGION ?? "us-west-2",
      webhookSecret: "", // not used by create/retrieve calls
      realtimeMode: "webhook",
    },
    platform: { baseUrl: "", assistantSecret: "" }, // not used by this script
  };

  const provider = new RecallBotProvider(cfg);
  const joinAt = joinAtArg ?? new Date(Date.now() + 60_000).toISOString();
  const session = await provider.createBot({
    sessionId: randomUUID(),
    meetingUrl,
    joinAt,
    botName: cfg.botDisplayName,
    joinAnnouncement: JOIN_ANNOUNCEMENT,
  });
  const { status } = await provider.retrieveBotStatus(session.botId);
  // Bot id and status ONLY. Never the key, never request headers.
  console.log(`bot_id: ${session.botId}`);
  console.log(`status: ${status}`);
}

main().catch((err) => {
  console.error(`bot:create-test failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

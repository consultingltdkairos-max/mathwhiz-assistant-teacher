// Regression check for RecallBotProvider.translateWebhook against the
// REAL realtime webhook envelope, captured live on Oct 28, 2026 (Stage 0
// test, bot dd310230) and cross-checked against Recall's Receiving Chat
// Messages documentation. The demo suite emits BotEvents directly and
// never exercises this translation, which is how the chat nesting bug
// (text/to read one level too shallow, every live chat message dropped)
// survived 78 passing assertions. Run: npx tsx src/scripts/verifyTranslate.ts
import { RecallBotProvider } from "../bot/RecallBotProvider.js";
import type { ServiceConfig } from "../config.js";

const cfg: ServiceConfig = {
  port: 8080,
  publicBaseUrl: "https://example.invalid",
  botDisplayName: "Assistant Teacher (AI)",
  transcriptProvider: "recallai_streaming",
  recall: { apiKey: "test", region: "us-west-2", webhookSecret: "whsec_test", realtimeMode: "webhook" },
  platform: { baseUrl: "https://example.invalid", assistantSecret: "test" },
};
const bot = new RecallBotProvider(cfg);

function envelope(event: string, participant: object, innerData: object | null): string {
  return JSON.stringify({
    event,
    data: {
      data: { participant, timestamp: { absolute: "2026-10-28T21:57:26.062172Z", relative: 16.0 }, data: innerData },
      realtime_endpoint: { id: "rt", metadata: {} },
      bot: { id: "dd310230-e4c8-4b22-8588-85a56f4d8370", metadata: {} },
    },
  });
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failures += 1;
}

// 1. Teacher ANSWER command DM, exactly as captured live.
const teacher = bot.translateWebhook(
  envelope("participant_events.chat_message", { id: 100, name: "Mathwhiz Answers", is_host: true }, { text: "ANSWER | 5 | mode: hint", to: "only_bot" }),
);
check(
  "teacher DM translates",
  !!teacher && teacher.length === 1 && teacher[0].type === "chat_message" && teacher[0].text === "ANSWER | 5 | mode: hint" && (teacher[0] as any).to === "bot" && teacher[0].participantId === "100",
  JSON.stringify(teacher),
);

// 2. Student answer DM, exactly as captured live.
const student = bot.translateWebhook(
  envelope("participant_events.chat_message", { id: 200, name: "Test Student", is_host: false }, { text: "5", to: "only_bot" }),
);
check(
  "student DM translates",
  !!student && student.length === 1 && student[0].type === "chat_message" && student[0].text === "5" && student[0].participantId === "200",
  JSON.stringify(student),
);

// 3. Public chat message stays public.
const pub = bot.translateWebhook(
  envelope("participant_events.chat_message", { id: 200, name: "Test Student", is_host: false }, { text: "hello everyone", to: "everyone" }),
);
check("public chat translates", !!pub && pub.length === 1 && (pub[0] as any).to === "everyone", JSON.stringify(pub));

// 4. Join event carries the host flag (teacher identification depends on it).
const join = bot.translateWebhook(
  envelope("participant_events.join", { id: 100, name: "Mathwhiz Answers", is_host: true }, null),
);
check(
  "join translates with isHost",
  !!join && join.length === 1 && join[0].type === "participant_joined" && (join[0] as any).isHost === true,
  JSON.stringify(join),
);

console.log(failures === 0 ? "ALL TRANSLATE CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

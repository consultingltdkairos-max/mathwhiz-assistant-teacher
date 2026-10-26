// LOCAL END-TO-END DEMO of the AI Assistant Teacher brain service.
// No external calls, no credentials, no real data: a MockBotProvider
// plays Recall.ai, a StubPlatform plays the platform endpoint and
// validates the payload against the brief's contract, and a fake clock
// compresses a 90-minute class into seconds.
//
// Run: npm run demo   (or npm run test:e2e)
// Exit code 0 only if every scenario assertion passes.
//
// All names and IDs below are invented fixtures.

import { createHmac } from "node:crypto";
import { PlatformClient } from "../platform/PlatformClient.js";
import { RecallBotProvider, type FetchImpl } from "../bot/RecallBotProvider.js";
import { JOIN_ANNOUNCEMENT, SessionManager } from "../brain/SessionManager.js";
import type { ServiceConfig } from "../config.js";
import type { SessionContext } from "../types.js";
import { MockBotProvider } from "./mockBot.js";
import { StubPlatform } from "./stubPlatform.js";

const DEMO_SECRET = "demo-secret-not-a-real-credential";
const MIN = 60 * 1000;

// ---- fake clock: SessionManager/SignalTracker/NudgeEngine all read
// Date.now(), so one override drives the whole class deterministically.
let fakeNow = Date.parse("2026-10-26T15:00:00.000Z");
Date.now = () => fakeNow;
const advance = (ms: number) => {
  fakeNow += ms;
};

const trace = (line: string) => console.log(line);
const heading = (s: string) => console.log(`\n=== ${s} ===`);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures += 1;
}

// ---- fixtures (invented) ----
const SESSION_1 = "55555555-5555-4555-8555-555555555555";
const SESSION_2 = "66666666-6666-4666-8666-666666666666";
const SESSION_3 = "88888888-8888-4888-8888-888888888888";
const COHORT = "77777777-7777-4777-8777-777777777777";
const AMARA = "11111111-1111-4111-8111-111111111111";
const DEVONTE = "22222222-2222-4222-8222-222222222222";
const KEZIA = "33333333-3333-4333-8333-333333333333";
const SHANICE = "44444444-4444-4444-8444-444444444444";

function roster() {
  return [
    { studentId: AMARA, displayNames: ["Amara Reid"] },
    { studentId: DEVONTE, displayNames: ["Devonte Cole"] },
    { studentId: KEZIA, displayNames: ["Kezia Brown"] },
    { studentId: SHANICE, displayNames: ["Shanice Pryce"] },
  ];
}

function makeConfig(stubUrl: string): ServiceConfig {
  return {
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    botDisplayName: "Assistant Teacher (AI)",
    transcriptProvider: "recallai_streaming",
    recall: { apiKey: "unused-in-demo", region: "us-west-2", webhookSecret: "unused-in-demo", realtimeMode: "webhook" },
    platform: { baseUrl: stubUrl, assistantSecret: DEMO_SECRET },
  };
}

async function main(): Promise<void> {
  const stub = new StubPlatform(DEMO_SECRET, trace);
  const stubUrl = await stub.start();
  trace(`[stub] platform stub listening at ${stubUrl} (validates the brief contract)`);
  const platform = new PlatformClient(makeConfig(stubUrl));

  // ================================================================
  heading("SCENARIO 1: a full short class, bot admitted");
  // ================================================================
  fakeNow = Date.parse("2026-10-26T15:00:00.000Z");
  const bot1 = new MockBotProvider(trace);
  const ctx1: SessionContext = {
    sessionId: SESSION_1,
    cohortId: COHORT,
    meetingUrl: "https://zoom.us/j/00000000000",
    joinAt: new Date(fakeNow).toISOString(),
    teacherParticipantId: null,
    roster: roster(),
  };
  const mgr1 = new SessionManager(ctx1, bot1, platform);
  bot1.onEvent((botId, ev) => mgr1.handleEvent(botId, ev));
  await mgr1.start();

  await bot1.emit({ type: "bot_status", status: "joining" });
  await bot1.emit({ type: "bot_status", status: "in_waiting_room" });
  advance(1 * MIN);
  await bot1.emit({ type: "bot_status", status: "in_call" });
  await bot1.emit({ type: "participant_joined", participantId: "p-teacher", name: "Ms Rose Clarke", isHost: true });
  advance(1 * MIN);
  await bot1.emit({ type: "participant_joined", participantId: "p-amara", name: "Amara Reid", isHost: false });
  await bot1.emit({ type: "participant_joined", participantId: "p-devonte", name: "Devonte Cole", isHost: false });
  await bot1.emit({ type: "participant_joined", participantId: "p-kezia", name: "Kezia Brown", isHost: false });
  // Roster-name mismatch: roster expects "Shanice Pryce", she joins as "Shanice P."
  await bot1.emit({ type: "participant_joined", participantId: "p-shanice", name: "Shanice P.", isHost: false });

  advance(1 * MIN); // t+3
  await bot1.emit({ type: "transcript", participantId: "p-amara", name: "Amara Reid", text: "Miss, do we move the 3 to the other side first?", timestamp: fakeNow });
  await bot1.emit({ type: "transcript", participantId: "p-devonte", name: "Devonte Cole", text: "I got stuck on the first step.", timestamp: fakeNow });

  advance(2 * MIN); // t+5: teacher opens a hint-mode check-in by DM
  await bot1.emit({ type: "chat_message", participantId: "p-teacher", name: "Ms Rose Clarke", to: "bot", text: "CHECKIN | What is x if 2x + 3 = 17? | x = 7 | mode: hint", timestamp: fakeNow });

  advance(1 * MIN); // t+6: Amara answers publicly while the check-in is open
  await bot1.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "everyone", text: "I think it is 7", timestamp: fakeNow });

  advance(1 * MIN); // t+7: private answers by DM
  await bot1.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "bot", text: "x = 7", timestamp: fakeNow });
  await bot1.emit({ type: "chat_message", participantId: "p-devonte", name: "Devonte Cole", to: "bot", text: "x = 5", timestamp: fakeNow });

  advance(0.5 * MIN); // t+7.5: Devonte uses his one hint-mode retry and gets it right,
  // then replies once more; the extra reply must be ignored for scoring
  await bot1.emit({ type: "chat_message", participantId: "p-devonte", name: "Devonte Cole", to: "bot", text: "x = 7", timestamp: fakeNow });
  await bot1.emit({ type: "chat_message", participantId: "p-devonte", name: "Devonte Cole", to: "bot", text: "x = 7", timestamp: fakeNow });

  advance(0.5 * MIN); // t+8: the unmatched student answers too; nothing may be recorded
  await bot1.emit({ type: "chat_message", participantId: "p-shanice", name: "Shanice P.", to: "bot", text: "x = 7", timestamp: fakeNow });

  advance(2 * MIN); // t+10: tick closes the check-in window -> tally + non-responder nudge
  trace("-- tick (check-in window expired)");
  await mgr1.tick();

  advance(2 * MIN); // t+12: scripted safeguarding-style message from a matched student
  await bot1.emit({ type: "chat_message", participantId: "p-devonte", name: "Devonte Cole", to: "bot", text: "I feel hopeless and I can't cope with anything anymore", timestamp: fakeNow });

  advance(3 * MIN); // t+15: a private maths question (check-in closed)
  await bot1.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "bot", text: "How do I factorise x^2 + 5x + 6?", timestamp: fakeNow });

  advance(20 * MIN); // t+35: Amara speaks in the middle segment
  await bot1.emit({ type: "transcript", participantId: "p-amara", name: "Amara Reid", text: "So the two numbers are 2 and 3 because they add to 5.", timestamp: fakeNow });

  advance(15 * MIN); // t+50: tick -> silence nudge for Kezia (late segment)
  trace("-- tick (50 minutes in)");
  await mgr1.tick();

  advance(20 * MIN); // t+70: Amara speaks in the late segment
  await bot1.emit({ type: "transcript", participantId: "p-amara", name: "Amara Reid", text: "Can I try the next one, Miss?", timestamp: fakeNow });

  advance(10 * MIN); // t+80: host ends the meeting -> compile + post draft
  await bot1.emit({ type: "bot_status", status: "call_ended" });

  heading("Scenario 1: assertions");
  const p1 = stub.received.find((p) => p.session_id === SESSION_1);
  check("draft payload reached the stub", !!p1);
  if (p1) {
    console.log("\nFinal payload (scenario 1):\n" + JSON.stringify(p1, null, 2));
    check("assistant_present is true", p1.assistant_present === true);
    check("one entry per roster student", p1.entries.length === 4);
    const amara = p1.entries.find((e) => e.student_id === AMARA)!;
    check("Amara speaking_turns = 3", amara.evidence.speaking_turns === 3);
    check(
      "Amara segments early+middle+late",
      JSON.stringify(amara.evidence.speaking_segments) === JSON.stringify(["early", "middle", "late"]),
      amara.evidence.speaking_segments.join(","),
    );
    check("Amara chat_public = 1, chat_answers = 1", amara.evidence.chat_public === 1 && amara.evidence.chat_answers === 1);
    check("Amara check-in answered = 1", amara.evidence.checkins_answered === 1);
    check("Amara private_questions = 1", amara.evidence.private_questions === 1);
    check(
      "Amara gets the em-dash chat indicator",
      amara.indicators.includes("Very active — regularly participates through chat"),
    );
    check("Amara gets Attempts + Asks questions", amara.indicators.includes("Attempts questions even when unsure") && amara.indicators.includes("Asks questions when clarification is needed"));
    const devonte = p1.entries.find((e) => e.student_id === DEVONTE)!;
    check("Devonte check-in answered = 1 (wrong reply + correct retry + extra reply count once)", devonte.evidence.checkins_answered === 1);
    check("Devonte extra reply was not a private question", devonte.evidence.private_questions === 0);
    check("Devonte indicator: Participates when called upon", devonte.indicators.includes("Participates when called upon"));
    const kezia = p1.entries.find((e) => e.student_id === KEZIA)!;
    check("Kezia nudges_sent = 2 (check-in + silence)", kezia.evidence.nudges_sent === 2, `got ${kezia.evidence.nudges_sent}`);
    check("Kezia indicator: Limited participation", kezia.indicators.includes("Limited participation during class"));
    check("Kezia gap asks teacher to confirm", kezia.data_gaps.some((g) => g.includes("teacher to confirm")));
    const shanice = p1.entries.find((e) => e.student_id === SHANICE)!;
    check("Shanice match_confidence = unmatched", shanice.evidence.match_confidence === "unmatched");
    check("Shanice flagged in data gaps, not guessed", shanice.data_gaps.length >= 2, shanice.data_gaps.join(" ; "));
  }
  const out = bot1.sent;
  check("hint DM went to Devonte", out.some((m) => m.kind === "dm" && m.toParticipantId === "p-devonte" && m.message.startsWith("Not quite")));
  check("correct-with-hint reply DM went to Devonte", out.some((m) => m.kind === "dm" && m.toParticipantId === "p-devonte" && m.message.includes("with the hint")));
  check("extra reply from Devonte got the already-answered reply", out.some((m) => m.kind === "dm" && m.toParticipantId === "p-devonte" && m.message.includes("already have your answer")));
  check("correct reply DM went to Amara", out.some((m) => m.kind === "dm" && m.toParticipantId === "p-amara" && (m.message.startsWith("Yes") || m.message.startsWith("Correct"))));
  check("check-in tally DM went to teacher, hint correct counted separately", out.some((m) => m.toParticipantId === "p-teacher" && m.message.includes("Check in closed: 2 answered, 1 correct, 1 correct with a hint")));
  check("safeguarding flag DM went to teacher", out.some((m) => m.toParticipantId === "p-teacher" && m.message.includes("Please check in with Devonte Cole")));
  check("kind safeguarding reply went to Devonte", out.some((m) => m.toParticipantId === "p-devonte" && m.message.includes("trusted adult")));
  check("silence nudge for Kezia went to teacher", out.some((m) => m.toParticipantId === "p-teacher" && m.message.includes("Haven't heard from Kezia Brown")));
  check("unmatched student got the generic reply only", out.some((m) => m.toParticipantId === "p-shanice" && m.message.includes("could not match your name")));

  // ================================================================
  heading("SCENARIO 2: bot never admitted (assistant absent)");
  // ================================================================
  fakeNow = Date.parse("2026-10-27T15:00:00.000Z");
  const bot2 = new MockBotProvider(trace);
  const ctx2: SessionContext = {
    sessionId: SESSION_2,
    cohortId: COHORT,
    meetingUrl: "https://zoom.us/j/00000000000",
    joinAt: new Date(fakeNow).toISOString(),
    teacherParticipantId: null,
    roster: roster().slice(0, 2),
  };
  const mgr2 = new SessionManager(ctx2, bot2, platform);
  bot2.onEvent((botId, ev) => mgr2.handleEvent(botId, ev));
  await mgr2.start();
  await bot2.emit({ type: "bot_status", status: "joining" });
  await bot2.emit({ type: "bot_status", status: "in_waiting_room" });
  advance(45 * MIN); // sits in the waiting room; host ends the meeting
  await bot2.emit({ type: "bot_status", status: "call_ended" });

  heading("Scenario 2: assertions");
  const p2 = stub.received.find((p) => p.session_id === SESSION_2);
  check("absent payload reached the stub", !!p2);
  if (p2) {
    console.log("\nFinal payload (scenario 2):\n" + JSON.stringify(p2, null, 2));
    check("assistant_present is false", p2.assistant_present === false);
    check("every entry has empty indicators", p2.entries.every((e) => e.indicators.length === 0));
    check(
      "every entry states the assistant-absent gap",
      p2.entries.every((e) => e.data_gaps.includes("Assistant not present this session, enter manually")),
    );
  }

  // ================================================================
  heading("SCENARIO 3: stub contract probes (rejection paths)");
  // ================================================================
  const base = `${stubUrl}/api/assistant/participation`;
  const headers = { "content-type": "application/json", "x-mathwhiz-assistant-secret": DEMO_SECRET };
  const goodEvidence = {
    speaking_turns: 0, speaking_segments: [], chat_public: 0, chat_answers: 0,
    chat_questions: 0, checkins_sent: 0, checkins_answered: 0, private_questions: 0,
    nudges_sent: 0, match_confidence: "high",
  };
  const probe = async (label: string, hdrs: Record<string, string>, payload: unknown) => {
    const res = await fetch(base, { method: "POST", headers: hdrs, body: JSON.stringify(payload) });
    const body = (await res.json()) as Record<string, unknown>;
    trace(`[probe] ${label} -> ${res.status} ${JSON.stringify(body)}`);
    return { status: res.status, body };
  };
  const noSecret = await probe("missing secret", { "content-type": "application/json" }, { session_id: SESSION_1, source: "assistant_teacher_v1", assistant_present: true, entries: [{ student_id: AMARA, indicators: [], evidence: goodEvidence, data_gaps: [] }] });
  check("missing secret -> 401", noSecret.status === 401);
  const scoreProbe = await probe("entry carrying participation_score", headers, { session_id: SESSION_1, source: "assistant_teacher_v1", assistant_present: true, entries: [{ student_id: AMARA, indicators: [], evidence: goodEvidence, data_gaps: [], participation_score: 80 }] });
  const skips1 = (scoreProbe.body.skipped ?? []) as { reason: string }[];
  check("score field -> entry rejected with reason", scoreProbe.status === 200 && skips1.length === 1 && skips1[0].reason.includes("forbidden field"));
  const badIndicator = await probe("entry with unknown indicator", headers, { session_id: SESSION_1, source: "assistant_teacher_v1", assistant_present: true, entries: [{ student_id: AMARA, indicators: ["Superstar student"], evidence: goodEvidence, data_gaps: [] }] });
  const skips2 = (badIndicator.body.skipped ?? []) as { reason: string }[];
  check("unknown indicator -> entry skipped with reason", badIndicator.status === 200 && skips2.length === 1 && skips2[0].reason.includes("unknown indicator"));
  const absentBad = await probe("assistant_present=false but indicators present", headers, { session_id: SESSION_2, source: "assistant_teacher_v1", assistant_present: false, entries: [{ student_id: AMARA, indicators: ["Limited participation during class"], evidence: goodEvidence, data_gaps: [] }] });
  check("absent + indicators -> 400", absentBad.status === 400);

  // ================================================================
  heading("SCENARIO 4: hint-mode retry, wrong retry closes the question");
  // ================================================================
  fakeNow = Date.parse("2026-10-28T15:00:00.000Z");
  const bot4 = new MockBotProvider(trace);
  const ctx4: SessionContext = {
    sessionId: SESSION_3,
    cohortId: COHORT,
    meetingUrl: "https://zoom.us/j/00000000000",
    joinAt: new Date(fakeNow).toISOString(),
    teacherParticipantId: null,
    roster: roster().slice(0, 2), // Amara + Devonte
  };
  const mgr4 = new SessionManager(ctx4, bot4, platform);
  bot4.onEvent((botId, ev) => mgr4.handleEvent(botId, ev));
  await mgr4.start();
  await bot4.emit({ type: "bot_status", status: "in_call" });
  await bot4.emit({ type: "participant_joined", participantId: "p-teacher", name: "Ms Rose Clarke", isHost: true });
  await bot4.emit({ type: "participant_joined", participantId: "p-amara", name: "Amara Reid", isHost: false });
  await bot4.emit({ type: "participant_joined", participantId: "p-devonte", name: "Devonte Cole", isHost: false });

  advance(5 * MIN); // teacher opens a hint-mode check-in: 3x = 12, so x = 4
  await bot4.emit({ type: "chat_message", participantId: "p-teacher", name: "Ms Rose Clarke", to: "bot", text: "CHECKIN | What is x if 3x = 12? | x = 4 | mode: hint", timestamp: fakeNow });

  advance(1 * MIN); // both answer wrong and get the hint
  await bot4.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "bot", text: "x = 3", timestamp: fakeNow });
  await bot4.emit({ type: "chat_message", participantId: "p-devonte", name: "Devonte Cole", to: "bot", text: "x = 3", timestamp: fakeNow });

  advance(1 * MIN); // Amara retries wrong (question closes for her), then sends the
  // right value anyway; too late, it must be ignored for scoring.
  // Devonte takes the hint but never retries.
  await bot4.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "bot", text: "x = 5", timestamp: fakeNow });
  await bot4.emit({ type: "chat_message", participantId: "p-amara", name: "Amara Reid", to: "bot", text: "x = 4", timestamp: fakeNow });

  advance(2 * MIN); // past the 3-minute window
  trace("-- tick (check-in window expired)");
  await mgr4.tick();

  advance(1 * MIN); // host ends the meeting -> compile + post draft
  await bot4.emit({ type: "bot_status", status: "call_ended" });

  heading("Scenario 4: assertions");
  const p4 = stub.received.find((p) => p.session_id === SESSION_3);
  check("scenario 4 payload reached the stub", !!p4);
  if (p4) {
    const a4 = p4.entries.find((e) => e.student_id === AMARA)!;
    check("Amara check-ins sent = 1, answered = 1 (wrong retry not double-counted)", a4.evidence.checkins_sent === 1 && a4.evidence.checkins_answered === 1);
    check("Amara third reply was not a private question", a4.evidence.private_questions === 0);
    check("Amara indicator: Participates when called upon", a4.indicators.includes("Participates when called upon"));
    const d4 = p4.entries.find((e) => e.student_id === DEVONTE)!;
    check("Devonte answered = 1 (hint taken, no retry, settles incorrect)", d4.evidence.checkins_answered === 1);
  }
  const out4 = bot4.sent;
  check("tally: 2 answered, 0 correct, no hint credit", out4.some((m) => m.toParticipantId === "p-teacher" && m.message.includes("Check in closed: 2 answered, 0 correct.")));
  check("wrong retry closed the question for Amara", out4.some((m) => m.toParticipantId === "p-amara" && m.message.includes("closes this check in")));
  check("third reply got the already-answered reply", out4.some((m) => m.toParticipantId === "p-amara" && m.message.includes("already have your answer")));
  check("no non-responder nudge for Amara or Devonte", !out4.some((m) => m.toParticipantId === "p-teacher" && (m.message.includes("No response from Amara") || m.message.includes("No response from Devonte"))));

  // ================================================================
  heading("SCENARIO 5: real RecallBotProvider, fake HTTP layer");
  // ================================================================
  // The REAL provider class, driven against a fake fetch that records
  // every request and returns canned Recall-shaped responses. This pins
  // the exact create-bot URL, headers and body the live API will
  // receive, with NO network call and NO real credential (dummy key).
  const DUMMY_KEY = "DUMMY-KEY-FOR-TESTS";
  interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
  }
  const calls: RecordedCall[] = [];
  const fakeFetch: FetchImpl = async (input: any, init: any = {}) => {
    const url = String(input);
    const method: string = init.method ?? "GET";
    calls.push({
      url,
      method,
      headers: { ...(init.headers ?? {}) },
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    let payload: unknown = {};
    if (method === "POST" && url.endsWith("/api/v1/bot")) {
      payload = { id: "recall-bot-test-0001", status_changes: [{ code: "ready" }] };
    } else if (method === "GET" && url.includes("/api/v1/bot/")) {
      payload = {
        id: "recall-bot-test-0001",
        status_changes: [{ code: "ready" }, { code: "joining" }],
      };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const recallCfg: ServiceConfig = {
    port: 0,
    publicBaseUrl: "https://brain.example.test",
    botDisplayName: "Assistant Teacher (AI)",
    transcriptProvider: "recallai_streaming",
    recall: { apiKey: DUMMY_KEY, region: "us-west-2", webhookSecret: "unused-in-demo", realtimeMode: "webhook" },
    platform: { baseUrl: stubUrl, assistantSecret: DEMO_SECRET },
  };
  const recall = new RecallBotProvider(recallCfg, fakeFetch);
  const created = await recall.createBot({
    sessionId: SESSION_1,
    meetingUrl: "https://zoom.us/j/12345678901",
    joinAt: "2026-10-26T15:57:00.000Z",
    botName: "Assistant Teacher (AI)",
    joinAnnouncement: JOIN_ANNOUNCEMENT,
  });
  await recall.sendPublicMessage(created.botId, "Hello class");
  await recall.sendDirectMessage(created.botId, "participant-42", "Yes, that is right.");
  await recall.leaveCall(created.botId);
  const statusInfo = await recall.retrieveBotStatus(created.botId);
  trace(`[fake-http] ${calls.length} Recall calls recorded; bot ${created.botId} status ${statusInfo.status}`);

  heading("Scenario 5: assertions");
  const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/v1/bot"));
  check("create-bot went to the us-west-2 regional base", createCall?.url === "https://us-west-2.recall.ai/api/v1/bot", createCall?.url ?? "missing");
  check("Authorization header is Token + key (dummy in tests)", createCall?.headers.Authorization === `Token ${DUMMY_KEY}`);
  check("content-type is application/json", (createCall?.headers["content-type"] ?? "").includes("application/json"));
  const cb = createCall?.body ?? {};
  check("create body: meeting_url, join_at, bot_name", cb.meeting_url === "https://zoom.us/j/12345678901" && cb.join_at === "2026-10-26T15:57:00.000Z" && cb.bot_name === "Assistant Teacher (AI)");
  check("create body: metadata carries session_id + source", cb.metadata?.session_id === SESSION_1 && cb.metadata?.source === "assistant_teacher_v1");
  check(
    "create body: pinned join announcement to everyone",
    cb.chat?.on_bot_join?.send_to === "everyone" && cb.chat?.on_bot_join?.pin === true && cb.chat?.on_bot_join?.message === JOIN_ANNOUNCEMENT,
  );
  check(
    "create body: announcement re-sent on participant join",
    cb.chat?.on_participant_join?.send_to === "everyone" && cb.chat?.on_participant_join?.message === JOIN_ANNOUNCEMENT,
  );
  check(
    "create body: recallai_streaming transcript, low-latency mode",
    JSON.stringify(cb.recording_config?.transcript?.provider) === JSON.stringify({ recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } }),
  );
  check(
    "create body: participant_events and meeting_metadata enabled",
    JSON.stringify(cb.recording_config?.participant_events) === "{}" && JSON.stringify(cb.recording_config?.meeting_metadata) === "{}",
  );
  const rt = cb.recording_config?.realtime_endpoints?.[0];
  check(
    "create body: one webhook realtime endpoint with the full event set",
    cb.recording_config?.realtime_endpoints?.length === 1 &&
      rt?.type === "webhook" &&
      rt?.url === "https://brain.example.test/recall/webhook" &&
      JSON.stringify(rt?.events) ===
        JSON.stringify([
          "transcript.data",
          "participant_events.join",
          "participant_events.leave",
          "participant_events.update",
          "participant_events.speech_on",
          "participant_events.speech_off",
          "participant_events.chat_message",
        ]),
    rt ? `${rt.type} ${rt.url}` : "missing",
  );
  check("createBot returned the Recall bot id", created.botId === "recall-bot-test-0001" && created.sessionId === SESSION_1);
  const pubCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/send_chat_message/") && c.body && !("to" in c.body));
  check(
    "public send_chat_message: bot URL, message only, no recipient",
    pubCall?.url === "https://us-west-2.recall.ai/api/v1/bot/recall-bot-test-0001/send_chat_message/" && pubCall?.body?.message === "Hello class",
  );
  const dmCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/send_chat_message/") && c.body && "to" in c.body);
  check(
    "DM send_chat_message: addressed by participant id",
    dmCall?.body?.to === "participant-42" && dmCall?.body?.message === "Yes, that is right.",
  );
  const leaveCallReq = calls.find((c) => c.method === "POST" && c.url.endsWith("/leave_call/"));
  check("leave_call went to the documented path", leaveCallReq?.url === "https://us-west-2.recall.ai/api/v1/bot/recall-bot-test-0001/leave_call/");
  check(
    "retrieveBotStatus reads the last status_changes code",
    statusInfo.botId === "recall-bot-test-0001" && statusInfo.status === "joining",
    statusInfo.status,
  );

  // ================================================================
  heading("SCENARIO 6: webhook signature verification (Recall's documented scheme)");
  // ================================================================
  // Recall's verification scheme (official guide, checked Oct 26, 2026):
  // the workspace verification secret is "whsec_" + base64, the HMAC key
  // is the base64-DECODED bytes, the signed content is
  // "${id}.${timestamp}.${rawBody}", and the webhook-signature header
  // carries space-separated "v1,<base64>" entries. Fixture secret only,
  // invented bytes, no real credential anywhere.
  const fixtureKeyBytes = Buffer.from("demo-webhook-key-bytes-0123456789", "utf8");
  const fixtureSecret = `whsec_${fixtureKeyBytes.toString("base64")}`;
  const signFixture = (id: string, timestamp: string, body: string): string =>
    createHmac("sha256", fixtureKeyBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  const verifier = new RecallBotProvider(
    { ...recallCfg, recall: { ...recallCfg.recall, webhookSecret: fixtureSecret } },
    fakeFetch,
  );
  const whBody = JSON.stringify({ event: "participant_events.chat_message", data: { data: { text: "42", to: "only_bot" } } });
  const whId = "msg_demo_0001";
  const whTs = "1760000000";
  const whSig = signFixture(whId, whTs, whBody);
  const whHeaders = { "webhook-id": whId, "webhook-timestamp": whTs, "webhook-signature": `v1,${whSig}` };
  check("verifyWebhook accepts a correctly signed payload", verifier.verifyWebhook(whBody, whHeaders) === true);
  check(
    "verifyWebhook accepts when any v1 entry in a multi-entry header matches",
    verifier.verifyWebhook(whBody, { ...whHeaders, "webhook-signature": `v1,${Buffer.from("bogus").toString("base64")} v1,${whSig}` }) === true,
  );
  check(
    "verifyWebhook accepts the svix-* header fallbacks",
    verifier.verifyWebhook(whBody, { "svix-id": whId, "svix-timestamp": whTs, "svix-signature": `v1,${whSig}` }) === true,
  );
  check("verifyWebhook rejects a tampered body", verifier.verifyWebhook(`${whBody} `, whHeaders) === false);
  check(
    "verifyWebhook rejects missing headers",
    verifier.verifyWebhook(whBody, {}) === false && verifier.verifyWebhook(whBody, { "webhook-id": whId }) === false,
  );
  const noPrefixVerifier = new RecallBotProvider(
    { ...recallCfg, recall: { ...recallCfg.recall, webhookSecret: "plain-secret-without-prefix" } },
    fakeFetch,
  );
  check(
    "verifyWebhook fails closed when the secret lacks the whsec_ prefix",
    noPrefixVerifier.verifyWebhook(whBody, whHeaders) === false,
  );

  await stub.stop();
  heading("RESULT");
  if (failures === 0) {
    console.log("All scenarios passed. The brain runs the full class locally and the payload validates against the brief contract.");
  } else {
    console.log(`${failures} assertion(s) FAILED.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

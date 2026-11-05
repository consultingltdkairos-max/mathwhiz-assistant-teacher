// Recall.ai implementation of BotProvider. Pilot route, decided by Kevoy on
// Oct 26, 2026. Written against the documented Recall.ai API surface:
//
//   Create Bot:        POST https://{region}.recall.ai/api/v1/bot
//   Send Chat Message: POST https://{region}.recall.ai/api/v1/bot/{id}/send_chat_message/
//   Retrieve Bot:      GET  https://{region}.recall.ai/api/v1/bot/{id}/
//   Leave Call:        POST https://{region}.recall.ai/api/v1/bot/{id}/leave_call/
//   Realtime events arrive on the webhook URL configured per bot in
//   recording_config.realtime_endpoints; lifecycle status changes arrive
//   on the workspace-level bot webhook (bot.status_change).
//
// ACCOUNT STATE (verified Oct 26, 2026): the "Mathwhiz Academy" workspace
// is live in region us-west-2 (API base https://us-west-2.recall.ai), and
// authentication with `Authorization: Token <key>` was verified by a direct
// GET /api/v1/bot/ returning 200. The key reaches this class ONLY via
// ServiceConfig (RECALL_API_KEY env at runtime); it is never logged and
// never written to a file by this code.
// Webhook signature verification implements Recall's documented scheme
// (official verification guide, checked Oct 26, 2026): a "whsec_" workspace
// verification secret and Svix-style webhook-* headers, in verifyWebhook.
// STILL UNCONFIRMED until live deliveries reach the hosted service: the
// field-level shapes of the realtime webhook events (marked TODO below)
// and live join/leave behaviour.
// The demo covers this class's request construction against a fake HTTP
// layer (runDemo Scenario 5) and the verification scheme against fixture
// signatures (Scenario 6); it makes no live calls.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServiceConfig } from "../config.js";
import type {
  BotEvent,
  BotEventHandler,
  BotProvider,
  BotSession,
  CreateBotRequest,
  ScreenFrame,
} from "./BotProvider.js";

const REALTIME_EVENTS = [
  "transcript.data",
  "participant_events.join",
  "participant_events.leave",
  "participant_events.update",
  "participant_events.speech_on",
  "participant_events.speech_off",
  "participant_events.chat_message",
];

export type FetchImpl = typeof fetch;

export class RecallBotProvider implements BotProvider {
  private handler: BotEventHandler | null = null;
  private fetchImpl: FetchImpl;
  /** Latest video frame per participant, per session (screen reading,
   *  Nov 5, 2026). In memory only, newest frame replaces the old; frames
   *  are never written to disk or logged. */
  private frames = new Map<string, Map<string, ScreenFrame>>();
  /** botId -> sessionId, so getScreenFrame can resolve its session. */
  private botSessions = new Map<string, string>();

  // fetchImpl is injectable ONLY so the local demo can assert this class's
  // exact request construction against a fake HTTP layer. Production code
  // passes nothing and gets the global fetch.
  constructor(
    private cfg: ServiceConfig,
    fetchImpl?: FetchImpl,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private get baseUrl(): string {
    return `https://${this.cfg.recall.region}.recall.ai/api/v1`;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${this.cfg.recall.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Recall API ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async createBot(req: CreateBotRequest): Promise<BotSession> {
    const transcriptProvider =
      this.cfg.transcriptProvider === "meeting_captions"
        ? { meeting_captions: {} }
        : { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } };

    const body = {
      meeting_url: req.meetingUrl,
      join_at: req.joinAt,
      bot_name: req.botName,
      metadata: { session_id: req.sessionId, source: "assistant_teacher_v1" },
      chat: {
        // Public announcement when the bot joins. That is the ONLY
        // unprompted message the bot ever sends (compliance ruling,
        // Nov 5, 2026): there is deliberately NO on_participant_join
        // message, because on Zoom those are delivered as DMs, and the
        // assistant never privately contacts a student who has not
        // messaged it first.
        on_bot_join: { send_to: "everyone", message: req.joinAnnouncement, pin: true },
      },
      recording_config: {
        transcript: { provider: transcriptProvider },
        participant_events: {},
        meeting_metadata: {},
        // Pilot realtime mode is "webhook" (config fails fast on anything
        // else), so the bot is created with one realtime webhook endpoint.
        realtime_endpoints:
          this.cfg.recall.realtimeMode === "webhook"
            ? [
                {
                  type: "webhook",
                  url: `${this.cfg.publicBaseUrl}/recall/webhook`,
                  events: REALTIME_EVENTS,
                },
              ]
            : [],
        // Screen reading (Nov 5, 2026), ONLY when SCREEN_VIDEO_ENABLED=1:
        // separate PNG video per participant over a websocket endpoint.
        // With the flag off the Create Bot body is exactly the proven
        // pilot shape. Separate video needs the gallery_view_v2 layout
        // and, per Recall's docs, the web_4_core bot variant.
        ...(this.cfg.screen.enabled
          ? {
              video_mixed_layout: "gallery_view_v2",
              video_separate_png: {},
              realtime_endpoints: [
                {
                  type: "webhook",
                  url: `${this.cfg.publicBaseUrl}/recall/webhook`,
                  events: REALTIME_EVENTS,
                },
                {
                  type: "websocket",
                  url: `${this.cfg.publicBaseUrl.replace(/^http/, "ws")}/recall/video?session=${encodeURIComponent(req.sessionId)}`,
                  events: ["video_separate_png.data"],
                },
              ],
            }
          : {}),
      },
      ...(this.cfg.screen.enabled ? { variant: { zoom: "web_4_core" } } : {}),
    };

    const bot = await this.api("/bot", { method: "POST", body: JSON.stringify(body) });
    this.botSessions.set(bot.id, req.sessionId);
    return { botId: bot.id, sessionId: req.sessionId };
  }

  /** Ingest one realtime video websocket message for a session. Shapes
   *  are parsed defensively across the documented nestings (the Oct 28
   *  chat-envelope lesson); anything unrecognised is dropped, never
   *  thrown. TODO(live): confirm the exact Zoom screenshare stream
   *  identity (participant flag vs name) in the next fake class; the
   *  selection heuristic in getScreenFrame prefers an explicit
   *  screenshare flag, then a "share" name, then the freshest frame. */
  handleVideoMessage(sessionId: string, raw: string): void {
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.event && payload.event !== "video_separate_png.data") return;
    const inner = payload.data?.data ?? payload.data ?? payload;
    const buffer: unknown = inner?.buffer;
    if (typeof buffer !== "string" || buffer.length === 0 || buffer.length > 4_000_000) return;
    const participant = inner?.participant ?? {};
    const participantId = participant?.id != null ? String(participant.id) : "unknown";
    const name: string = String(participant?.name ?? "Unknown");
    const isScreenshare =
      Boolean(participant?.is_screenshare) || participant?.type === "screenshare" || /share/i.test(name);
    let byParticipant = this.frames.get(sessionId);
    if (!byParticipant) {
      byParticipant = new Map();
      this.frames.set(sessionId, byParticipant);
    }
    byParticipant.set(participantId, {
      pngBase64: buffer,
      participantName: name,
      isScreenshare,
      capturedAt: Date.now(),
    });
  }

  async getScreenFrame(botId: string): Promise<ScreenFrame | null> {
    const sessionId = this.botSessions.get(botId);
    if (!sessionId) return null;
    const byParticipant = this.frames.get(sessionId);
    if (!byParticipant || byParticipant.size === 0) return null;
    const now = Date.now();
    const fresh = [...byParticipant.values()].filter((f) => now - f.capturedAt <= 60_000);
    if (fresh.length === 0) return null;
    fresh.sort((a, b) => {
      if (a.isScreenshare !== b.isScreenshare) return a.isScreenshare ? -1 : 1;
      return b.capturedAt - a.capturedAt;
    });
    return fresh[0];
  }

  /** Retrieve Bot: the bot's latest lifecycle status code (for example
   *  "ready", "joining", "in_call_recording", "done", "fatal"), taken from
   *  the last entry of status_changes. Used by the bot:create-test script;
   *  returns codes only, never payloads. */
  async retrieveBotStatus(botId: string): Promise<{ botId: string; status: string }> {
    const bot = await this.api(`/bot/${botId}/`);
    const changes: any[] = Array.isArray(bot?.status_changes) ? bot.status_changes : [];
    const last = changes.length > 0 ? changes[changes.length - 1] : null;
    return { botId: String(bot?.id ?? botId), status: String(last?.code ?? bot?.status ?? "unknown") };
  }

  async sendPublicMessage(botId: string, message: string): Promise<void> {
    await this.api(`/bot/${botId}/send_chat_message/`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  async sendDirectMessage(botId: string, participantId: string, message: string): Promise<void> {
    // `to` carries the Recall participant id (learned from
    // participant_events.join); on Zoom this is delivered as a private DM.
    await this.api(`/bot/${botId}/send_chat_message/`, {
      method: "POST",
      body: JSON.stringify({ to: participantId, message }),
    });
  }

  async leaveCall(botId: string): Promise<void> {
    // Documented Leave Call endpoint. Live behaviour (how quickly the bot
    // exits, and the status sequence that follows) is confirmed in Stage 0.
    await this.api(`/bot/${botId}/leave_call/`, { method: "POST", body: JSON.stringify({}) });
  }

  onEvent(handler: BotEventHandler): void {
    this.handler = handler;
  }

  /** Called by the server after verifyWebhook passes. */
  async dispatch(botId: string, events: BotEvent[]): Promise<void> {
    if (!this.handler) return;
    for (const e of events) await this.handler(botId, e);
  }

  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
    // Recall's documented verification scheme (official verification guide,
    // checked Oct 26, 2026), Svix-style. FAIL-CLOSED throughout: an
    // unverified body must never reach the brain.
    //
    //   secret:         "whsec_" + base64. The HMAC key is the base64-
    //                   DECODED bytes of the part after the prefix. A
    //                   configured secret without the prefix never verifies.
    //   headers:        webhook-id, webhook-timestamp, webhook-signature,
    //                   with svix-id / svix-timestamp / svix-signature as
    //                   fallbacks. (The server passes lowercased names.)
    //   signed content: "${id}.${timestamp}.${rawBody}", raw body verbatim.
    //   signature:      HMAC-SHA256(key, signed content), base64 digest.
    //                   The header may carry several space-separated
    //                   "v1,<base64>" entries; ANY matching v1 entry
    //                   verifies (timing-safe, length-guarded).
    const secret = this.cfg.recall.webhookSecret;
    if (!secret || !secret.startsWith("whsec_")) return false;
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    if (key.length === 0) return false;

    const id = headers["webhook-id"] ?? headers["svix-id"];
    const timestamp = headers["webhook-timestamp"] ?? headers["svix-timestamp"];
    const signatureHeader = headers["webhook-signature"] ?? headers["svix-signature"];
    if (!id || !timestamp || !signatureHeader) return false;

    const expected = Buffer.from(
      createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"),
    );
    for (const entry of signatureHeader.split(" ")) {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
      const candidate = Buffer.from(entry.slice(comma + 1));
      if (candidate.length !== expected.length) continue;
      if (timingSafeEqual(candidate, expected)) return true;
    }
    return false;
  }

  translateWebhook(rawBody: string, _headers: Record<string, string> = {}): BotEvent[] | null {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const event: string = payload.event ?? "";
    const data = payload.data ?? {};
    const participant = data?.data?.participant ?? data?.participant ?? {};
    const participantId = participant?.id != null ? String(participant.id) : "";
    const name: string = participant?.name ?? "Unknown";
    const ts = Date.now();

    switch (event) {
      case "participant_events.join":
        return [{ type: "participant_joined", participantId, name, isHost: Boolean(participant?.is_host) }];
      case "participant_events.leave":
        return [{ type: "participant_left", participantId }];
      case "participant_events.update":
        return [{ type: "participant_updated", participantId, name }];
      case "participant_events.speech_on":
        return [{ type: "speech_on", participantId }];
      case "participant_events.speech_off":
        return [{ type: "speech_off", participantId }];
      case "participant_events.chat_message": {
        // Chat semantics CONFIRMED in the live Stage 0 tests (Oct 26, 2026
        // via the bot's participant-events record; Oct 28, 2026 against the
        // live realtime webhook): the event data carries `text` and `to`,
        // where to="everyone" is a public message and to="only_bot" is a
        // DM addressed to the bot. Private chats between other people are
        // never in the bot's event stream.
        // ENVELOPE (confirmed Oct 28, 2026): the realtime webhook nests the
        // message one level deeper than the participant-events record:
        // payload.data.data is { participant, timestamp, data: { text,
        // to } }. Reading text/to from payload.data.data (the record
        // shape) silently dropped every live chat message; that was the
        // Stage 0 test 2/3/4 failure. Descend into data.data.data first,
        // then fall back to the flatter shapes defensively.
        // Defensive rule: only surface messages addressed to everyone or
        // to the bot; NEVER surface a DM between other people.
        const inner = data?.data?.data ?? data?.data ?? data;
        const text: string = inner?.text ?? inner?.message ?? "";
        const toRaw: string = String(inner?.to ?? inner?.type ?? "everyone");
        const to = toRaw === "everyone" ? "everyone" : "bot";
        if (!text) return [];
        return [{ type: "chat_message", participantId, name, to, text, timestamp: ts }];
      }
      case "transcript.data": {
        const words: any[] = data?.data?.words ?? [];
        const text = words.map((w) => w?.text ?? "").join(" ").trim();
        if (!text) return [];
        return [{ type: "transcript", participantId, name, text, timestamp: ts }];
      }
      case "bot.status_change": {
        const status: string = data?.status?.code ?? data?.code ?? "";
        const map: Record<string, BotEvent["type"]> = {};
        void map;
        const mapped =
          status === "in_call_recording" || status === "in_call_not_recording"
            ? "in_call"
            : status === "in_waiting_room"
              ? "in_waiting_room"
              : status === "call_ended" || status === "done"
                ? "call_ended"
                : status === "fatal"
                  ? "fatal"
                  : "joining";
        return [{ type: "bot_status", status: mapped as any, detail: status }];
      }
      default:
        return [];
    }
  }
}

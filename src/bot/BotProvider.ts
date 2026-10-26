// The bot layer interface. The brain depends only on this, so the provider
// can be swapped (Recall.ai for the pilot, decided Oct 26, 2026; a future
// own Meeting SDK bot would implement the same surface).

export interface BotSession {
  botId: string;
  sessionId: string; // platform class_sessions uuid, carried in bot metadata
}

export type BotEvent =
  | { type: "participant_joined"; participantId: string; name: string; isHost: boolean }
  | { type: "participant_left"; participantId: string }
  | { type: "participant_updated"; participantId: string; name: string }
  | {
      type: "chat_message";
      participantId: string;
      name: string;
      /** "everyone" for public chat, "bot" for a DM sent to the bot,
       *  another participant id for DMs between other people (never delivered
       *  to us in practice; the provider must drop anything not addressed to
       *  everyone or the bot). */
      to: "everyone" | "bot";
      text: string;
      timestamp: number;
    }
  | { type: "transcript"; participantId: string; name: string; text: string; timestamp: number }
  | { type: "speech_on"; participantId: string }
  | { type: "speech_off"; participantId: string }
  | {
      type: "bot_status";
      status: "joining" | "in_waiting_room" | "in_call" | "call_ended" | "fatal";
      detail?: string;
    };

export type BotEventHandler = (botId: string, event: BotEvent) => void | Promise<void>;

export interface CreateBotRequest {
  sessionId: string;
  meetingUrl: string;
  joinAt: string; // ISO8601
  botName: string;
  joinAnnouncement: string; // sent publicly on join (and re-sent per join where supported)
}

export interface BotProvider {
  /** Create and schedule a bot for a session. Returns the provider bot id. */
  createBot(req: CreateBotRequest): Promise<BotSession>;
  /** Send a public chat message to everyone in the meeting. */
  sendPublicMessage(botId: string, message: string): Promise<void>;
  /** Send a DM to one participant (student replies, teacher nudges). */
  sendDirectMessage(botId: string, participantId: string, message: string): Promise<void>;
  /** Ask the bot to leave the call now. */
  leaveCall(botId: string): Promise<void>;
  /** Register the handler for realtime events (webhook-driven in the server). */
  onEvent(handler: BotEventHandler): void;
  /** Translate one raw provider webhook body into zero or more BotEvents.
   *  Returns null when the body is not an event we handle. The server
   *  verifies the provider signature BEFORE calling this. */
  translateWebhook(rawBody: string, headers: Record<string, string>): BotEvent[] | null;
  /** Verify a realtime webhook signature. Must be enforced by the server. */
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean;
}

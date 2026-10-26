// Mock Recall harness for LOCAL DEMO ONLY. Implements the BotProvider
// interface with no network calls and no credentials: outbound chat is
// recorded and printed as the would-be Recall Send Chat Message calls,
// and inbound events are fed in by the demo script via emit().
//
// What this proves locally: the brain's event handling end to end.
// What it does NOT prove: Recall's real webhook field shapes (notably how
// a chat event marks "DM to the bot" vs public), the join/leave-call
// behaviour, or signature verification. Those stay TODO for Stage 0
// against live Recall payloads.

import type {
  BotEvent,
  BotEventHandler,
  BotProvider,
  BotSession,
  CreateBotRequest,
} from "../bot/BotProvider.js";

export interface SentMessage {
  kind: "public" | "dm";
  toParticipantId: string | null;
  message: string;
}

export class MockBotProvider implements BotProvider {
  readonly sent: SentMessage[] = [];
  private handler: BotEventHandler | null = null;
  private botId = "mock-bot-0001";
  private seq = 0;

  constructor(private trace: (line: string) => void) {}

  async createBot(req: CreateBotRequest): Promise<BotSession> {
    this.seq += 1;
    this.botId = `mock-bot-${String(this.seq).padStart(4, "0")}`;
    this.trace(
      `[mock-recall] createBot -> ${this.botId} (meeting: ${req.meetingUrl}, join_at: ${req.joinAt}, name: "${req.botName}")`,
    );
    this.trace(`[mock-recall] chat.on_bot_join announcement pinned: "${req.joinAnnouncement}"`);
    return { botId: this.botId, sessionId: req.sessionId };
  }

  async sendPublicMessage(_botId: string, message: string): Promise<void> {
    this.sent.push({ kind: "public", toParticipantId: null, message });
    this.trace(`[would call POST /bot/{id}/send_chat_message/ {}] PUBLIC: "${message}"`);
  }

  async sendDirectMessage(_botId: string, participantId: string, message: string): Promise<void> {
    this.sent.push({ kind: "dm", toParticipantId: participantId, message });
    this.trace(
      `[would call POST /bot/{id}/send_chat_message/ {to: "${participantId}"}] DM: "${message}"`,
    );
  }

  async leaveCall(botId: string): Promise<void> {
    this.trace(`[mock-recall] leaveCall(${botId})`);
  }

  onEvent(handler: BotEventHandler): void {
    this.handler = handler;
  }

  /** Feed one simulated event into the brain, as a translated webhook. */
  async emit(event: BotEvent): Promise<void> {
    this.trace(`--> event in: ${describeEvent(event)}`);
    if (this.handler) await this.handler(this.botId, event);
  }

  // The demo feeds BotEvents directly, so raw-webhook translation and
  // signature checks are out of scope here. verifyWebhook returns true
  // ONLY inside this mock; the real provider fails closed.
  translateWebhook(): BotEvent[] | null {
    return null;
  }
  verifyWebhook(): boolean {
    return true;
  }
}

function describeEvent(e: BotEvent): string {
  switch (e.type) {
    case "bot_status":
      return `bot_status ${e.status}${e.detail ? ` (${e.detail})` : ""}   [recall: bot.status_change]`;
    case "participant_joined":
      return `participant_joined "${e.name}" id=${e.participantId}${e.isHost ? " HOST" : ""}   [recall: participant_events.join]`;
    case "participant_left":
      return `participant_left id=${e.participantId}   [recall: participant_events.leave]`;
    case "participant_updated":
      return `participant_updated "${e.name}" id=${e.participantId}   [recall: participant_events.update]`;
    case "chat_message":
      return `chat_message from "${e.name}" to=${e.to}: "${e.text}"   [recall: participant_events.chat_message]`;
    case "transcript":
      return `transcript from "${e.name}": "${e.text}"   [recall: transcript.data]`;
    case "speech_on":
      return `speech_on id=${e.participantId}`;
    case "speech_off":
      return `speech_off id=${e.participantId}`;
  }
}

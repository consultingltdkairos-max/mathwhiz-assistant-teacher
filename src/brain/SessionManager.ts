// One live class, end to end. Wires the bot provider to the brain modules
// and the platform client, following build-out spec v1 Sections 1.2 to 1.8.

import type { BotEvent, BotProvider } from "../bot/BotProvider.js";
import type { PlatformClient } from "../platform/PlatformClient.js";
import type { SessionContext } from "../types.js";
import { CheckInEngine, parseCheckInCommand } from "./CheckInEngine.js";
import { compileDraft } from "./Compiler.js";
import { NudgeEngine } from "./NudgeEngine.js";
import { RosterMatcher } from "./RosterMatcher.js";
import { safeguardingResponses, screenStudentMessage } from "./Safeguarding.js";
import { SignalTracker } from "./SignalTracker.js";
import { replyToStudentQuestion } from "./TutorResponder.js";

export const JOIN_ANNOUNCEMENT =
  "Hi everyone, I am the Assistant Teacher. I am an AI helper in this class. " +
  "When your teacher runs a check in, I will send the question to you privately here. " +
  "Reply to me privately with your answer. You can also message me any time you are stuck.";

const DEFAULT_CLASS_DURATION_MS = 90 * 60 * 1000; // Mathwhiz classes: 1.5h

export class SessionManager {
  private matcher: RosterMatcher;
  private tracker: SignalTracker;
  private checkIns = new CheckInEngine();
  private nudges: NudgeEngine;
  private botId: string | null = null;
  private botInCall = false;
  private presentParticipants = new Set<string>();
  private presentStudents = new Set<string>();
  private startedAt = Date.now();
  private sessionLog: string[] = [];

  constructor(
    private ctx: SessionContext,
    private bot: BotProvider,
    private platform: PlatformClient,
  ) {
    this.matcher = new RosterMatcher(ctx.roster);
    this.tracker = new SignalTracker(
      ctx.roster.map((r) => r.studentId),
      this.startedAt,
      DEFAULT_CLASS_DURATION_MS,
    );
    this.nudges = new NudgeEngine(this.tracker);
  }

  async start(): Promise<void> {
    const session = await this.bot.createBot({
      sessionId: this.ctx.sessionId,
      meetingUrl: this.ctx.meetingUrl,
      joinAt: this.ctx.joinAt,
      botName: "Assistant Teacher (AI)",
      joinAnnouncement: JOIN_ANNOUNCEMENT,
    });
    this.botId = session.botId;
    this.log(`Bot created: ${session.botId} for session ${this.ctx.sessionId}`);
  }

  async handleEvent(botId: string, event: BotEvent): Promise<void> {
    if (this.botId && botId !== this.botId) return;
    const now = Date.now();

    switch (event.type) {
      case "bot_status": {
        if (event.status === "in_call") this.botInCall = true;
        if (event.status === "in_waiting_room") {
          this.log("Bot is in the waiting room; host admission needed. Class may run without the assistant.");
        }
        if (event.status === "call_ended") await this.finalise();
        break;
      }
      case "participant_joined": {
        this.presentParticipants.add(event.participantId);
        if (event.isHost) {
          this.ctx.teacherParticipantId = event.participantId;
        } else {
          const match = this.matcher.match(event.participantId, event.name);
          if (match.studentId) this.presentStudents.add(match.studentId);
          if (match.confidence !== "high") {
            this.log(`Roster flag: "${event.name}" matched with confidence ${match.confidence}`);
          }
        }
        break;
      }
      case "participant_left": {
        this.presentParticipants.delete(event.participantId);
        break;
      }
      case "participant_updated": {
        if (!this.isTeacher(event.participantId)) {
          const match = this.matcher.match(event.participantId, event.name);
          if (match.studentId) this.presentStudents.add(match.studentId);
        }
        break;
      }
      case "transcript": {
        const studentId = this.matcher.studentFor(event.participantId);
        if (studentId) this.tracker.transcript(studentId, now);
        break;
      }
      case "chat_message": {
        await this.handleChat(event, now);
        break;
      }
      case "speech_on":
      case "speech_off":
        // Speaking turns are counted from transcript utterances; raw speech
        // events are available if finer segmentation is needed later.
        break;
    }
  }

  private isTeacher(participantId: string): boolean {
    return this.ctx.teacherParticipantId !== null && participantId === this.ctx.teacherParticipantId;
  }

  private async handleChat(
    event: Extract<BotEvent, { type: "chat_message" }>,
    now: number,
  ): Promise<void> {
    if (!this.botId) return;

    if (event.to === "everyone") {
      if (this.isTeacher(event.participantId)) return; // teacher floor speech is not a student signal
      const studentId = this.matcher.studentFor(event.participantId);
      if (studentId) this.tracker.publicChat(studentId, event.text, this.checkIns.isOpen(now), now);
      return;
    }

    // DM to the bot.
    if (this.isTeacher(event.participantId)) {
      await this.handleTeacherDm(event.text, now);
      return;
    }

    const studentId = this.matcher.studentFor(event.participantId);
    if (!studentId) {
      // Unmatched/low-confidence sender: reply generically, record nothing.
      await this.bot.sendDirectMessage(
        this.botId,
        event.participantId,
        "Thanks for your message. I could not match your name to this class list, so I have let your teacher know to check.",
      );
      return;
    }

    // Safeguarding screen runs before anything else touches the message.
    const hit = screenStudentMessage(event.text);
    if (hit) {
      const r = safeguardingResponses(event.name, hit.reason);
      await this.bot.sendDirectMessage(this.botId, event.participantId, r.studentReply);
      await this.dmTeacher(r.teacherFlag);
      this.log(`SAFEGUARDING FLAG for ${event.name}: ${hit.reason}`);
      return;
    }

    if (this.checkIns.isOpen(now)) {
      const outcome = this.checkIns.recordReply(studentId, event.text, now);
      if (outcome) {
        if (outcome.kind === "scored") {
          if (outcome.attempt === "first") {
            this.tracker.checkInResult(studentId, outcome.correct, now);
          } else if (outcome.correct) {
            // The one hint-mode retry, answered correctly: recorded
            // separately, and checkinsAnswered does not move again.
            this.tracker.checkInRetryResult(studentId, now);
          }
          // A wrong retry needs no tracker call: the first reply already
          // counted the answer, as not correct.
        }
        // kind "ignored" (reply after the outcome was final) is consumed
        // here too, so it is never mistaken for a private question.
        await this.bot.sendDirectMessage(this.botId, event.participantId, outcome.replyText);
        return;
      }
    }

    // Otherwise: a private question to the assistant.
    this.tracker.privateQuestion(studentId, now);
    await this.bot.sendDirectMessage(
      this.botId,
      event.participantId,
      replyToStudentQuestion(event.text, this.checkIns.isOpen(now)),
    );
  }

  private async handleTeacherDm(text: string, now: number): Promise<void> {
    if (!this.botId) return;
    if (this.nudges.handleTeacherCommand(text)) return;

    const cmd = parseCheckInCommand(text);
    if (cmd) {
      const studentIds = this.ctx.roster.map((r) => r.studentId).filter((id) => this.presentStudents.has(id));
      this.checkIns.open(cmd, studentIds, now);
      this.tracker.checkInSent(studentIds);
      for (const m of this.matcher.all()) {
        if (m.studentId && this.presentStudents.has(m.studentId)) {
          await this.bot.sendDirectMessage(this.botId, m.participantId, `Check in: ${cmd.question}`);
        }
      }
      await this.dmTeacher(`Check in sent to ${studentIds.length} students. Window: ${Math.round(cmd.windowMs / 60000)} minutes.`);
      return;
    }

    await this.dmTeacher(
      "I did not recognise that. Commands: CHECKIN | question | answer | mode: confirm-or-hint, or PAUSE / RESUME / STOP.",
    );
  }

  /** Periodic tick (server calls every ~15s): close expired check-ins,
   *  send tallies and nudges. */
  async tick(): Promise<void> {
    const now = Date.now();
    const active = this.checkIns.active;
    if (active && active.closedAt === null && now - active.openedAt > active.windowMs) {
      const tally = this.checkIns.close(now);
      if (tally) {
        const hintPart =
          tally.correctWithHint > 0 ? `, ${tally.correctWithHint} correct with a hint` : "";
        await this.dmTeacher(
          `Check in closed: ${tally.answered} answered, ${tally.correct} correct${hintPart}. No response from ${tally.nonResponders.length} student(s).`,
        );
        const segment = now - this.startedAt < DEFAULT_CLASS_DURATION_MS / 2 ? "early" : "late";
        for (const studentId of tally.nonResponders) {
          const name = this.displayNameFor(studentId);
          const text = this.nudges.checkInNudge(studentId, name, segment);
          if (text) await this.dmTeacher(text);
        }
      }
    }

    const segment = now - this.startedAt < DEFAULT_CLASS_DURATION_MS / 2 ? "early" : "late";
    const due = this.nudges.silenceNudges(
      this.ctx.roster.map((r) => ({
        studentId: r.studentId,
        displayName: r.displayNames[0] ?? "student",
        present: this.presentStudents.has(r.studentId),
      })),
      this.startedAt,
      now,
      segment,
    );
    for (const n of due) await this.dmTeacher(n.text);
  }

  /** Compile the draft and post it, then leave. Idempotent per session. */
  private finalised = false;
  async finalise(): Promise<void> {
    if (this.finalised) return;
    this.finalised = true;
    const payload = compileDraft({
      ctx: this.ctx,
      tracker: this.tracker,
      matcher: this.matcher,
      assistantPresent: this.botInCall,
      presentStudentIds: this.presentStudents,
    });
    const result = await this.platform.postParticipationDraft(payload);
    this.log(`Draft posted: created=${result.created} updated=${result.updated} skipped=${result.skipped.length}`);
    if (this.botId) {
      try {
        await this.bot.leaveCall(this.botId);
      } catch {
        /* bot already gone */
      }
    }
  }

  async endNow(): Promise<void> {
    await this.finalise();
  }

  private displayNameFor(studentId: string): string {
    return this.ctx.roster.find((r) => r.studentId === studentId)?.displayNames[0] ?? "a student";
  }

  private async dmTeacher(text: string): Promise<void> {
    if (!this.botId || !this.ctx.teacherParticipantId) return;
    await this.bot.sendDirectMessage(this.botId, this.ctx.teacherParticipantId, text);
  }

  private log(line: string): void {
    this.sessionLog.push(`[${new Date().toISOString()}] ${line}`);
    // TODO: persist the session log (every bot/teacher/student exchange is
    // kept for teacher spot-checks, per the design's audit expectation).
    console.log(`[session ${this.ctx.sessionId}] ${line}`);
  }
}

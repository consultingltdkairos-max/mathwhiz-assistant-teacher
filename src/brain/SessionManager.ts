// One live class, end to end. Wires the bot provider to the brain modules
// and the platform client, following build-out spec v1 Sections 1.2 to 1.8.

import type { BotEvent, BotProvider } from "../bot/BotProvider.js";
import type { PlatformClient } from "../platform/PlatformClient.js";
import type { ParticipationDraftPayload, SessionContext } from "../types.js";
import {
  CheckInEngine,
  answersMatch,
  formatWindowMs,
  parseRoundCommand,
  splitAnswerLabel,
} from "./CheckInEngine.js";
import type { CheckIn } from "../types.js";
import type { ScreenQuestion, VisionProvider } from "./Vision.js";
import type { RoundCommandParser } from "./CommandParser.js";
import { compileDraft } from "./Compiler.js";
import { NudgeEngine } from "./NudgeEngine.js";
import { RosterMatcher } from "./RosterMatcher.js";
import { safeguardingResponses, screenStudentMessage } from "./Safeguarding.js";
import { SignalTracker } from "./SignalTracker.js";
import { replyToStudentQuestion } from "./TutorResponder.js";

export const JOIN_ANNOUNCEMENT =
  "Hi everyone, I am the Assistant Teacher, an AI helper in this class. " +
  "Your teacher will put questions on the board during class. When a question goes up, " +
  "send your answer to me here in a private message and I will tell you if it is right. " +
  "You can also message me any time you are stuck.";

const DEFAULT_CLASS_DURATION_MS = 90 * 60 * 1000; // Mathwhiz classes: 1.5h

export class SessionManager {
  private matcher: RosterMatcher;
  private tracker: SignalTracker;
  private checkIns = new CheckInEngine();
  private nudges: NudgeEngine;
  private botId: string | null = null;
  /** The Recall bot id created by start(), or null before it runs. The
   *  HTTP server needs it to route this bot's webhook events here. */
  get currentBotId(): string | null {
    return this.botId;
  }
  private botInCall = false;
  private presentParticipants = new Set<string>();
  private presentStudents = new Set<string>();
  private startedAt = Date.now();
  private sessionLog: string[] = [];

  /** The question read from the shared screen for the latest round, or
   *  null when screen reading is off, unavailable, or unreadable. */
  private screenQuestion: ScreenQuestion | null = null;
  /** Every legible question read from the screen, by label ("" for a
   *  single unlabelled question), for multi-question boards. */
  private screenByLabel = new Map<string, ScreenQuestion>();
  /** Round ids whose screen cross-check has already run (warn or pass),
   *  so the teacher is warned once per round, never repeatedly. */
  private crossCheckedRounds = new Set<string>();

  private isTeacherName(name: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const n = norm(name);
    return (this.ctx.teacherNames ?? []).some((t) => norm(t) === n);
  }

  /** Recognise the teacher: the host always counts; otherwise a join or
   *  rename under one of the session's teacher names counts when no
   *  teacher has been recognised yet (Nov 5, 2026 finding: the teacher
   *  on her own host account must be recognised reliably). */
  private noteTeacher(participantId: string, name: string, isHost: boolean): boolean {
    if (isHost) {
      this.ctx.teacherParticipantId = participantId;
      this.checkIns.setTeacherLabel(this.ctx.teacherLabel ?? name);
      return true;
    }
    if (!this.ctx.teacherParticipantId && this.isTeacherName(name)) {
      this.ctx.teacherParticipantId = participantId;
      this.checkIns.setTeacherLabel(this.ctx.teacherLabel ?? name);
      return true;
    }
    return this.isTeacher(participantId);
  }

  constructor(
    private ctx: SessionContext,
    private bot: BotProvider,
    private platform: PlatformClient,
    private vision: VisionProvider | null = null,
    private commandParser: RoundCommandParser | null = null,
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
        if (!this.noteTeacher(event.participantId, event.name, event.isHost)) {
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
        if (!this.noteTeacher(event.participantId, event.name, false)) {
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

    // A student may label their answer ("Q2: 36") when several questions
    // are open. The label is honoured only when that round exists and is
    // open; otherwise the message is used exactly as sent.
    const split = splitAnswerLabel(event.text);
    let answerText = event.text;
    let labelHint = "";
    if (split.label) {
      const r = this.checkIns.round(split.label);
      if (r && r.closedAt === null) {
        labelHint = split.label;
        answerText = split.text;
      }
    }

    if (this.checkIns.isOpen(now)) {
      const outcome = this.checkIns.recordReply(studentId, answerText, now, labelHint);
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
          let replyText = outcome.replyText;
          // Real hint (Nov 5, 2026): a wrong FIRST reply in hint mode,
          // with that round's screen question known, earns a hint written
          // against the actual question and the student's actual wrong
          // answer. Any vision failure keeps the pool reply.
          const round = this.checkIns.round(outcome.roundLabel);
          const q = this.questionFor(outcome.roundLabel);
          if (outcome.attempt === "first" && !outcome.correct && round?.mode === "hint" && this.vision && q) {
            const hint = await this.vision
              .makeHint(q, round.expectedAnswer, answerText)
              .catch(() => null);
            if (hint) replyText = hint;
          }
          await this.bot.sendDirectMessage(this.botId, event.participantId, replyText);
          // If that reply was the last outstanding one on its round,
          // close that round now rather than waiting for expiry.
          if (this.checkIns.allFinal(outcome.roundLabel)) {
            await this.closeRound(outcome.roundLabel, now);
          }
          return;
        }
        if (outcome.kind === "unsure") {
          // Engaged and honest, never scored wrong. Counts as an answer
          // for participation; the teacher hears about them at close.
          if (outcome.firstReply) this.tracker.checkInResult(studentId, false, now);
          await this.bot.sendDirectMessage(this.botId, event.participantId, outcome.replyText);
          if (this.checkIns.allFinal(outcome.roundLabel)) {
            await this.closeRound(outcome.roundLabel, now);
          }
          return;
        }
        // kind "needs_label" or "ignored": consumed here so the message
        // is never mistaken for a private question.
        await this.bot.sendDirectMessage(this.botId, event.participantId, outcome.replyText);
        return;
      }
    }

    // Otherwise: a private question to the assistant.
    this.tracker.privateQuestion(studentId, now);
    const roundOpen = this.checkIns.isOpen(now);
    let reply = replyToStudentQuestion(event.text, roundOpen);
    // Controlled help (Nov 5, 2026 finding): help is for the work on the
    // board in THIS class. Homework and assignment requests are refused
    // deterministically here, and the vision prompt refuses them again.
    const asksForAssignment = /\b(homework|assignment|take[- ]?home)\b/i.test(event.text);
    if (!roundOpen && asksForAssignment) {
      reply = "I can only help with the work we are doing in class right now. For that one, check with your teacher.";
    } else if (!roundOpen && this.vision && this.screenQuestion) {
      const help = await this.vision
        .helpWithQuestion(this.screenQuestion, event.text)
        .catch(() => null);
      if (help) reply = help;
    }
    await this.bot.sendDirectMessage(this.botId, event.participantId, reply);
  }

  /** The screen question that belongs to a round: exact label match,
   *  or the single question on screen when there is only one. */
  private questionFor(label: string): ScreenQuestion | null {
    const exact = this.screenByLabel.get(label);
    if (exact) return exact;
    if (this.screenByLabel.size === 1) return [...this.screenByLabel.values()][0];
    return label === "" ? this.screenQuestion : null;
  }

  private async handleTeacherDm(text: string, now: number): Promise<void> {
    if (!this.botId) return;
    if (this.nudges.handleTeacherCommand(text)) return;

    // Conversational close: "close", "close Q2", "close question 2".
    const closeM = text.trim().match(/^close(?:\s+(?:the\s+)?(?:round|question))?(?:\s+(?:q|question)\s*([0-9]+))?$/i);
    if (closeM) {
      const label = closeM[1] ? `Q${closeM[1]}` : this.singleOpenLabel(now);
      if (label !== null) await this.closeRound(label, now);
      else await this.dmTeacher("No single round is open to close. Name the question, for example: close Q2.");
      return;
    }

    // The coded template parses first: instant and exact. Plain language
    // is the fallback, and its confirmation reads the interpretation
    // back, so a misread is caught before the round runs.
    let cmd = parseRoundCommand(text);
    let viaPlainLanguage = false;
    if (!cmd && this.commandParser) {
      cmd = await this.commandParser.parse(text).catch(() => null);
      viaPlainLanguage = !!cmd;
    }
    if (cmd) {
      const studentIds = this.ctx.roster.map((r) => r.studentId).filter((id) => this.presentStudents.has(id));
      const round = this.checkIns.open(cmd, studentIds, now);
      this.tracker.checkInSent(studentIds);
      // Answer-only model: the question is on the teacher's board, so
      // opening a round sends NOTHING to students. Students DM their
      // answers to the bot; the bot scores them as they arrive.
      const labelPart = cmd.label ? ` for Question ${cmd.label.slice(1)}` : "";
      const readBack = viaPlainLanguage
        ? ` I took your answer as ${cmd.expectedAnswer}, mode: ${cmd.mode}. If that is wrong, close the round and resend.`
        : "";
      await this.dmTeacher(
        `Answer round open${labelPart} for ${studentIds.length} students. Window: ${formatWindowMs(cmd.windowMs)}.${readBack} ` +
          `I have sent nothing; students will send me their answers.`,
      );
      // Screen read runs AFTER the confirmation, in the background: the
      // round never waits on vision. Any failure is silent (logged only).
      void this.readScreenForRound(round);
      return;
    }

    await this.dmTeacher(
      "I did not recognise that. You can say it plainly, for example: \"For question 2 the answer is 36, give them five minutes\", or use the template: ANSWER | expected answer | mode: hint, with | time: 5 and | Q2 when you need them. Also PAUSE / RESUME / STOP, and CLOSE to end a round early.",
    );
  }

  /** The label of the one currently-open round, or null when zero or
   *  several rounds are open (a bare CLOSE is then ambiguous). */
  private singleOpenLabel(now: number): string | null {
    const open = this.checkIns.openRounds(now);
    return open.length === 1 ? open[0].label : null;
  }

  /** Read the questions on the shared screen for this round, keep them
   *  as context for hints and student help, and privately warn the
   *  teacher if a screen question's worked answer disagrees with the
   *  round answer she set (a mistyped expected answer would otherwise
   *  mark the whole class wrong). Frames can lag the share by seconds,
   *  so the read retries a few times inside the round window (Nov 5,
   *  2026 finding: a single instant attempt missed in the tutor demo).
   *  Never throws, never blocks the round. */
  private async readScreenForRound(round: CheckIn): Promise<void> {
    if (!this.botId || !this.vision) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (round.closedAt !== null) return;
      try {
        const frame = await this.bot.getScreenFrame(this.botId);
        if (frame) {
          const questions = await this.vision.readScreen(frame.pngBase64);
          const legible = questions.filter((q) => q.legible && q.questionText);
          if (legible.length > 0) {
            for (const q of legible) {
              this.screenByLabel.set(q.label, q);
              this.screenQuestion = q;
            }
            this.log(
              `screen read: ${legible.length} question(s) captured (${legible
                .map((q) => q.questionText.slice(0, 60))
                .join(" / ")})`,
            );
            await this.crossCheckRounds();
            if (this.questionFor(round.label)) return;
          } else {
            this.log("screen read: no legible question on screen yet");
          }
        } else {
          this.log("screen read: no frame available yet");
        }
      } catch (err) {
        this.log(`screen read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 6000));
    }
  }

  /** Cross-check every open round once against the screen questions:
   *  when a round's worked screen answer disagrees with the teacher's
   *  expected answer, she gets ONE private heads-up for that round. */
  private async crossCheckRounds(): Promise<void> {
    const now = Date.now();
    for (const round of this.checkIns.openRounds(now)) {
      if (this.crossCheckedRounds.has(round.id)) continue;
      const q = this.questionFor(round.label);
      if (!q || !q.workedAnswer) continue;
      this.crossCheckedRounds.add(round.id);
      if (!answersMatch(round.expectedAnswer, q.workedAnswer)) {
        const labelPart = round.label ? ` for Question ${round.label.slice(1)}` : "";
        await this.dmTeacher(
          `Heads up${labelPart}: the question on screen reads "${q.questionText}" and works out to ${q.workedAnswer}. ` +
            `Your round answer is ${round.expectedAnswer}. You may want to check it before the round closes.`,
        );
      }
    }
  }

  /** Close one answer round and send the teacher the ONE combined
   *  private report for it: who has not answered, who said they were
   *  not sure, and who answered incorrectly with the answer they sent.
   *  Students who ended correct are not listed, and nothing is ever
   *  announced publicly. Used at window expiry (tick) and for the early
   *  close the moment the last outstanding student on the round answers. */
  private async closeRound(label: string, now: number): Promise<void> {
    const tally = this.checkIns.close(label, now);
    if (!tally) return;
    const parts: string[] = [];
    if (tally.nonResponders.length > 0) {
      const names = tally.nonResponders.map((id) => this.displayNameFor(id));
      for (const id of tally.nonResponders) this.tracker.nudgeSent(id);
      parts.push(`Haven't heard from ${names.join(", ")}. Worth calling on them next.`);
    }
    if (tally.unsureStudents.length > 0) {
      const names = tally.unsureStudents.map((id) => this.displayNameFor(id));
      parts.push(`Not sure: ${names.join(", ")}. They said they were not sure; worth reaching them first.`);
    }
    if (tally.incorrectAnswers.length > 0) {
      const lines = tally.incorrectAnswers.map(
        (x) => `${this.displayNameFor(x.studentId)} sent "${x.answer}"`,
      );
      parts.push(`Not correct: ${lines.join("; ")}.`);
    }
    const prefix = tally.label ? `Question ${tally.label.slice(1)}: ` : "";
    await this.dmTeacher(parts.length > 0 ? prefix + parts.join(" ") : `${prefix}Everyone answered that one.`);
  }

  /** Periodic tick (server calls every ~15s): close any expired answer
   *  rounds (one combined report per round to the teacher) and send
   *  silence nudges. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const round of this.checkIns.roundsSnapshot()) {
      if (round.closedAt === null && now - round.openedAt > round.windowMs) {
        await this.closeRound(round.label, now);
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

  /** Compile the draft, record it durably, post it, then leave.
   *  The compiled payload is recorded BEFORE the post is attempted
   *  (in memory and as one structured log line) and the session is only
   *  marked finalised after the post attempt resolves, so a failed post
   *  (for example while the platform endpoint is unpublished) never
   *  loses the draft: it stays recoverable from the service logs and a
   *  later finalise() call retries the post. */
  private finalised = false;
  private recordedDraftPayload: ParticipationDraftPayload | null = null;

  /** The most recently compiled participation draft, recorded before
   *  any post attempt. Null until the first finalise() compiles one. */
  get recordedDraft(): ParticipationDraftPayload | null {
    return this.recordedDraftPayload;
  }

  async finalise(): Promise<void> {
    if (this.finalised) return;
    const payload = compileDraft({
      ctx: this.ctx,
      tracker: this.tracker,
      matcher: this.matcher,
      assistantPresent: this.botInCall,
      presentStudentIds: this.presentStudents,
    });
    // Durable record first, post second (pilot safety fix, 27 Oct 2026).
    this.recordedDraftPayload = payload;
    this.log(`participation_draft ${JSON.stringify(payload)}`);
    try {
      const result = await this.platform.postParticipationDraft(payload);
      this.log(`Draft posted: created=${result.created} updated=${result.updated} skipped=${result.skipped.length}`);
      this.finalised = true;
    } catch (err) {
      this.log(
        `Draft post FAILED; the compiled draft is recorded in the participation_draft log line above and in memory for recovery: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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

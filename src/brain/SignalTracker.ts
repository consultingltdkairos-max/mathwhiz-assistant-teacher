// Per-student signal counts (spec v1 Section 1.3): S spoke, C public chat,
// A answered the assistant privately, Q asked the assistant a question.
// All counts are keyed by platform studentId, only ever set for
// high-confidence roster matches (RosterMatcher decides).

import type { StudentSignals } from "../types.js";

function emptySignals(): StudentSignals {
  return {
    speakingTurns: 0,
    speakingSegments: new Set(),
    chatPublic: 0,
    chatAnswers: 0,
    chatQuestions: 0,
    checkinsSent: 0,
    checkinsAnswered: 0,
    checkinsCorrect: 0,
    checkinsCorrectWithHint: 0,
    privateQuestions: 0,
    nudgesSent: 0,
    lastSignalAt: null,
  };
}

export type ClassSegment = "early" | "middle" | "late";

export class SignalTracker {
  private byStudent = new Map<string, StudentSignals>();

  constructor(
    studentIds: string[],
    private startedAt: number,
    private durationMs: number,
  ) {
    for (const id of studentIds) this.byStudent.set(id, emptySignals());
  }

  private segment(now: number): ClassSegment {
    const elapsed = (now - this.startedAt) / this.durationMs;
    return elapsed < 1 / 3 ? "early" : elapsed < 2 / 3 ? "middle" : "late";
  }

  private touch(studentId: string, now: number): StudentSignals {
    const s = this.byStudent.get(studentId) ?? emptySignals();
    this.byStudent.set(studentId, s);
    s.lastSignalAt = now;
    return s;
  }

  transcript(studentId: string, now: number): void {
    const s = this.touch(studentId, now);
    s.speakingTurns += 1;
    s.speakingSegments.add(this.segment(now));
  }

  publicChat(studentId: string, text: string, checkInOpen: boolean, now: number): void {
    const s = this.touch(studentId, now);
    s.chatPublic += 1;
    // Heuristics only, and correctness is never inferred here: a public
    // message counts as a chat *answer* when a check-in is open or the
    // teacher's floor is open (refined in SessionManager); a trailing "?"
    // counts as a question. The teacher sees the evidence line, not a claim.
    if (/\?\s*$/.test(text.trim())) s.chatQuestions += 1;
    else if (checkInOpen) s.chatAnswers += 1;
  }

  privateAnswer(studentId: string, now: number): void {
    this.touch(studentId, now);
  }

  privateQuestion(studentId: string, now: number): void {
    const s = this.touch(studentId, now);
    s.privateQuestions += 1;
  }

  checkInSent(studentIds: string[]): void {
    for (const id of studentIds) {
      const s = this.byStudent.get(id);
      if (s) s.checkinsSent += 1;
    }
  }

  /** The student's FIRST scored reply to a check-in. This is the only
   *  place checkinsAnswered moves: a hint-mode retry is the same answer
   *  being finished, not a second answer. */
  checkInResult(studentId: string, correct: boolean, now: number): void {
    const s = this.touch(studentId, now);
    s.checkinsAnswered += 1;
    if (correct) s.checkinsCorrect += 1;
  }

  /** A correct scored retry after a hint (hint mode). Counted separately
   *  from a first-try correct and does NOT count as another answer. A
   *  wrong retry needs no call: the first reply already recorded the
   *  answer as not correct. */
  checkInRetryResult(studentId: string, now: number): void {
    const s = this.touch(studentId, now);
    s.checkinsCorrectWithHint += 1;
  }

  nudgeSent(studentId: string): void {
    const s = this.byStudent.get(studentId);
    if (s) s.nudgesSent += 1;
  }

  get(studentId: string): StudentSignals {
    return this.byStudent.get(studentId) ?? emptySignals();
  }

  all(): Map<string, StudentSignals> {
    return this.byStudent;
  }
}

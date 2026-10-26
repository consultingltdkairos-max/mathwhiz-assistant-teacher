// Check-in engine, spec v1 Section 1.4.
// Teacher command (DM to the bot):
//   CHECKIN | question text | expected answer | mode: confirm-or-hint
// The bot DMs the question to every matched roster student, collects
// private replies for the window (default 3 minutes), checks each reply
// deterministically against the teacher's answer, replies privately, and
// DMs the teacher the tally when the window closes.
// Scoring: one scored first reply per student. In hint mode a wrong
// first reply earns a hint and exactly ONE scored retry (correct on the
// retry is "correct_with_hint", never a first-try "correct"; wrong on
// the retry closes the question). Confirm mode has no retry. Any
// further reply is consumed but ignored for scoring.

import type { CheckIn, CheckInMode } from "../types.js";

export interface ParsedCheckInCommand {
  question: string;
  expectedAnswer: string;
  mode: CheckInMode;
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 3 * 60 * 1000;

export function parseCheckInCommand(text: string): ParsedCheckInCommand | null {
  const m = text.trim().match(/^CHECKIN\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*mode:\s*(confirm|hint)\s*$/i);
  if (!m) return null;
  return {
    question: m[1],
    expectedAnswer: m[2],
    mode: m[3].toLowerCase() as CheckInMode,
    windowMs: DEFAULT_WINDOW_MS, // TODO: allow "| window: 2m" suffix per spec ("teacher can set")
  };
}

/** Deterministic maths-answer comparison: normalises whitespace, case,
 *  trivial formatting (x=4 vs "4", trailing units) before comparing.
 *  Deliberately conservative: anything ambiguous counts as incorrect for
 *  the tally but the teacher sees every raw reply in the session log. */
export function answersMatch(expected: string, given: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/^[a-z]=/, "") // strip a leading "x=" style prefix
      .replace(/\.0+$/, "");
  return norm(expected) === norm(given);
}

/** What recordReply did with one student DM. A null return from
 *  recordReply means the check-in did not consume the message at all
 *  (no check-in open, window expired, or the student is not on this
 *  check-in's roster) and the caller should treat it as other traffic. */
export type CheckInReplyResult =
  | {
      kind: "scored";
      /** "first" = the student's first reply; "retry" = the single
       *  hint-mode retry after a wrong first reply. */
      attempt: "first" | "retry";
      correct: boolean;
      replyText: string;
    }
  | {
      /** The student's outcome for this check-in is already final.
       *  The message is consumed (it was meant as a check-in reply)
       *  but changes no score. */
      kind: "ignored";
      replyText: string;
    };

export class CheckInEngine {
  private current: CheckIn | null = null;
  private seq = 0;

  open(cmd: ParsedCheckInCommand, studentIds: string[], now: number): CheckIn {
    this.seq += 1;
    this.current = {
      id: `checkin-${this.seq}`,
      question: cmd.question,
      expectedAnswer: cmd.expectedAnswer,
      mode: cmd.mode,
      windowMs: cmd.windowMs,
      openedAt: now,
      closedAt: null,
      results: new Map(studentIds.map((id) => [id, "no_response" as const])),
    };
    return this.current;
  }

  isOpen(now: number): boolean {
    return !!this.current && this.current.closedAt === null && now - this.current.openedAt <= this.current.windowMs;
  }

  /** Record a student's private reply and say what to DM back. */
  recordReply(studentId: string, text: string, now: number): CheckInReplyResult | null {
    const c = this.current;
    if (!c || !this.isOpen(now)) return null;
    const state = c.results.get(studentId);
    if (state === undefined) return null; // not on this check-in's roster

    if (state === "no_response") {
      const correct = answersMatch(c.expectedAnswer, text);
      if (correct) {
        c.results.set(studentId, "correct");
        const praise = ["Yes, correct. Well done.", "Correct, nice work.", "Yes, that's right."];
        return {
          kind: "scored",
          attempt: "first",
          correct: true,
          replyText: praise[Math.floor(Math.random() * praise.length)],
        };
      }
      if (c.mode === "hint") {
        // One hint aimed at the step, never the answer itself, and the
        // student moves to "hint_pending": exactly one scored retry.
        // TODO: hint text comes from a per-question hint the teacher may add
        // to the command; until then a generic step hint is used.
        c.results.set(studentId, "hint_pending");
        return {
          kind: "scored",
          attempt: "first",
          correct: false,
          replyText:
            "Not quite. Recheck the step where you move the number across the equals sign, then try once more.",
        };
      }
      c.results.set(studentId, "incorrect");
      return { kind: "scored", attempt: "first", correct: false, replyText: "Not quite, thanks for trying." };
    }

    if (state === "hint_pending") {
      const correct = answersMatch(c.expectedAnswer, text);
      if (correct) {
        c.results.set(studentId, "correct_with_hint");
        return {
          kind: "scored",
          attempt: "retry",
          correct: true,
          replyText: "Correct, you got it with the hint. Well done.",
        };
      }
      c.results.set(studentId, "incorrect");
      return {
        kind: "scored",
        attempt: "retry",
        correct: false,
        replyText: "Not quite, but good try. That closes this check in for you.",
      };
    }

    // "correct" | "correct_with_hint" | "incorrect": outcome is final.
    return { kind: "ignored", replyText: "Thanks, I already have your answer for this check in." };
  }

  /** Names (studentIds) with no response, for the teacher tally + nudges. */
  nonResponders(): string[] {
    if (!this.current) return [];
    return [...this.current.results.entries()].filter(([, v]) => v === "no_response").map(([k]) => k);
  }

  close(
    now: number,
  ): { answered: number; correct: number; correctWithHint: number; nonResponders: string[] } | null {
    const c = this.current;
    if (!c || c.closedAt !== null) return null;
    c.closedAt = now;
    // A student who took the hint but never retried answered incorrectly;
    // settle the working state so the results map holds final outcomes only.
    for (const [id, v] of c.results) {
      if (v === "hint_pending") c.results.set(id, "incorrect");
    }
    const values = [...c.results.values()];
    return {
      answered: values.filter((v) => v !== "no_response").length,
      correct: values.filter((v) => v === "correct").length,
      correctWithHint: values.filter((v) => v === "correct_with_hint").length,
      nonResponders: this.nonResponders(),
    };
  }

  get active(): CheckIn | null {
    return this.current;
  }
}

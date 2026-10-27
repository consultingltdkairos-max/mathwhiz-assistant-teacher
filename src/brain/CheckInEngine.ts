// Answer-round engine, spec v1 Section 1.4 as corrected 27 Oct 2026
// (Kevoy's classroom model; see the build spec's correction note).
//
// How classes actually run: the teacher teaches live and writes the
// question on the shared screen or whiteboard, so students see it there.
// The bot NEVER sends the question anywhere, not publicly and not by DM.
// The teacher opens a round by DMing the bot the expected answer only:
//   ANSWER | expected answer | mode: confirm-or-hint
// (mode optional, default hint). Opening a round sends NOTHING to
// students. Students DM their answers to the bot during the window
// (default 3 minutes); each reply is checked deterministically against
// the teacher's answer and answered privately. When the round closes,
// the teacher gets ONE private DM naming everyone who did not answer,
// or confirming that everyone answered.
//
// Scoring: one scored first reply per student. In hint mode a wrong
// first reply earns a hint and exactly ONE scored retry (correct on the
// retry is "correct_with_hint", never a first-try "correct"; wrong on
// the retry closes the question). Confirm mode has no retry. Any
// further reply is consumed but ignored for scoring.
//
// Liberal parsing, strict behaviour: the legacy CHECKIN format
// (CHECKIN | question | expected answer | mode: ...) is still accepted
// for the teacher's convenience, but only its expected-answer field is
// used; the question text is discarded and never relayed.

import type { CheckIn, CheckInMode } from "../types.js";

export interface ParsedRoundCommand {
  expectedAnswer: string;
  mode: CheckInMode;
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 3 * 60 * 1000;

export function parseRoundCommand(text: string): ParsedRoundCommand | null {
  const t = text.trim();

  // ANSWER | expected answer [| mode: confirm-or-hint]
  let m = t.match(/^ANSWER\s*\|\s*(.+?)(?:\s*\|\s*mode:\s*(confirm|hint))?\s*$/i);
  if (m) {
    return {
      expectedAnswer: m[1],
      mode: (m[2]?.toLowerCase() as CheckInMode) ?? "hint",
      windowMs: DEFAULT_WINDOW_MS, // TODO: allow "| window: 2m" suffix per spec ("teacher can set")
    };
  }

  // Legacy: CHECKIN | question | expected answer [| mode: confirm-or-hint]
  // The question (group 1) is deliberately discarded: never relayed.
  m = t.match(/^CHECKIN\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*mode:\s*(confirm|hint))?\s*$/i);
  if (m) {
    return {
      expectedAnswer: m[2],
      mode: (m[3]?.toLowerCase() as CheckInMode) ?? "hint",
      windowMs: DEFAULT_WINDOW_MS,
    };
  }

  return null;
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
 *  recordReply means the round did not consume the message at all
 *  (no round open, window expired, or the student is not on this
 *  round's roster) and the caller should treat it as other traffic. */
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
      /** The student's outcome for this round is already final.
       *  The message is consumed (it was meant as an answer)
       *  but changes no score. */
      kind: "ignored";
      replyText: string;
    };

export class CheckInEngine {
  private current: CheckIn | null = null;
  private seq = 0;

  open(cmd: ParsedRoundCommand, studentIds: string[], now: number): CheckIn {
    this.seq += 1;
    this.current = {
      id: `checkin-${this.seq}`,
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

  /** True once every student on the round's roster has a FINAL outcome
   *  (correct, correct_with_hint or incorrect). A student still waiting
   *  to reply, or holding an unused hint-mode retry, is outstanding. */
  allFinal(): boolean {
    const c = this.current;
    if (!c || c.closedAt !== null || c.results.size === 0) return false;
    for (const v of c.results.values()) {
      if (v === "no_response" || v === "hint_pending") return false;
    }
    return true;
  }

  /** Record a student's private reply and say what to DM back. */
  recordReply(studentId: string, text: string, now: number): CheckInReplyResult | null {
    const c = this.current;
    if (!c || !this.isOpen(now)) return null;
    const state = c.results.get(studentId);
    if (state === undefined) return null; // not on this round's roster

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

  /** Names (studentIds) with no response, for the teacher report. */
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

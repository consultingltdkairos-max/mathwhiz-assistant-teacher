// Answer-round engine, spec v1 Section 1.4 as corrected 27 Oct 2026
// (Kevoy's classroom model; see the build spec's correction note).
//
// How classes actually run: the teacher teaches live and writes the
// question on the shared screen or whiteboard, so students see it there.
// The bot NEVER sends the question anywhere, not publicly and not by DM.
// The teacher opens a round by DMing the bot the expected answer:
//   ANSWER | expected answer | mode: hint
// Opening a round sends NOTHING to students. Students DM their answers
// to the bot during the window; each reply is checked deterministically
// against the teacher's answer and answered privately. When a round
// closes, the teacher gets ONE private DM naming everyone who did not
// answer, everyone who answered incorrectly (with the answer sent), and
// everyone who said they were not sure. Nothing is ever announced
// publicly and no student is ever named in the room.
//
// Nov 5, 2026 findings round (from the live tutor demo), added here:
// - The teacher can set the window per question:  | time: 5  (minutes),
//   or | time: 90s.
// - Several questions can be open at once when the board carries more
//   than one, labelled:  | Q1   | Q2   (also "Question 1"). Students
//   may prefix an answer with its label ("Q2: 36"); with one round open
//   a bare answer still goes to that round.
// - A student who replies that they do not know is NOT scored wrong:
//   they get a compassionate reply pointing them back to the teacher,
//   and the teacher hears about them separately at close.
// - answersMatch is hardened (fractions, percents, currency, thousands
//   separators, algebraic term order) after a correct-after-hint answer
//   was marked incorrect in the demo.
//
// Replies (Kevoy ruling, Nov 5, 2026): correct answers get a clear,
// varied confirmation from the praise pool; a wrong first reply in hint
// mode gets a short "not quite, one more try" line (or the vision hint
// when the screen question is known, supplied by the SessionManager);
// a final wrong answer gets a line that sends the student back to the
// teacher for the full correction.
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
  /** "Q1", "Q2", ... or "" for an unlabelled round. */
  label: string;
}

const DEFAULT_WINDOW_MS = 3 * 60 * 1000;

function parseWindowMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_WINDOW_MS;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins)?$/i);
  if (!m) return DEFAULT_WINDOW_MS;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  const unit = (m[2] ?? "m").toLowerCase();
  return Math.round(unit.startsWith("s") ? n * 1000 : n * 60 * 1000);
}

export function formatWindowMs(ms: number): string {
  if (ms % 60000 === 0) {
    const n = ms / 60000;
    return `${n} minute${n === 1 ? "" : "s"}`;
  }
  if (ms < 60000) {
    const n = Math.round(ms / 1000);
    return `${n} second${n === 1 ? "" : "s"}`;
  }
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins} minute${mins === 1 ? "" : "s"} ${secs} seconds` : `${mins} minutes`;
}

function parseLabel(raw: string): string {
  const m = raw.trim().match(/^(?:q|question)\s*([0-9]+)$/i);
  return m ? `Q${m[1]}` : "";
}

/** Parse the teacher's round command. Segments after the answer may
 *  appear in any order: mode:, time:/window:, and a label (Q1...). */
export function parseRoundCommand(text: string): ParsedRoundCommand | null {
  const t = text.trim();

  const answerForm = t.match(/^ANSWER\s*\|\s*(.+)$/i);
  const legacyForm = answerForm ? null : t.match(/^CHECKIN\s*\|\s*(.+)$/i);
  const rest = answerForm?.[1] ?? legacyForm?.[1];
  if (rest === undefined) return null;

  const segments = rest.split("|").map((s) => s.trim());
  let expectedAnswer: string;
  let opts: string[];
  if (legacyForm) {
    // CHECKIN | question | expected answer | opts... ; question dropped.
    if (segments.length < 2) return null;
    expectedAnswer = segments[1];
    opts = segments.slice(2);
  } else {
    expectedAnswer = segments[0];
    opts = segments.slice(1);
  }
  if (!expectedAnswer) return null;

  let mode: CheckInMode = "hint";
  let windowMs = DEFAULT_WINDOW_MS;
  let label = "";
  for (const seg of opts) {
    const modeM = seg.match(/^mode:\s*(confirm|hint)$/i);
    if (modeM) {
      mode = modeM[1].toLowerCase() as CheckInMode;
      continue;
    }
    const timeM = seg.match(/^(?:time|window):\s*(.+)$/i);
    if (timeM) {
      windowMs = parseWindowMs(timeM[1]);
      continue;
    }
    const lbl = parseLabel(seg);
    if (lbl) label = lbl;
    // Unrecognised segments are ignored deliberately (liberal parsing),
    // EXCEPT that a "mode:" segment with an unknown value would change
    // scoring silently, so the legacy strictness is preserved there:
    // a malformed mode falls back to the whole-command rejection below.
    if (/^mode:/i.test(seg)) return null;
  }

  return { expectedAnswer, mode, windowMs, label };
}

/** Split a student's message into an optional question label prefix and
 *  the answer text. "Q2: 36" -> { label: "Q2", text: "36" }. Returns the
 *  text unchanged when there is no recognisable prefix. Callers should
 *  only honour the label when a round with that label is open. */
export function splitAnswerLabel(text: string): { label: string; text: string } {
  const m = text.match(/^\s*(?:q|question)\s*([0-9]+)\s*[:.\-]?\s+(\S[\s\S]*)$/i);
  if (m) return { label: `Q${m[1]}`, text: m[2].trim() };
  const bare = text.match(/^\s*(?:q|question)\s*([0-9]+)\s*[:.\-]\s*(\S[\s\S]*)$/i);
  if (bare) return { label: `Q${bare[1]}`, text: bare[2].trim() };
  return { label: "", text };
}

// ---------------------------------------------------------------------
// Answer matching. Demo finding (Nov 5, 2026): a student who entered the
// correct answer after a hint was still marked incorrect. The matcher
// now handles, in order: basic normalisation (case, spaces, "x = 7"
// prefixes, trailing punctuation, currency symbols, % signs, thousands
// separators), exact numeric equality (including fractions and mixed
// numbers), then algebraic equivalence for simple sums of terms in any
// order ("5b + 3a" equals "3a + 5b"). Anything still ambiguous counts as
// incorrect for the tally, and the teacher sees the raw text at close.
// ---------------------------------------------------------------------

function basicNorm(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/^(?:answer|ans)[:=]/, "")
    .replace(/^[a-z][:](?=[0-9])/, "") // "x: 7" style
    .replace(/^[a-z]=/, "") // "x=7" style
    .replace(/^(?:j\$|us\$|\$|£|€)/, "")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/%$/, "")
    .replace(/\.$/, "")
    .replace(/\.0+$/, "");
}

function parseNumeric(s: string): number | null {
  if (!s) return null;
  const mixed = s.match(/^(-?\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const frac = Number(mixed[2]) / Number(mixed[3]);
    return whole < 0 || mixed[1].startsWith("-") ? whole - frac : whole + frac;
  }
  const fracM = s.match(/^(-?\d+)\/(\d+)$/);
  if (fracM) return Number(fracM[1]) / Number(fracM[2]);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/** Terms of a simple algebraic sum, normalised to "coefficient|letters"
 *  with letters sorted, so term order does not matter. Returns null when
 *  the expression is not a simple sum of numeric/letter terms. */
function algebraicTerms(s: string): string[] | null {
  const flat = s.replace(/\s+/g, "");
  if (!/[a-z]/.test(flat)) return null;
  const parts = flat.match(/[+-]?[^+-]+/g);
  if (!parts) return null;
  const terms: string[] = [];
  for (const raw of parts) {
    const m = raw.match(/^([+-]?)(\d+(?:\.\d+)?|\d+\/\d+)?([a-z]+)$/);
    if (!m) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const coef = m[2] ? (parseNumeric(m[2]) ?? NaN) : 1;
    if (!Number.isFinite(coef)) return null;
    const letters = m[3].split("").sort().join("");
    terms.push(`${sign * coef}|${letters}`);
  }
  return terms.sort();
}

export function answersMatch(expected: string, given: string): boolean {
  const e = basicNorm(expected);
  const g = basicNorm(given);
  if (e === g) return true;

  const en = parseNumeric(e.replace(/\s+/g, " ").trim()) ?? parseNumeric(e);
  const gn = parseNumeric(g.replace(/\s+/g, " ").trim()) ?? parseNumeric(g);
  if (en !== null && gn !== null) return Math.abs(en - gn) < 1e-9;

  const et = algebraicTerms(expected);
  const gt = algebraicTerms(given);
  if (et && gt) return et.length === gt.length && et.every((t, i) => t === gt[i]);

  return false;
}

/** What recordReply did with one student DM. A null return means no
 *  round consumed the message and the caller treats it as other
 *  traffic. */
export type CheckInReplyResult =
  | {
      kind: "scored";
      attempt: "first" | "retry";
      correct: boolean;
      replyText: string;
      /** Label of the round that scored this reply ("" if unlabelled). */
      roundLabel: string;
    }
  | {
      /** The student said they do not know. Not scored as incorrect;
       *  firstReply says whether this consumed their first reply. */
      kind: "unsure";
      firstReply: boolean;
      replyText: string;
      roundLabel: string;
    }
  | {
      /** Several rounds are open and this answer could belong to more
       *  than one of them; the student is asked to name the question. */
      kind: "needs_label";
      replyText: string;
    }
  | {
      /** The student's outcome for this round is already final. */
      kind: "ignored";
      replyText: string;
    };

const pick = (pool: string[]): string => pool[Math.floor(Math.random() * pool.length)];

const PRAISE: string[] = [
  "Yes, correct. Well done.",
  "Correct, nice work.",
  "Yes, that's right.",
  "Awesome job, that's correct.",
  "You got it. Well done.",
  "Exactly right, great work.",
];

const RETRY: string[] = [
  "Not quite, but give it one more try.",
  "Close. Have another go.",
  "Not quite yet, try once more.",
  "Good effort, take one more try.",
];

const RETRY_SUCCESS: string[] = [
  "There you go, correct now. Well done.",
  "Yes, that's it now. Good persistence.",
  "Correct on the second go, nice work.",
];

const UNSURE_PHRASES = new Set([
  "i don't know",
  "i dont know",
  "idk",
  "not sure",
  "i'm not sure",
  "im not sure",
  "unsure",
  "no idea",
  "i have no idea",
  "dunno",
  "?",
  "i don't know.",
]);

export function isUnsureReply(text: string): boolean {
  const n = text.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.]+$/, "");
  return UNSURE_PHRASES.has(n) || UNSURE_PHRASES.has(`${n}.`);
}

export interface RoundTally {
  label: string;
  answered: number;
  correct: number;
  correctWithHint: number;
  nonResponders: string[];
  incorrectAnswers: { studentId: string; answer: string }[];
  /** Students who said they were not sure: engaged, honest, and the
   *  teacher should reach them first. Listed separately at close. */
  unsureStudents: string[];
}

export class CheckInEngine {
  private rounds = new Map<string, CheckIn>();
  private lastLabel = "";
  private seq = 0;
  /** The teacher's display name, for the replies that send a student
   *  back to the teacher. Set by the session manager. */
  private teacherLabel: string | null = null;

  setTeacherLabel(name: string | null): void {
    this.teacherLabel = name && name.trim() ? name.trim() : null;
  }

  private teacherName(): string {
    return this.teacherLabel ?? "your teacher";
  }

  private finalWrongReply(): string {
    const t = this.teacherName();
    return pick([
      `Not quite. Hold on, ${t} will go over the full correction shortly.`,
      `Not this time. Sit tight, ${t} will go through the correction in a moment.`,
      `Not quite. Keep your working there, ${t} will work through the correction with the class.`,
    ]);
  }

  private unsureReply(): string {
    const t = this.teacherName();
    return pick([
      `That is okay, thank you for telling me honestly. Listen in while ${t} goes over it, and message me after if you are still stuck.`,
      `No worries at all. Stay with the lesson, ${t} will go through it, and I can help you practise it after.`,
      `Thanks for saying so. Keep listening, ${t} will work through this one, and we can try a similar one together after.`,
    ]);
  }

  open(cmd: ParsedRoundCommand, studentIds: string[], now: number): CheckIn {
    this.seq += 1;
    const round: CheckIn = {
      id: `checkin-${this.seq}`,
      label: cmd.label,
      expectedAnswer: cmd.expectedAnswer,
      mode: cmd.mode,
      windowMs: cmd.windowMs,
      openedAt: now,
      closedAt: null,
      results: new Map(studentIds.map((id) => [id, "no_response" as const])),
      wrongAnswers: new Map(),
    };
    // Re-issuing a round with the same label replaces the old one
    // (the teacher corrected herself); other labels are untouched.
    this.rounds.set(cmd.label, round);
    this.lastLabel = cmd.label;
    return round;
  }

  /** The most recently opened round, whatever its state. */
  get active(): CheckIn | null {
    return this.rounds.get(this.lastLabel) ?? null;
  }

  round(label: string): CheckIn | null {
    return this.rounds.get(label) ?? null;
  }

  openRounds(now: number): CheckIn[] {
    return [...this.rounds.values()].filter(
      (r) => r.closedAt === null && now - r.openedAt <= r.windowMs,
    );
  }

  /** Every round, open or closed, for the session tick's expiry sweep. */
  roundsSnapshot(): CheckIn[] {
    return [...this.rounds.values()];
  }

  isOpen(now: number): boolean {
    return this.openRounds(now).length > 0;
  }

  /** True once every student on the round has a FINAL outcome. */
  allFinal(label: string): boolean {
    const c = this.rounds.get(label);
    if (!c || c.closedAt !== null || c.results.size === 0) return false;
    for (const v of c.results.values()) {
      if (v === "no_response" || v === "hint_pending") return false;
    }
    return true;
  }

  /** Record a student's private reply and say what to DM back.
   *  labelHint comes from the student's own prefix ("Q2: 36"); when it
   *  is empty the reply goes to the single open round that expects the
   *  student, or asks for the label when several could take it. */
  recordReply(
    studentId: string,
    text: string,
    now: number,
    labelHint = "",
  ): CheckInReplyResult | null {
    let round: CheckIn | undefined;
    if (labelHint) {
      const r = this.rounds.get(labelHint);
      if (r && r.closedAt === null && now - r.openedAt <= r.windowMs && r.results.has(studentId)) {
        round = r;
      }
      if (!round) return null; // labelled for a round that is not theirs/open
    } else {
      const candidates = this.openRounds(now).filter((r) => r.results.has(studentId));
      const live = candidates.filter((r) => {
        const s = r.results.get(studentId);
        return s === "no_response" || s === "hint_pending";
      });
      if (live.length === 1) round = live[0];
      else if (live.length > 1) {
        return {
          kind: "needs_label",
          replyText:
            "You have more than one question open. Start your answer with the question number, like this: Q1: 12",
        };
      } else if (candidates.length === 1) round = candidates[0]; // final already: ignored below
      else return null;
    }

    const c = round;
    const state = c.results.get(studentId);
    if (state === undefined) return null;

    // An honest "I don't know" is never scored as a wrong answer.
    if ((state === "no_response" || state === "hint_pending") && isUnsureReply(text)) {
      const firstReply = state === "no_response";
      c.results.set(studentId, "unsure");
      return { kind: "unsure", firstReply, replyText: this.unsureReply(), roundLabel: c.label };
    }

    if (state === "no_response") {
      const correct = answersMatch(c.expectedAnswer, text);
      if (correct) {
        c.results.set(studentId, "correct");
        return { kind: "scored", attempt: "first", correct: true, replyText: pick(PRAISE), roundLabel: c.label };
      }
      c.wrongAnswers.set(studentId, text.trim());
      if (c.mode === "hint") {
        c.results.set(studentId, "hint_pending");
        return { kind: "scored", attempt: "first", correct: false, replyText: pick(RETRY), roundLabel: c.label };
      }
      c.results.set(studentId, "incorrect");
      return { kind: "scored", attempt: "first", correct: false, replyText: this.finalWrongReply(), roundLabel: c.label };
    }

    if (state === "hint_pending") {
      const correct = answersMatch(c.expectedAnswer, text);
      if (correct) {
        c.results.set(studentId, "correct_with_hint");
        c.wrongAnswers.delete(studentId);
        return { kind: "scored", attempt: "retry", correct: true, replyText: pick(RETRY_SUCCESS), roundLabel: c.label };
      }
      c.results.set(studentId, "incorrect");
      c.wrongAnswers.set(studentId, text.trim());
      return { kind: "scored", attempt: "retry", correct: false, replyText: this.finalWrongReply(), roundLabel: c.label };
    }

    // correct | correct_with_hint | incorrect | unsure: already final.
    return { kind: "ignored", replyText: "Thanks, I already have your answer for this check in." };
  }

  /** Names (studentIds) with no response on a round, for the teacher. */
  nonResponders(label: string): string[] {
    const c = this.rounds.get(label);
    if (!c) return [];
    return [...c.results.entries()].filter(([, v]) => v === "no_response").map(([k]) => k);
  }

  close(label: string, now: number): RoundTally | null {
    const c = this.rounds.get(label);
    if (!c || c.closedAt !== null) return null;
    c.closedAt = now;
    // A student who took the retry invitation but never retried answered
    // incorrectly; settle the working state so results hold finals only.
    for (const [id, v] of c.results) {
      if (v === "hint_pending") c.results.set(id, "incorrect");
    }
    const values = [...c.results.values()];
    return {
      label,
      answered: values.filter((v) => v !== "no_response").length,
      correct: values.filter((v) => v === "correct").length,
      correctWithHint: values.filter((v) => v === "correct_with_hint").length,
      nonResponders: this.nonResponders(label),
      incorrectAnswers: [...c.results.entries()]
        .filter(([, v]) => v === "incorrect")
        .map(([id]) => ({ studentId: id, answer: c.wrongAnswers.get(id) ?? "" })),
      unsureStudents: [...c.results.entries()]
        .filter(([, v]) => v === "unsure")
        .map(([id]) => id),
    };
  }
}

// The platform's participation indicator set, pulled verbatim from the live
// database on 26 Oct 2026 (participation_evaluations.indicators). The stored
// strings govern: two of them contain an em dash. The assistant may ONLY
// suggest strings from this list, and the platform endpoint validates
// against the same set.

export const INDICATORS = {
  activeMicAndChat: "Actively participates using both microphone and chat",
  alwaysWilling: "Always willing to participate when given the opportunity",
  appearsAttentive: "Appears attentive and engaged throughout class",
  appearsDistracted: "Appears distracted or disengaged at times",
  asksQuestions: "Asks questions when clarification is needed",
  attemptsUnsure: "Attempts questions even when unsure",
  limited: "Limited participation during class",
  occasionallyVolunteers: "Occasionally volunteers to participate",
  oftenNoResponse: "Often does not respond when called upon",
  participatesWhenCalled: "Participates when called upon",
  inconsistent: "Participation is inconsistent",
  rarelyVolunteers: "Rarely volunteers but responds when called upon",
  respondsCorrectly: "Responds correctly to questions most of the time",
  veryActiveChat: "Very active — regularly participates through chat",
  veryActiveMic: "Very active — regularly participates using microphone",
} as const;

export const ALL_INDICATORS: string[] = Object.values(INDICATORS);

/** Indicators the assistant must never suggest: teacher judgement only. */
export const TEACHER_ONLY_INDICATORS: string[] = [
  INDICATORS.appearsAttentive,
  INDICATORS.appearsDistracted,
];

/** Indicators the assistant may never suggest on its own evidence:
 *  the teacher must confirm the underlying observation first. */
export const TEACHER_CONFIRMED_INDICATORS: string[] = [
  INDICATORS.oftenNoResponse,
];

import type { StudentSignals } from "./types.js";

/**
 * Signal -> indicator mapping, from spec v1 Section 2.
 * Correctness is evidence for the teacher, never an engagement indicator
 * by itself. Returns only assistant-allowed indicators.
 */
export function suggestIndicators(signals: StudentSignals, present: boolean): string[] {
  if (!present) return [];
  const out: string[] = [];
  const spoke = signals.speakingTurns > 0;
  const multiSegment = signals.speakingSegments.size > 1;

  if (signals.checkinsAnswered > 0 && signals.chatAnswers > 0) {
    out.push(INDICATORS.veryActiveChat, INDICATORS.attemptsUnsure);
  } else if (multiSegment && signals.chatPublic > 0) {
    out.push(INDICATORS.activeMicAndChat, INDICATORS.alwaysWilling);
  } else if (spoke || signals.checkinsAnswered > 0) {
    out.push(INDICATORS.participatesWhenCalled);
  }

  if (signals.chatQuestions > 0 || signals.privateQuestions > 0) {
    out.push(INDICATORS.asksQuestions);
  }

  const anySignal =
    spoke || signals.chatPublic > 0 || signals.checkinsAnswered > 0 || signals.privateQuestions > 0;
  if (anySignal && out.length === 0) {
    out.push(INDICATORS.occasionallyVolunteers);
  }
  if (!anySignal) {
    // Flagged for the teacher to confirm or override, never auto-final:
    // the Compiler attaches a data_gaps note when this is the only suggestion.
    out.push(INDICATORS.limited);
  }

  return [...new Set(out)].filter(
    (i) => !TEACHER_ONLY_INDICATORS.includes(i) && !TEACHER_CONFIRMED_INDICATORS.includes(i),
  );
}

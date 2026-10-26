// End-of-class compile, spec v1 Sections 1.8 and 3: per student, suggested
// indicators from the live platform set (indicators.ts), the evidence
// object, and data gaps stated plainly. The output is a DRAFT payload;
// the platform never treats it as an official record.

import { INDICATORS, suggestIndicators } from "../indicators.js";
import type {
  DraftEvidence,
  ParticipationDraftEntry,
  ParticipationDraftPayload,
  SessionContext,
} from "../types.js";
import type { RosterMatcher } from "./RosterMatcher.js";
import type { SignalTracker } from "./SignalTracker.js";

export interface CompileInput {
  ctx: SessionContext;
  tracker: SignalTracker;
  matcher: RosterMatcher;
  /** False when the bot never got into the call (e.g. not admitted from
   *  the waiting room). The draft must then say so, with no invented
   *  evidence, per spec Section 1.8. */
  assistantPresent: boolean;
  /** Roster studentIds confirmed present in the meeting. */
  presentStudentIds: Set<string>;
}

export function compileDraft(input: CompileInput): ParticipationDraftPayload {
  const { ctx, tracker, matcher, assistantPresent, presentStudentIds } = input;

  const entries: ParticipationDraftEntry[] = ctx.roster.map((student) => {
    const signals = tracker.get(student.studentId);
    const gaps: string[] = [];

    if (!assistantPresent) {
      return {
        student_id: student.studentId,
        indicators: [],
        evidence: emptyEvidence("unmatched"),
        data_gaps: ["Assistant not present this session, enter manually"],
      };
    }

    const match = matcher.all().find((m) => m.studentId === student.studentId);
    const confidence = match?.confidence ?? "unmatched";
    if (confidence !== "high") {
      gaps.push(`Attendance match confidence: ${confidence}; signals may be incomplete`);
    }
    if (!presentStudentIds.has(student.studentId)) {
      gaps.push("No join event recorded for this student in this session");
    }

    const indicators = suggestIndicators(signals, true);
    if (indicators.length === 1 && indicators[0] === INDICATORS.limited) {
      gaps.push("No observed signal all session; teacher to confirm or override");
    }

    const evidence: DraftEvidence = {
      speaking_turns: signals.speakingTurns,
      speaking_segments: [...signals.speakingSegments],
      chat_public: signals.chatPublic,
      chat_answers: signals.chatAnswers,
      chat_questions: signals.chatQuestions,
      checkins_sent: signals.checkinsSent,
      checkins_answered: signals.checkinsAnswered,
      private_questions: signals.privateQuestions,
      nudges_sent: signals.nudgesSent,
      match_confidence: confidence,
    };

    return { student_id: student.studentId, indicators, evidence, data_gaps: gaps };
  });

  return {
    session_id: ctx.sessionId,
    source: "assistant_teacher_v1",
    assistant_present: assistantPresent,
    entries,
  };
}

function emptyEvidence(confidence: DraftEvidence["match_confidence"]): DraftEvidence {
  return {
    speaking_turns: 0,
    speaking_segments: [],
    chat_public: 0,
    chat_answers: 0,
    chat_questions: 0,
    checkins_sent: 0,
    checkins_answered: 0,
    private_questions: 0,
    nudges_sent: 0,
    match_confidence: confidence,
  };
}

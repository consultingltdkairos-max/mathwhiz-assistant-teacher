// Shared types for the brain service. Mirrors the build-out spec v1
// (ai-assistant-teacher-build-spec-2026-10-23.md) and the platform payload
// contract in the drafted endpoint brief.

export interface RosterStudent {
  studentId: string; // platform students uuid
  displayNames: string[]; // expected Zoom display names for this student
}

export interface SessionContext {
  sessionId: string; // platform class_sessions uuid
  cohortId: string;
  meetingUrl: string; // Zoom join URL from class_sessions.zoom_join_url
  joinAt: string; // ISO8601, a few minutes before scheduled start
  teacherParticipantId: string | null; // Recall participant id of the host/teacher once seen
  /** Display names the class teacher may join under (Nov 5, 2026
   *  finding): the teacher is recognised by host status OR by matching
   *  one of these names, so a teacher on her own host account is
   *  recognised even when Zoom does not flag her as host in the event
   *  stream, or she joins under a slightly different display name. */
  teacherNames?: string[];
  /** How the assistant should refer to the teacher to students (for
   *  example "Miss Rose"). Defaults to the name she joined under. */
  teacherLabel?: string;
  roster: RosterStudent[];
}

export type MatchConfidence = "high" | "low" | "unmatched";

export interface ParticipantMatch {
  participantId: string; // Recall/Zoom participant id for this meeting
  participantName: string;
  studentId: string | null;
  confidence: MatchConfidence;
}

/** The four tracked signals, per spec Section 1.3: S, C, A, Q. */
export interface StudentSignals {
  speakingTurns: number;
  speakingSegments: Set<"early" | "middle" | "late">;
  chatPublic: number;
  chatAnswers: number; // public chat that answers a teacher question (heuristic, see SignalTracker)
  chatQuestions: number; // public chat asking a question (heuristic)
  checkinsSent: number;
  checkinsAnswered: number;
  checkinsCorrect: number; // first-try correct only
  checkinsCorrectWithHint: number; // correct on the single retry after a hint (hint mode)
  privateQuestions: number; // DMs to the assistant asking for help
  nudgesSent: number;
  lastSignalAt: number | null; // epoch ms of the most recent signal of any kind
}

/** Evidence object posted to the platform, per spec Section 3. */
export interface DraftEvidence {
  speaking_turns: number;
  speaking_segments: string[];
  chat_public: number;
  chat_answers: number;
  chat_questions: number;
  checkins_sent: number;
  checkins_answered: number;
  private_questions: number;
  nudges_sent: number;
  match_confidence: MatchConfidence;
}

export interface ParticipationDraftEntry {
  student_id: string;
  indicators: string[];
  evidence: DraftEvidence;
  data_gaps: string[];
}

export interface ParticipationDraftPayload {
  session_id: string;
  source: "assistant_teacher_v1";
  assistant_present: boolean;
  entries: ParticipationDraftEntry[];
}

export type CheckInMode = "confirm" | "hint";

/** Per-student check-in state. "hint_pending" is a working state (hint
 *  mode only): the first reply was wrong, the hint has been sent, and
 *  exactly one scored retry is still open. It settles to "incorrect" at
 *  close if the retry never comes. "correct_with_hint" is a final
 *  outcome, kept distinct from a first-try "correct". */
export type CheckInOutcome =
  | "no_response"
  | "hint_pending"
  | "correct"
  | "correct_with_hint"
  | "incorrect"
  /** The student said they do not know / are not sure (Nov 5, 2026
   *  finding). A final outcome, reported to the teacher separately from
   *  incorrect: they engaged, they were honest, they need the teacher. */
  | "unsure";

export interface CheckIn {
  id: string;
  /** Round label for multi-question boards: "Q1", "Q2", ... Empty
   *  string for a single unlabelled round (the original model). */
  label: string;
  /** The teacher's expected answer for this round. There is deliberately
   *  no question field: the question lives on the teacher's board and is
   *  never held or relayed by the bot (correction, 27 Oct 2026). */
  expectedAnswer: string;
  mode: CheckInMode;
  windowMs: number;
  openedAt: number;
  closedAt: number | null;
  /** studentId -> outcome/state */
  results: Map<string, CheckInOutcome>;
  /** studentId -> the wrong answer text they most recently sent, kept so
   *  the teacher's close-out report can show what each incorrect student
   *  actually sent (Kevoy ruling, Nov 5, 2026). */
  wrongAnswers: Map<string, string>;
}

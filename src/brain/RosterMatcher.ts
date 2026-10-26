// Roster matching: participant + session, never name alone (standing
// Mathwhiz lesson, reinforced by the Oct 2026 audit work). A Zoom display
// name that does not clearly equal a roster name for THIS session is a
// low-confidence flag for the teacher, never a forced guess.

import type { ParticipantMatch, RosterStudent } from "../types.js";

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class RosterMatcher {
  private matches = new Map<string, ParticipantMatch>();

  constructor(private roster: RosterStudent[]) {}

  /** Match a joining/renamed participant. The teacher is identified
   *  separately via isHost at join time, not through this matcher. */
  match(participantId: string, displayName: string): ParticipantMatch {
    const target = normalise(displayName);
    const exact = this.roster.filter((s) =>
      s.displayNames.some((n) => normalise(n) === target),
    );
    let result: ParticipantMatch;
    if (exact.length === 1) {
      result = { participantId, participantName: displayName, studentId: exact[0].studentId, confidence: "high" };
    } else if (exact.length > 1) {
      // Same display name on the roster twice (siblings/shared device):
      // flag, do not guess.
      result = { participantId, participantName: displayName, studentId: null, confidence: "low" };
    } else {
      // Partial overlap (first name only, initials, device names like
      // "iPhone") is not evidence enough to attach a record to a child.
      result = { participantId, participantName: displayName, studentId: null, confidence: "unmatched" };
    }
    this.matches.set(participantId, result);
    return result;
  }

  get(participantId: string): ParticipantMatch | undefined {
    return this.matches.get(participantId);
  }

  studentFor(participantId: string): string | null {
    return this.matches.get(participantId)?.studentId ?? null;
  }

  all(): ParticipantMatch[] {
    return [...this.matches.values()];
  }
}

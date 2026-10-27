// Teacher nudges, spec v1 Section 1.6. Private to the teacher only.
// Rule kept here: no signal of any kind 20 minutes into class.
// Cap: 1 nudge per student per class segment.
// Teacher controls: PAUSE / RESUME / STOP by DM.
// (Answer-round non-response is no longer nudged per student from here:
// since the 27 Oct 2026 correction, SessionManager reports it as ONE
// combined DM when the round closes.)

import type { SignalTracker } from "./SignalTracker.js";

export const NO_SIGNAL_AFTER_MS = 20 * 60 * 1000;

export class NudgeEngine {
  private paused = false;
  private stopped = false;
  /** studentId -> segments already nudged in */
  private nudgedInSegment = new Map<string, Set<string>>();

  constructor(private tracker: SignalTracker) {}

  handleTeacherCommand(text: string): boolean {
    const t = text.trim().toUpperCase();
    if (t === "PAUSE") { this.paused = true; return true; }
    if (t === "RESUME") { this.paused = false; return true; }
    if (t === "STOP") { this.stopped = true; return true; }
    return false;
  }

  get silenced(): boolean {
    return this.paused || this.stopped;
  }

  /** Silent-so-far nudges due at `now`. Caller DMs each to the teacher. */
  silenceNudges(
    students: { studentId: string; displayName: string; present: boolean }[],
    startedAt: number,
    now: number,
    segment: string,
  ): { studentId: string; text: string }[] {
    if (this.silenced || now - startedAt < NO_SIGNAL_AFTER_MS) return [];
    const out: { studentId: string; text: string }[] = [];
    for (const st of students) {
      if (!st.present) continue;
      const s = this.tracker.get(st.studentId);
      if (s.lastSignalAt !== null) continue;
      if (!this.claim(st.studentId, segment)) continue;
      this.tracker.nudgeSent(st.studentId);
      out.push({
        studentId: st.studentId,
        text: `Haven't heard from ${st.displayName} so far today. Worth picking on them next, gently.`,
      });
    }
    return out;
  }

  private claim(studentId: string, segment: string): boolean {
    const set = this.nudgedInSegment.get(studentId) ?? new Set<string>();
    if (set.has(segment)) return false;
    set.add(segment);
    this.nudgedInSegment.set(studentId, set);
    return true;
  }
}

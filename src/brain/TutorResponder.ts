// Student help replies, spec v1 Section 1.5.
// PILOT SCOPE (deterministic only, per the pilot plan): the pilot runs
// WITHOUT an LLM. Free student questions therefore get a safe templated
// reply: acknowledge, point back to the lesson, and let the student know
// the teacher can help. Open tutor-style worked help is a post-pilot
// decision (it needs an LLM credential and answer-quality controls before
// it is put in front of minors).
//
// Hard rules that hold in every version:
// - Never answer an open check-in question for the student.
// - Never complete graded assignment work; explain and hint only.
// - Off-topic or personal content is handled by Safeguarding, not here.

export const TUTOR_NOT_CONFIGURED_REPLY =
  "Good question. I can't work through that one with you just yet, but write it down and ask your teacher when they check in, or send it in the class chat so everyone can learn from it.";

export function replyToStudentQuestion(_text: string, checkInOpen: boolean): string {
  if (checkInOpen) {
    return "A check in is open right now, so I can't help with questions until it closes. Give the check in your best try first.";
  }
  return TUTOR_NOT_CONFIGURED_REPLY;
}

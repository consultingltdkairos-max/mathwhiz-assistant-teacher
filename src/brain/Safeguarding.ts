// Safeguarding, spec v1 Section 1.7. If a student DM contains a personal
// disclosure, distress, or anything outside schoolwork, the assistant
// replies kindly and briefly, does not counsel, and immediately flags the
// teacher privately. Every flag and its reason are logged for Kevoy/Mikiela
// review. This flow is rehearsed in the Stage 0 fake class with staff
// playing the student; it is never first exercised on a real student.
//
// Detection below is a conservative keyword screen, a floor not a ceiling:
// it exists so the pilot (deterministic-only, no LLM) still routes anything
// worrying to a human in the room. False positives are acceptable; a
// flagged message gets the kind reply and the teacher decides.

export interface SafeguardingHit {
  reason: string;
  studentReply: string;
  teacherFlag: string;
}

const PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "possible self-harm or distress language", re: /\b(hurt myself|kill myself|self.?harm|suicid|want to die|end it all)\b/i },
  { reason: "possible abuse or unsafe-at-home disclosure", re: /\b(abuse|hits me|beats me|touches me|unsafe at home|afraid to go home)\b/i },
  { reason: "possible bullying disclosure", re: /\b(bullying me|bullied|threaten(ed)? me|beating me up)\b/i },
  { reason: "personal distress disclosure", re: /\b(depressed|anxious all the time|crying every|can't cope|cannot cope|hopeless)\b/i },
];

export function screenStudentMessage(text: string): { reason: string } | null {
  for (const p of PATTERNS) {
    if (p.re.test(text)) return { reason: p.reason };
  }
  return null;
}

export function safeguardingResponses(displayName: string, reason: string): SafeguardingHit {
  return {
    reason,
    studentReply:
      "Thank you for telling me. I am only the class assistant, so I can't help with that properly, but your teacher can. Please speak with your teacher, or a trusted adult, today.",
    teacherFlag: `Please check in with ${displayName} after class. They sent me a message that may need your attention (${reason}). I have not replied beyond a brief kind message.`,
  };
}

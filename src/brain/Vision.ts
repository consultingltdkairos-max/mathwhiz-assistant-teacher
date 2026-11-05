// Screen-question vision (Nov 5, 2026, Kevoy's direction after the
// Stage 0 live test): the bot CAN see the shared screen, so when a round
// opens the brain reads the question(s) from a single frame and can then
// (a) cross-check the teacher's expected answer and warn the teacher
// privately if it disagrees, (b) give a REAL hint for a wrong answer,
// aimed at the likely wrong step, and (c) help a stuck student against
// the actual question.
//
// Nov 5, 2026 findings round (live tutor demo):
// - The screen may carry SEVERAL questions at once; the reader returns
//   each one with its label (Question 1, Question 2, ...) so rounds can
//   be matched to the question they belong to.
// - Handwritten algebra was misread: letters such as a and b came back
//   as numbers. The prompt now treats letters as variables by default
//   and refuses (legible=false) rather than guessing.
// - Help is scoped to the current class topic (the question on the
//   board). Requests for answers to homework, assignments or tests are
//   refused by the prompt as a second line behind the SessionManager's
//   deterministic gate.
//
// Guardrails, all hard:
// - Frames are processed in memory and discarded; nothing is stored.
// - A hint never reveals the final answer and is phrased as a check.
// - Help explains method; it never completes graded work, and the
//   SessionManager never calls help while a round is open.
// - EVERY failure (no key, timeout, unreadable screen, bad JSON) returns
//   an empty result and the caller falls back to the rule-based
//   behaviour. The class never breaks because vision did.

export interface ScreenQuestion {
  /** "Q1", "Q2", ... when the board labels its questions; "" when the
   *  screen carries a single unlabelled question. */
  label: string;
  questionText: string;
  /** The model's own worked answer to the question on screen, used ONLY
   *  for the teacher cross-check, never sent to students. */
  workedAnswer: string;
  legible: boolean;
}

export interface VisionProvider {
  /** Read every question on the shared screen. Empty array on any
   *  failure or when nothing legible is showing. */
  readScreen(pngBase64: string): Promise<ScreenQuestion[]>;
  makeHint(q: ScreenQuestion, expectedAnswer: string, studentAnswer: string): Promise<string | null>;
  helpWithQuestion(q: ScreenQuestion, studentText: string): Promise<string | null>;
}

type FetchImpl = typeof fetch;

const READ_PROMPT =
  "You are reading a single frame of a teacher's shared screen in a maths class. " +
  "The screen may show ONE maths question or SEVERAL (often labelled Question 1, Question 2, or Q1, Q2). " +
  "Questions may be typed or handwritten. In algebra, letters such as a, b, x and y are VARIABLES, never digits: " +
  "a handwritten 'a' is the letter a, not the number 9; 'b' is not 6 or 9; treat a character as a letter whenever the " +
  "question is algebra. If a character is truly unreadable, do not guess it. " +
  "Reply with ONLY a JSON object, no other text: " +
  '{"questions": [{"label": "Q1", "question": "<the question text exactly as shown>", "answer": "<the correct final answer, worked out by you>", "legible": true}]}. ' +
  "Use label Q1, Q2, ... in the order the questions appear when they are not labelled on screen; use an empty label " +
  "only when there is exactly one question and it carries no label. " +
  "If a question is cut off or unreadable, include it with legible set to false and empty question and answer. " +
  "If there is no maths question on screen at all, reply {\"questions\": []}.";

function hintPrompt(q: ScreenQuestion, expectedAnswer: string, studentAnswer: string): string {
  return (
    `A student is answering this maths question in class: "${q.questionText}". ` +
    `The correct final answer is ${expectedAnswer}. The student privately sent "${studentAnswer}", which is wrong. ` +
    "Write ONE short, warm hint (one sentence) that points at the step they most likely got wrong, phrased as a check " +
    "(for example, \"Check what happens to the +3 when it crosses the equals sign.\"). " +
    "Never state or imply the final answer. Never do the whole working for them. Reply with the hint sentence only."
  );
}

function helpPrompt(q: ScreenQuestion, studentText: string): string {
  return (
    `You are an assistant teacher in a maths class. The question on the board is: "${q.questionText}". ` +
    `A student privately asks: "${studentText}". ` +
    "Help them understand the method for THIS class question in 2 or 3 short, warm sentences. Explain the idea and the next step; " +
    "do not simply hand over a final answer, and do not do graded assignment work. " +
    "If the student is actually asking for help with homework, an assignment, a test, or anything that is not this class question, " +
    "reply with exactly: \"I can only help with the work we are doing in class right now. For that one, check with your teacher.\" " +
    "Reply with the help text only."
  );
}

export class AnthropicVisionProvider implements VisionProvider {
  private fetchImpl: FetchImpl;

  constructor(
    private apiKey: string,
    private model: string,
    fetchImpl?: FetchImpl,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call(content: unknown[], maxTokens: number): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9_000);
    try {
      const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const text = (data?.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => String(b.text ?? ""))
        .join("")
        .trim();
      return text || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async readScreen(pngBase64: string): Promise<ScreenQuestion[]> {
    const text = await this.call(
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
        { type: "text", text: READ_PROMPT },
      ],
      700,
    );
    if (!text) return [];
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) return [];
      const parsed = JSON.parse(text.slice(start, end + 1));
      const list: any[] = Array.isArray(parsed.questions) ? parsed.questions : [];
      return list.map((q: any, i: number) => ({
        label: String(q?.label ?? (list.length > 1 ? `Q${i + 1}` : "")).toUpperCase().replace(/^QUESTION\s*/, "Q"),
        questionText: String(q?.question ?? ""),
        workedAnswer: String(q?.answer ?? ""),
        legible: Boolean(q?.legible),
      }));
    } catch {
      return [];
    }
  }

  async makeHint(q: ScreenQuestion, expectedAnswer: string, studentAnswer: string): Promise<string | null> {
    const text = await this.call([{ type: "text", text: hintPrompt(q, expectedAnswer, studentAnswer) }], 120);
    if (!text) return null;
    // A hint that accidentally contains the expected answer is dropped.
    if (text.replace(/\s+/g, "").includes(expectedAnswer.replace(/\s+/g, "")) && expectedAnswer.trim().length > 1) {
      return null;
    }
    return text.split("\n")[0].trim() || null;
  }

  async helpWithQuestion(q: ScreenQuestion, studentText: string): Promise<string | null> {
    const text = await this.call([{ type: "text", text: helpPrompt(q, studentText) }], 300);
    return text;
  }
}

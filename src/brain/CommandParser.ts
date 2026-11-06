// Conversational teacher commands (Nov 6, 2026, Kevoy's question: "Do
// we have to use coded message or can we just use conversational
// language?"). The coded template stays the primary, instant, zero-risk
// route. When a teacher DM does NOT parse as the template, this parser
// lets her say it plainly instead, for example:
//   "For question 2 the answer is 36, give them five minutes with hints"
//   "Answer for this one is x = 7, just confirm, no second try"
//
// Safety shape: the parser only EXTRACTS; it never invents. The
// SessionManager reads the whole interpretation back to the teacher in
// the round-open confirmation (answer, label, window, mode), so a
// misread is visible before the round runs, and the screen cross-check
// still watches the answer after that. Any doubt, timeout or malformed
// output returns null and the teacher gets the template reminder, which
// is exactly today's behaviour.

import type { ParsedRoundCommand } from "./CheckInEngine.js";

export interface RoundCommandParser {
  parse(text: string): Promise<ParsedRoundCommand | null>;
}

type FetchImpl = typeof fetch;

const PARSE_PROMPT = (text: string) =>
  "A teacher is messaging her classroom assistant to open an answer round for the question on her board. " +
  "Extract the round setup from her message. Reply with ONLY a JSON object and nothing else: " +
  '{"expectedAnswer": "<the correct answer she states>", "mode": "hint" or "confirm", ' +
  '"windowSeconds": <number or null>, "label": "<Q1, Q2, ... or empty string>"}. ' +
  'mode is "hint" unless she clearly says no second try / confirm only. windowSeconds is null unless she states a time. ' +
  "If the message is NOT an instruction to open an answer round with a stated answer, reply with the single word NONE. " +
  `Teacher message: "${text}"`;

export class AnthropicCommandParser implements RoundCommandParser {
  private fetchImpl: FetchImpl;

  constructor(
    private apiKey: string,
    private model: string,
    fetchImpl?: FetchImpl,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async parse(text: string): Promise<ParsedRoundCommand | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
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
          max_tokens: 200,
          messages: [{ role: "user", content: [{ type: "text", text: PARSE_PROMPT(text) }] }],
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const out = (data?.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => String(b.text ?? ""))
        .join("")
        .trim();
      if (!out || out === "NONE") return null;
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start === -1 || end === -1) return null;
      const parsed = JSON.parse(out.slice(start, end + 1));
      const expectedAnswer = String(parsed?.expectedAnswer ?? "").trim();
      // An extracted answer must be short and single-line; anything else
      // is treated as a misread and rejected.
      if (!expectedAnswer || expectedAnswer.length > 40 || /[\n|]/.test(expectedAnswer)) return null;
      const mode = parsed?.mode === "confirm" ? "confirm" : "hint";
      const secs = Number(parsed?.windowSeconds);
      const windowMs =
        Number.isFinite(secs) && secs >= 15 && secs <= 3600 ? Math.round(secs * 1000) : 3 * 60 * 1000;
      const rawLabel = String(parsed?.label ?? "").trim();
      const labelM = rawLabel.match(/^(?:q|question)\s*([0-9]+)$/i);
      return { expectedAnswer, mode, windowMs, label: labelM ? `Q${labelM[1]}` : "" };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

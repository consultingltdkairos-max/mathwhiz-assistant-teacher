// LOCAL STUB of the platform's POST /api/assistant/participation, for the
// demo only. It stands in for the real route (built by the Lovable brief
// Oct 26, verified in the database, but deliberately NOT published yet),
// and enforces the brief's contract so the brain's payload is validated
// exactly the way the real endpoint is specified to validate it:
//
//  - assistant-secret header required (401 without it; demo secret only)
//  - required top-level fields: session_id, source, assistant_present,
//    entries (1..500)
//  - every indicator must be one of the platform's exact 15 stored
//    strings (indicators.ts; two contain an em dash) -> entry skipped
//    with reason "unknown indicator" otherwise
//  - any score / feedback / comment field on an entry -> the entry is
//    rejected and reported, never silently ignored (brief Section 2)
//  - assistant_present=false with non-empty indicators -> 400, matching
//    the database CHECK on participation_drafts
//  - upsert semantics on (session_id, student_id): first post creates,
//    a repeat post updates
//
// It stores nothing beyond the demo process and holds no real data.

import { createServer, type Server } from "node:http";
import { ALL_INDICATORS } from "../indicators.js";
import type { ParticipationDraftPayload } from "../types.js";

const FORBIDDEN_ENTRY_FIELDS = [
  "participation_score",
  "score",
  "feedback",
  "ai_feedback",
  "comment",
  "comments",
  "notes",
  "teacher_comment",
];

const EVIDENCE_NUMBERS = [
  "speaking_turns",
  "chat_public",
  "chat_answers",
  "chat_questions",
  "checkins_sent",
  "checkins_answered",
  "private_questions",
  "nudges_sent",
] as const;

export interface StubResult {
  status: number;
  body: {
    ok?: boolean;
    created?: number;
    updated?: number;
    skipped?: { student_id: string; reason: string }[];
    error?: string;
  };
}

export class StubPlatform {
  private server: Server | null = null;
  /** (session_id|student_id) pairs already "created", for upsert counts. */
  private seen = new Set<string>();
  /** Every payload the stub accepted at request level, for inspection. */
  readonly received: ParticipationDraftPayload[] = [];

  constructor(
    private secret: string,
    private trace: (line: string) => void,
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const send = (status: number, body: StubResult["body"]) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/api/assistant/participation") {
      return send(404, { error: "not found" });
    }
    if (req.headers["x-mathwhiz-assistant-secret"] !== this.secret) {
      this.trace("[stub] 401: missing/invalid assistant secret");
      return send(401, { error: "unauthorised" });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk as Buffer;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: "malformed JSON" });
    }
    const result = this.validate(body);
    if (result.status === 200) this.received.push(body as ParticipationDraftPayload);
    this.trace(
      `[stub] POST /api/assistant/participation -> ${result.status} ${JSON.stringify(result.body)}`,
    );
    return send(result.status, result.body);
  }

  validate(body: unknown): StubResult {
    const fail = (error: string): StubResult => ({ status: 400, body: { error } });
    if (typeof body !== "object" || body === null) return fail("body must be an object");
    const b = body as Record<string, unknown>;
    if (typeof b.session_id !== "string" || b.session_id.length === 0)
      return fail("session_id is required");
    if (b.source !== "assistant_teacher_v1") return fail("source must be assistant_teacher_v1");
    if (typeof b.assistant_present !== "boolean") return fail("assistant_present must be boolean");
    if (!Array.isArray(b.entries) || b.entries.length < 1 || b.entries.length > 500)
      return fail("entries must be an array of 1..500");
    if (
      b.assistant_present === false &&
      b.entries.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          Array.isArray((e as Record<string, unknown>).indicators) &&
          ((e as Record<string, unknown>).indicators as unknown[]).length > 0,
      )
    ) {
      return fail("assistant_present=false requires empty indicators on every entry");
    }

    let created = 0;
    let updated = 0;
    const skipped: { student_id: string; reason: string }[] = [];

    for (const rawEntry of b.entries) {
      if (typeof rawEntry !== "object" || rawEntry === null) {
        skipped.push({ student_id: "(unknown)", reason: "malformed entry" });
        continue;
      }
      const e = rawEntry as Record<string, unknown>;
      const studentId = typeof e.student_id === "string" ? e.student_id : "(unknown)";

      const forbidden = FORBIDDEN_ENTRY_FIELDS.filter((f) => f in e);
      if (forbidden.length > 0) {
        skipped.push({
          student_id: studentId,
          reason: `forbidden field(s): ${forbidden.join(", ")} (endpoint rejects score/comment fields)`,
        });
        continue;
      }
      if (typeof e.student_id !== "string" || e.student_id.length === 0) {
        skipped.push({ student_id: studentId, reason: "student_id is required" });
        continue;
      }
      if (!Array.isArray(e.indicators) || e.indicators.some((i) => typeof i !== "string")) {
        skipped.push({ student_id: studentId, reason: "indicators must be an array of strings" });
        continue;
      }
      const unknown = (e.indicators as string[]).filter((i) => !ALL_INDICATORS.includes(i));
      if (unknown.length > 0) {
        skipped.push({
          student_id: studentId,
          reason: `unknown indicator: ${unknown.join(" | ")}`,
        });
        continue;
      }
      const ev = e.evidence as Record<string, unknown> | undefined;
      if (typeof ev !== "object" || ev === null) {
        skipped.push({ student_id: studentId, reason: "evidence object is required" });
        continue;
      }
      const badNumbers = EVIDENCE_NUMBERS.filter((k) => typeof ev[k] !== "number");
      if (badNumbers.length > 0) {
        skipped.push({
          student_id: studentId,
          reason: `evidence missing numeric field(s): ${badNumbers.join(", ")}`,
        });
        continue;
      }
      if (
        !Array.isArray(ev.speaking_segments) ||
        ev.speaking_segments.some((s) => !["early", "middle", "late"].includes(s as string))
      ) {
        skipped.push({ student_id: studentId, reason: "evidence.speaking_segments invalid" });
        continue;
      }
      if (!["high", "low", "unmatched"].includes(ev.match_confidence as string)) {
        skipped.push({ student_id: studentId, reason: "evidence.match_confidence invalid" });
        continue;
      }
      if (!Array.isArray(e.data_gaps) || e.data_gaps.some((g) => typeof g !== "string")) {
        skipped.push({ student_id: studentId, reason: "data_gaps must be an array of strings" });
        continue;
      }
      const key = `${b.session_id}|${e.student_id}`;
      if (this.seen.has(key)) updated += 1;
      else {
        this.seen.add(key);
        created += 1;
      }
    }
    return { status: 200, body: { ok: true, created, updated, skipped } };
  }
}

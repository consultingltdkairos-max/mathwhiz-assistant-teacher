// Client for the Mathwhiz platform assistant API. Only one call exists for
// this service: POST /api/assistant/participation, which files DRAFTS.
// Contract: build-out spec v1 Section 3 and the drafted Lovable brief
// (hidden_files/builder-brief-assistant-participation-endpoint-2026-10-26-DRAFT.md).
// The endpoint does not exist until that brief is built; this client is
// written to the contract, not to a live route.

import type { ServiceConfig } from "../config.js";
import type { ParticipationDraftPayload } from "../types.js";

export interface ParticipationPostResult {
  created: number;
  updated: number;
  skipped: { student_id: string; reason: string }[];
}

export class PlatformClient {
  constructor(private cfg: ServiceConfig) {}

  async postParticipationDraft(payload: ParticipationDraftPayload): Promise<ParticipationPostResult> {
    const res = await fetch(`${this.cfg.platform.baseUrl}/api/assistant/participation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mathwhiz-assistant-secret": this.cfg.platform.assistantSecret,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`POST /api/assistant/participation -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ParticipationPostResult;
  }
}

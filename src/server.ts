// HTTP surface of the brain service.
//   POST /recall/webhook       Recall realtime + bot status webhooks (signed)
//   POST /admin/start-session  dispatch the bot for a platform session
//   POST /admin/end-session    finalise a session now (compile + post draft)
// Admin routes are for Ben/the scheduler only; protect them at the host
// layer (private network or a shared admin token, TODO before any deploy).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServiceConfig } from "./config.js";
import { RecallBotProvider } from "./bot/RecallBotProvider.js";
import { PlatformClient } from "./platform/PlatformClient.js";
import { SessionManager } from "./brain/SessionManager.js";
import type { SessionContext } from "./types.js";

export function startServer(cfg: ServiceConfig): void {
  const bot = new RecallBotProvider(cfg);
  const platform = new PlatformClient(cfg);
  const sessions = new Map<string, SessionManager>(); // botId -> manager
  const bySession = new Map<string, SessionManager>(); // sessionId -> manager

  bot.onEvent(async (botId, event) => {
    const mgr = sessions.get(botId);
    if (mgr) await mgr.handleEvent(botId, event);
  });

  // One tick loop for all live sessions (check-in windows, nudges).
  setInterval(() => {
    for (const mgr of bySession.values()) void mgr.tick();
  }, 15_000);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const raw = await readBody(req);
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/recall/webhook") {
        const headers = stringHeaders(req);
        if (!bot.verifyWebhook(raw, headers)) {
          return json(res, 401, { error: "webhook verification failed" });
        }
        const events = bot.translateWebhook(raw, headers);
        if (events === null) return json(res, 400, { error: "invalid payload" });
        // The bot id rides in the webhook payload; translateWebhook keeps
        // events provider-shaped, so resolve the manager via payload bot id.
        const botId = extractBotId(raw);
        if (botId) await bot.dispatch(botId, events);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/admin/start-session") {
        const ctx = JSON.parse(raw) as SessionContext;
        const mgr = new SessionManager(ctx, bot, platform);
        bySession.set(ctx.sessionId, mgr);
        await mgr.start();
        // Register the botId -> manager mapping so this bot's webhook
        // events actually reach the manager (the onEvent handler above
        // looks managers up by bot id). Without this, events verify and
        // are then silently dropped; that is the bug Stage 0 test 2
        // caught on Oct 28, 2026.
        const newBotId = mgr.currentBotId;
        if (newBotId) sessions.set(newBotId, mgr);
        return json(res, 200, { ok: true, session_id: ctx.sessionId });
      }

      if (req.method === "POST" && url.pathname === "/admin/end-session") {
        const { session_id } = JSON.parse(raw) as { session_id: string };
        const mgr = bySession.get(session_id);
        if (!mgr) return json(res, 404, { error: "unknown session" });
        await mgr.endNow();
        bySession.delete(session_id);
        const endedBotId = mgr.currentBotId;
        if (endedBotId) sessions.delete(endedBotId);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      return json(res, 500, { error: "internal error" });
    }
  });

  server.listen(cfg.port, () => {
    console.log(`zoom-assistant-service listening on :${cfg.port}`);
  });
}

function extractBotId(raw: string): string | null {
  try {
    const p = JSON.parse(raw);
    return p?.data?.bot?.id ?? p?.bot?.id ?? p?.data?.bot_id ?? null;
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function stringHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

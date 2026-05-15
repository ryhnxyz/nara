import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as httpLogger } from "hono/logger";
import { initDb, openDb } from "@nara-bot/db";
import { env } from "./lib/env";
import { log } from "./lib/logger";
import { requireOwner } from "./lib/owner";
import { agentsRoute } from "./routes/agents";
import { logsRoute } from "./routes/logs";
import { dragonballRoute } from "./routes/dragonball";
import { aiRoute } from "./routes/ai";
import { skillsRoute } from "./routes/skills";
import { distributeRoute } from "./routes/distribute";
import { masterWalletRoute } from "./routes/master-wallet";
import { automationRoute } from "./routes/automation";
import { startDistributeWorker } from "./workers/distribute";
import { initHuntWorker } from "./workers/hunt";

const app = new Hono();
app.use("*", cors());
app.use("*", httpLogger());

app.get("/", (c) =>
  c.json({
    service: "nara-bot-daemon",
    ok: true,
    aiConfigured: !!env.aiApiKey,
    naracli: { useGlobal: env.useGlobalNaracli },
    agentxCli: { useGlobal: env.useGlobalAgentxCli },
  })
);
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

app.use("/api/*", requireOwner);

app.route("/api/agents", agentsRoute);
app.route("/api/logs", logsRoute);
app.route("/api/dragonball", dragonballRoute);
app.route("/api/ai", aiRoute);
app.route("/api/skills", skillsRoute);
app.route("/api/distribute", distributeRoute);
app.route("/api/master-wallet", masterWalletRoute);
app.route("/api/automation", automationRoute);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  log({ level: "error", scope: "http", message: err.message, meta: { stack: err.stack } });
  return c.json({ error: err.message }, 500);
});

initDb(openDb());
startDistributeWorker();
initHuntWorker();

const daemonHost = process.env.DAEMON_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port: env.port, hostname: daemonHost }, (info) => {
  log({ level: "success", scope: "daemon", message: `Nara bot daemon listening on ${daemonHost}:${info.port}` });
  log({
    level: "info",
    scope: "daemon",
    message: `AI: ${env.aiApiKey ? "configured" : "NOT configured"} @ ${env.aiBaseUrl} model=${env.aiModel}`,
  });
  log({
    level: "info",
    scope: "daemon",
    message: `CLI mode: naracli=${env.useGlobalNaracli ? "global" : "npx"} agentx-cli=${env.useGlobalAgentxCli ? "global" : "npx"}`,
  });
});

export type AppType = typeof app;

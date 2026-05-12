import { LogViewer } from "@/components/log-viewer";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  return (
    <div>
      <header className="page-header">
        <div>
          <div className="kicker">Telemetry</div>
          <h1>Live Logs</h1>
          <div className="page-subtitle">All events from the bot daemon. SSE streamed.</div>
        </div>
      </header>
      <LogViewer height={640} />
    </div>
  );
}

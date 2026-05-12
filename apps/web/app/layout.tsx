import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Nara Bot Dashboard",
  description: "Agent automation & Dragon Ball hunt control center for Nara Chain",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/dragonball", label: "Dragon Ball" },
  { href: "/chat", label: "AI Agent" },
  { href: "/skills", label: "Skills" },
  { href: "/settings", label: "Settings" },
  { href: "/logs", label: "Live Logs" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark">◆</span>
              <span className="brand-name">NARA / BOT</span>
            </div>
            <nav>
              {NAV.map((item) => (
                <a key={item.href} href={item.href} className="nav-link">{item.label}</a>
              ))}
            </nav>
            <footer className="sidebar-footer">
              <span className="muted">daemon</span>
              <span className="chip chip-live">●  LIVE</span>
            </footer>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

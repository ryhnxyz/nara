import type { ReactNode } from "react";
import "./globals.css";
import UserBadge from "../components/user-badge";
import "./globals.css";

export const metadata = {
  title: "Nara Bot Dashboard",
  description: "Agent automation & Dragon Ball hunt control center for Nara Chain",
};

const PRIMARY_NAV = [
  { href: "/", label: "Overview", num: null },
  { href: "/agents", label: "Agents", num: "1" },
  { href: "/chat", label: "AI Agent", num: "2" },
  { href: "/automation", label: "Automation", num: "3" },
  { href: "/settings", label: "Settings", num: "4" },
];
const SECONDARY_NAV = [
  { href: "/dragonball", label: "Dragon Ball" },
  { href: "/skills", label: "Skills" },
  { href: "/logs", label: "Live Logs" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <input type="checkbox" id="nav-toggle" className="nav-toggle" />
        <div className="shell">
          <label htmlFor="nav-toggle" className="nav-toggle-btn" aria-label="Toggle menu">
            <span></span>
            <span></span>
            <span></span>
          </label>
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark">◆</span>
              <span className="brand-name">NARA / BOT</span>
              <label htmlFor="nav-toggle" className="nav-close" aria-label="Close menu">×</label>
            </div>
            <nav>
              {PRIMARY_NAV.map((item) => (
                <a key={item.href} href={item.href} className="nav-link">
                  {item.num && <span className="nav-num">{item.num}.</span>}
                  <span>{item.label}</span>
                </a>
              ))}
              <div className="nav-divider">MORE</div>
              {SECONDARY_NAV.map((item) => (
                <a key={item.href} href={item.href} className="nav-link nav-link-sm">{item.label}</a>
              ))}
            </nav>
            <UserBadge />
            <footer className="sidebar-footer">
              <span className="muted">daemon</span>
              <span className="chip chip-live">●  LIVE</span>
            </footer>
          </aside>
          <label htmlFor="nav-toggle" className="nav-overlay" aria-label="Close menu"></label>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

"use client";

import { useEffect, useState } from "react";

interface Me {
  authenticated: boolean;
  email?: string;
  appName?: string;
}

export default function UserBadge() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { authenticated: false }))
      .then((data: Me) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!me?.authenticated) return null;

  const initial = (me.email ?? "?")[0]?.toUpperCase() ?? "?";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderTop: "1px solid var(--border)",
        fontSize: 11,
        marginTop: "auto",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: "var(--accent-soft)",
          color: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
          title={me.email}
        >
          {me.email}
        </div>
        <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.12em" }}>SIGNED IN</div>
      </div>
      <a
        href="/api/auth/logout"
        title="Sign out"
        style={{
          fontSize: 16,
          color: "var(--text-dim)",
          textDecoration: "none",
          padding: "4px 6px",
          borderRadius: 4,
        }}
      >
        ↪
      </a>
    </div>
  );
}

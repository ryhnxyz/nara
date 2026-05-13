"use client";

import { use, useState } from "react";

const ERROR_LABELS: Record<string, string> = {
  missing_token: "Portal didn't return a token. Try logging in again.",
  state_mismatch: "CSRF state mismatch. Please try again.",
  not_whitelisted: "Your account isn't whitelisted yet. Contact admin or purchase access.",
  no_email: "Portal returned a token without an email.",
  revoked: "Your access was revoked. Contact admin.",
  token_expired: "Login expired. Please sign in again.",
  invalid_token: "Invalid token from portal.",
  session_revoked: "Your session was revoked from another device.",
  init_failed: "Could not start sign-in flow.",
};

export default function LoginClient({
  searchParamsPromise,
}: {
  searchParamsPromise: Promise<{ error?: string; next?: string }>;
}) {
  const sp = use(searchParamsPromise);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const urlError = sp?.error ? (ERROR_LABELS[sp.error] ?? sp.error) : null;
  const displayErr = err ?? urlError;

  async function signIn() {
    setErr(null);
    setLoading(true);
    try {
      const r = await fetch("/api/portal/init-sso", { method: "POST" });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { gateway_url?: string };
      if (!data.gateway_url) throw new Error("No gateway_url returned");
      window.location.href = data.gateway_url;
    } catch (e) {
      setErr((e as Error).message);
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 32,
          background: "var(--panel)",
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: "0.28em", color: "var(--accent)", marginBottom: 8 }}>
          NARA BOT DASHBOARD
        </div>
        <h1 style={{ fontSize: 24, margin: "0 0 8px", fontWeight: 600 }}>Sign in</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "0 0 24px", lineHeight: 1.6 }}>
          Dashboard ini dilindungi Mystr Portal. Sign in pakai akun portal untuk akses agents, automation, dan AI chat.
          Tiap user punya data + wallet sendiri.
        </p>

        <button
          type="button"
          className="btn btn-primary"
          onClick={signIn}
          disabled={loading}
          style={{ width: "100%", padding: "12px 16px", fontSize: 14, fontWeight: 600 }}
        >
          {loading ? "Redirecting to portal…" : "Sign in with Mystr Portal →"}
        </button>

        {displayErr && (
          <div
            style={{
              marginTop: 16,
              padding: "10px 12px",
              border: "1px solid var(--danger)",
              borderRadius: 8,
              color: "var(--danger)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {displayErr}
          </div>
        )}

        <div style={{ marginTop: 28, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          Belum punya akses? Login akan menampilkan opsi <strong>Buy Access</strong> jika diaktifkan, atau minta admin whitelist email-mu.
        </div>
      </div>
    </div>
  );
}

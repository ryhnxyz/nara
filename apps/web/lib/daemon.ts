const DAEMON_URL = process.env.NARA_DAEMON_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Daemon ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const daemon = {
  url: DAEMON_URL,
  listAgents: () => request<{ agents: any[] }>("/api/agents"),
  getAgent: (id: string) => request<any>(`/api/agents/${id}`),
  createAgent: (input: { agentId: string; displayName?: string; referral?: string }) =>
    request<{ agent: any }>("/api/agents", { method: "POST", body: JSON.stringify(input) }),
  patchAgent: (id: string, patch: any) =>
    request<any>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAgent: (id: string) => request<any>(`/api/agents/${id}`, { method: "DELETE" }),
  exportAgentWallet: (id: string) =>
    request<{ agentId: string; publicKey: string; privateKey: string; keypairJson: number[]; warning: string }>(
      `/api/agents/${id}/export`
    ),
  runFlow: (id: string, opts?: any) =>
    request<any>(`/api/agents/${id}/run`, { method: "POST", body: JSON.stringify(opts ?? {}) }),
  cancelFlow: (id: string) =>
    request<any>(`/api/agents/${id}/cancel`, { method: "POST" }),
  recentLogs: (limit = 200, agentId?: string) =>
    request<{ logs: any[] }>(`/api/logs?limit=${limit}${agentId ? `&agentId=${agentId}` : ""}`),

  dragonBallClaims: (agentId?: string) =>
    request<{ claims: any[] }>(`/api/dragonball/claims${agentId ? `?agentId=${agentId}` : ""}`),
  manualClaim: (input: { agentDbId: string; code: string; tweetUrl?: string; walletPath?: string }) =>
    request<any>("/api/dragonball/manual-claim", { method: "POST", body: JSON.stringify(input) }),

  aiModels: () => request<any>("/api/ai/models"),
  aiTweet: (input: any) => request<any>("/api/ai/tweet", { method: "POST", body: JSON.stringify(input) }),
  aiChat: (input: any) => request<any>("/api/ai/chat", { method: "POST", body: JSON.stringify(input) }),
  aiThreads: () => request<any>("/api/ai/threads"),
  aiThread: (id: string) => request<any>(`/api/ai/threads/${id}`),

  skillsCatalog: () => request<any>("/api/skills/catalog"),
  skillsInstalled: () => request<any>("/api/skills/installed"),
  skillsInstall: (name: string) => request<any>("/api/skills/install", { method: "POST", body: JSON.stringify({ name }) }),
  skillsRemove: (name: string) => request<any>("/api/skills/remove", { method: "POST", body: JSON.stringify({ name }) }),
};

export { DAEMON_URL };

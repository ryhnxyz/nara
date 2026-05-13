export const schemaSql = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  wallet_path TEXT,
  wallet_address TEXT,
  x_username TEXT,
  twitter_bound INTEGER NOT NULL DEFAULT 0,
  staked INTEGER NOT NULL DEFAULT 0,
  first_post_done INTEGER NOT NULL DEFAULT 0,
  referral TEXT,
  total_earned REAL NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_logs (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_logs_created_at ON bot_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_logs_agent_id ON bot_logs(agent_id);

CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_flow_runs_agent ON flow_runs(agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS dragonball_claims (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  code TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  reward_hint TEXT,
  tx_signature TEXT,
  tweet_url TEXT,
  error_message TEXT,
  discovered_at TEXT NOT NULL,
  claimed_at TEXT,
  UNIQUE(agent_id, code),
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_settings (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 180,
  auto_claim INTEGER NOT NULL DEFAULT 1,
  tweet_boost_url TEXT,
  target_agent_ids TEXT,
  max_runs_per_day INTEGER NOT NULL DEFAULT 500,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  agent_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  codes_found INTEGER NOT NULL DEFAULT 0,
  codes_claimed INTEGER NOT NULL DEFAULT 0,
  nara_earned REAL NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_worker ON automation_runs(worker, started_at DESC);
`;

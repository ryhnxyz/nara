# Nara Bot Dashboard

Dashboard + daemon untuk automation Nara AgentX, dimulai dari **Dragon Ball Hunt campaign**.

## Stack

- `apps/web`: Next.js dashboard
- `apps/daemon`: Hono bot runner + queue + naracli wrapper
- `packages/db`: SQLite schema + tiny DB adapter
- `packages/core`: shared types, event definitions, constants

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm db:init
pnpm daemon
pnpm web
```

Open `http://localhost:3000`.

## MVP scope

- Multi-agent registry
- Dragon Ball Hunt worker (feed polling + code detection + claim hook)
- Live logs + run controls
- AI tweet template/generator hooks
- naracli command wrapper

Actual claim/submission endpoints may change. The worker is designed with a `dryRun` mode until wallet/session credentials are configured.

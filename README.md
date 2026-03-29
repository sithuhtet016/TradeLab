# TradeLab (Vite + React)

## Supabase client

### Install

```bash
npm install
```

This installs `@supabase/supabase-js` and the rest of the Vite + React toolchain.

### Environment

Variables use the `VITE_` prefix so Vite exposes them to the client.

- Copy `.env.example` to `.env` and fill in values, or use the existing `.env` locally.
- `.env` is gitignored; do not commit API keys.

### Run

```bash
npm run dev
```

This starts both frontend (Vite) and backend (Express API).

Run frontend and backend together:

```bash
npm run dev:full
```

Run frontend only:

```bash
npm run dev:web
```

Run backend only:

```bash
npm run dev:api
```

If the editor still shows TypeScript errors after changes to `tsconfig.json`, use **Command Palette → “TypeScript: Restart TS Server”**. The repo uses a single `tsconfig.json` — delete any stray empty `tsconfig.app.json` files (invalid JSON breaks the TS server).

### Optional: Supabase Agent Skills

```bash
npx skills add supabase/agent-skills
```

### Files

| File                    | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `.env`                  | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` |
| `src/utils/supabase.ts` | Shared `supabase` client                                     |
| `src/App.tsx`           | Example: load `todos` from Supabase                          |

Create a `todos` table in Supabase (with `id` and `name`) or change the query in `App.tsx`.

For the trading app schema and atomic trade RPC functions, run:

- `server/sql/supabase_setup.sql`

See `PROJECT_SPEC.md` for product requirements.

## Deploy on Render (One-Click Blueprint)

This repo now deploys as a single Render web service (`tradelab`) that:

- builds the Vite frontend during deploy,
- serves the API from Express,
- serves the built frontend from the same domain.

### 1) Create services

- In Render, create a new Blueprint deploy from this repo.
- Render reads `render.yaml` and creates both services.

### 2) Set required env vars (`tradelab`)

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Already defined in `render.yaml` defaults:

- `NODE_ENV=production`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=120`
- `ALLOW_UNVERIFIED_RPC_READY=false`

### 3) Run SQL setup once

Apply:

- `server/sql/supabase_setup.sql`

in your Supabase SQL editor before first live trading requests.

### 4) Verify after deploy

- API health: `https://<your-service>.onrender.com/api/health`
- API readiness: `https://<your-service>.onrender.com/api/readiness`
- Open `https://<your-service>.onrender.com` and test:
  - sign up / sign in
  - market price loads
  - buy/sell executes
  - trade history updates

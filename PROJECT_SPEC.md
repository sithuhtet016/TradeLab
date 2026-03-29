# TradeLab — Detailed Project Specification

**Version:** 1.1  
**Status:** Approved (resolved decisions in §16)  
**Derived from:** MVP outline (single service, learning-first, simplicity over realism)

---

## 1. Purpose & scope

### 1.1 Product summary

**TradeLab** is a browser-based **demo trading** application. Users sign up, receive **virtual USD**, and practice **market buy/sell** of **BTC** against that balance using **live (polled) prices** proxied from Binance. The focus is **learning and simple execution**, not brokerage-grade realism.

### 1.2 In scope (MVP)

| Area | Detail |
|------|--------|
| Asset | **BTC/USDT** only (user-facing: BTC balance + USD balance) |
| Orders | **Market** buy and sell only |
| Money | Virtual **USD wallet** + **BTC holdings**; no deposits/withdrawals |
| Prices | Backend **polls** external API, **caches** result; frontend polls backend |
| Accounts | Email + password; **JWT** sessions |
| UI | Auth, dashboard (price + chart widget + trade + portfolio), trade history |

### 1.3 Explicitly out of scope (v1)

- Multiple trading pairs or assets  
- Limit, stop, OCO, or conditional orders  
- Leverage, margin, futures, shorts  
- Real money, KYC, bank/card integration  
- Social, copy trading, leaderboards  
- Native mobile apps (responsive web is enough if time permits)  
- Custom candlestick/engine chart rendering (use **embedded widget** only)  
- Order book, partial fills, queued orders, slippage models  

### 1.4 Success criteria (MVP “done”)

1. User can **register** and **log in** securely.  
2. New user gets a **$10,000** virtual USD balance (and **0 BTC**) persisted server-side.  
3. **BTC/USDT price** updates in the UI on a **~2–3s** cadence via the backend.  
4. User can **market buy** and **market sell**; balances and holdings update **correctly** and **atomically**.  
5. **Portfolio** shows USD, BTC, total value in USD, and **unrealized P&L** vs initial $10k.  
6. **Trades** are stored and listed **chronologically** with required fields.  
7. No negative USD or BTC balances; invalid inputs are rejected with clear errors.

---

## 2. Personas & primary flows

### 2.1 Personas

- **New learner:** Wants to try buy/sell without risking money.  
- **Returning user:** Wants to see portfolio and continue trading.

### 2.2 Flows

**Registration**

1. Submit email + password.  
2. Server creates `user`, `wallet` (USD = 10,000), `holding` (BTC = 0).  
3. Issue JWT immediately (**auto-login**); return `token` + `user` in the response (same shape as login).  
4. Client stores token and redirects to dashboard.

**Login**

1. Submit email + password.  
2. Verify hash; issue JWT.  
3. Load dashboard: portfolio, latest cached price, open trade history.

**Trade (buy)**

1. User may place a buy **either** by **BTC quantity** or by **USD amount to spend** (UI shows **both** inputs; editing one updates the other using the latest displayed price). The API accepts **exactly one** mode per request: `quantity` (BTC) **or** `quote_usd` (USD spend), not both (see §7.4).  
2. Server loads **latest valid price** from cache (or one fresh fetch if stale — policy in §7).  
3. If `quote_usd`: derive `quantity = quote_usd / price`, round **BTC** to 8 decimals, then `cost = round(quantity × price)` to **2** USD decimals (§5.2). If `quantity` given: `cost = round(quantity × price)` to 2 USD decimals. Reject if `cost > balance_usd`.  
4. In a **single DB transaction:** deduct USD, add BTC, insert `trade` row.  
5. Return updated portfolio snapshot or deltas.

**Trade (sell)**

1. User enters **BTC quantity**.  
2. Server validates `btc_quantity >= qty`.  
3. Load price; compute `proceeds = qty × price`.  
4. In one transaction: reduce BTC, add USD, insert trade.

**View history**

1. Authenticated `GET` returns trades for user, newest first or oldest first (consistent; **default: newest first**).

---

## 3. Architecture

### 3.1 Logical architecture

```
Browser (Vite + React SPA)
        │  HTTPS, JSON, JWT (Authorization: Bearer)
        ▼
Single Node.js + Express API
        │  SQL
        ▼
PostgreSQL
        │
        ▼
Binance public REST (server-side only)
```

**Rule:** The **frontend must not** call Binance (or other price providers) directly — avoids CORS/key leakage and centralizes rate limiting/caching.

### 3.2 Deployment assumptions (configurable)

- API and DB URLs via **environment variables**.  
- **HTTPS** in production (TLS termination at reverse proxy or platform).  
- One **long-lived JWT secret** in env (rotations out of MVP unless required).

### 3.3 Monolith boundary

One deployable **API service**; no separate microservices for MVP.

---

## 4. Data model

### 4.1 Entities

**users**

| Column | Type | Constraints |
|--------|------|----------------|
| id | UUID or BIGSERIAL | PK |
| email | VARCHAR | UNIQUE, NOT NULL, indexed |
| password_hash | VARCHAR | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |

**wallets** (one row per user for MVP)

| Column | Type | Constraints |
|--------|------|----------------|
| id | PK | |
| user_id | FK → users.id | UNIQUE, NOT NULL |
| balance_usd | NUMERIC(20, 2) | NOT NULL, **>= 0**, default 10000.00 for new users; **2 decimal places** only (see §4.2) |

**holdings**

| Column | Type | Constraints |
|--------|------|----------------|
| id | PK | |
| user_id | FK → users.id | UNIQUE for (user_id, asset) if multi-asset later; MVP: one row per user with asset = 'BTC' |
| asset | VARCHAR | NOT NULL, check in app or DB: `'BTC'` |
| quantity | NUMERIC | NOT NULL, **>= 0** |

**trades**

| Column | Type | Constraints |
|--------|------|----------------|
| id | PK | |
| user_id | FK → users.id | NOT NULL, indexed |
| type | VARCHAR or ENUM | `'BUY'` \| `'SELL'` |
| price | NUMERIC(20, 8) | NOT NULL, > 0 |
| quantity | NUMERIC(20, 8) | NOT NULL, > 0 |
| total_value | NUMERIC(20, 2) | NOT NULL, > 0; USD notional, **2 decimals** (`price × quantity` rounded per §5.4) |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |

### 4.2 Numeric precision (defaults)

| Field | Precision | Notes |
|-------|------------|--------|
| USD amounts (`balance_usd`, `total_value`, costs/proceeds) | **DECIMAL(20, 2)** | **Resolved:** store and round **2 decimal places** only everywhere. |
| BTC quantity | DECIMAL(20, 8) | Align validation max 8 fractional digits |
| Price | DECIMAL(20, 8) | Match Binance tick for BTCUSDT |

All comparisons for “insufficient balance” use **decimal** types, not JS binary floats, in the database layer.

### 4.3 Migrations

Use a migration tool (e.g. **node-pg-migrate**, **Knex**, **Prisma migrate**) — exact choice is implementation detail; migrations are versioned in repo.

---

## 5. Business rules

### 5.1 Initial state

- On signup: `balance_usd = 10000`, `btc quantity = 0`.  
- **Unrealized P&L baseline** = **$10,000** (fixed initial notional for MVP).

### 5.2 Market buy

**Mode A — BTC quantity (`quantity` in API)**

- Input: `quantity` (BTC) **> 0**, max **8** fractional digits.  
- `cost = round(quantity × price)` to **2** USD decimals (§5.4).  
- Reject if `cost > balance_usd`.  
- After trade: `balance_usd -= cost`, `btc += quantity`.

**Mode B — USD spend (`quote_usd` in API)**

- Input: `quote_usd` **> 0**, **2** decimal places max.  
- Compute `quantity_raw = quote_usd / price`, then `quantity` = round to **8** BTC decimals.  
- `cost = round(quantity × price)` to **2** USD decimals (may differ slightly from `quote_usd` due to rounding — **acceptable** for MVP).  
- Reject if `cost > balance_usd` or `quantity` rounds to 0.  
- After trade: same as Mode A.

**Request rule:** Send **either** `quantity` **or** `quote_usd`, not both; if both or neither → **400** `VALIDATION_ERROR`.

### 5.3 Market sell

- Input: `quantity` **> 0**.  
- Reject if `quantity > btc_holding`.  
- `proceeds = round(quantity × price)` to **2** USD decimals.  
- After trade: `btc -= quantity`, `balance_usd += proceeds`.

### 5.4 Rounding & consistency

- **Single source of truth:** persisted balances and `trades.total_value` must match the same rounding rules used for validation.  
- Define **one** function for USD rounding: **half away from zero** to **2** decimal places for all USD amounts.  
- All **USD** storage uses **2** decimals only (resolved).

### 5.5 Portfolio & P&L

- `current_price` = latest **valid** cached BTC/USDT price used by the API (same symbol as trading).  
- `total_value_usd = balance_usd + (btc_quantity × current_price)` rounded to **2** USD decimals for display/API consistency.  
- **`unrealized_pnl = total_value_usd - 10000`** (baseline **initial $10k** only). **No** separate realized P&L or cost-basis metrics in MVP.

Optional for UI: `pnl_percent = (unrealized_pnl / 10000) * 100`.

### 5.6 Idempotency / duplicate submits

- UI: **debounce** or disable button during request.  
- API: optional **Idempotency-Key** header for `POST /trade/*` (nice-to-have); MVP minimum is **client debounce** + clear loading state.

---

## 6. Market data service (backend)

### 6.1 Provider

- **Binance** public API (e.g. `GET /api/v3/ticker/price?symbol=BTCUSDT` or ticker bookTicker) — exact endpoint chosen in implementation; must return a **last** or **mid** price acceptable for “instant market” demo.

### 6.2 Polling & cache

- Background interval or refresh-on-read with TTL: **target 2–3 seconds** freshness for clients.  
- **Cache** the last successful price + `updated_at` server-side to avoid hammering Binance.  
- If Binance fails: return **last good price** with metadata **or** 503 with message — policy in §7.

### 6.3 Rate limiting

- Implement **server-side** throttle (per-IP or global) on `/api/market/*` and `/api/trade/*` as needed (minimal for MVP: protect Binance calls primarily).

---

## 7. API specification

**Base URL:** `/api`  
**Auth:** `Authorization: Bearer <jwt>` on protected routes.

### 7.1 Auth

#### `POST /api/auth/signup`

**Body (JSON):**

```json
{
  "email": "user@example.com",
  "password": "string"
}
```

**Validation:**

- Email format (reasonable RFC 5322 subset or HTML5-style validation).  
- Password: **minimum length 8** (enforced). Do **not** block signup on complexity; show **non-blocking** helper text (e.g. “Using letters, numbers, and symbols is recommended”) per UX copy.

**201 Created:** `{ "token": "<jwt>", "user": { "id": "<uuid|number>", "email": "user@example.com" } }` — **JWT issued immediately** (auto-login). Token expiry **24 hours** (§8).

**409:** Email already registered.  
**400:** Validation errors (structured errors optional).

#### `POST /api/auth/login`

**Body:** `{ "email", "password" }`

**200:** `{ "token": "<jwt>", "user": { "id", "email" } }` — JWT expiry **24 hours** (same as signup).

**401:** Invalid credentials (generic message).

---

### 7.2 Market (may be public or auth-only — default: **public** for simpler testing)

#### `GET /api/market/price`

**200:**

```json
{
  "symbol": "BTCUSDT",
  "price": "97123.45",
  "as_of": "2025-03-22T12:00:00.000Z"
}
```

Use **string** for decimals in JSON to avoid float issues, or numbers with documented precision — **strings recommended** for money/price fields.

**503:** Price unavailable (optional body with `retry_after`).

---

### 7.3 Portfolio (protected)

#### `GET /api/portfolio`

**200:**

```json
{
  "balance_usd": "10000.00",
  "btc_quantity": "0.00000000",
  "btc_price_usd": "97123.45",
  "total_value_usd": "10000.00",
  "unrealized_pnl_usd": "0.00",
  "initial_equity_usd": "10000.00"
}
```

`btc_price_usd` should match the same cached price used for valuation.

---

### 7.4 Trading (protected)

#### `POST /api/trade/buy`

Send **exactly one** of the following (mutually exclusive):

**By BTC quantity:**

```json
{ "quantity": "0.001" }
```

**By USD amount to spend:**

```json
{ "quote_usd": "100.00" }
```

**200:**

```json
{
  "trade": {
    "id": "...",
    "type": "BUY",
    "price": "97123.45",
    "quantity": "0.001",
    "total_value": "97.12",
    "created_at": "..."
  },
  "portfolio": { "...subset or full portfolio object..." }
}
```

**400:** Invalid body (both/neither `quantity` and `quote_usd`), precision, or insufficient funds.  
**401:** Missing/invalid JWT.

#### `POST /api/trade/sell`

Same shape with `"type": "SELL"`; failures include insufficient BTC.

---

### 7.5 Trades (protected)

#### `GET /api/trades?limit=50&offset=0`

**200:**

```json
{
  "trades": [
    {
      "id": "1",
      "type": "BUY",
      "price": "97123.45",
      "quantity": "0.001",
      "total_value": "97.12",
      "created_at": "..."
    }
  ],
  "total": 42
}
```

Default sort: **newest first** (`created_at DESC`).

---

### 7.6 Errors (convention)

Use a consistent envelope:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Not enough USD balance."
  }
}
```

Minimum **codes** for MVP: `VALIDATION_ERROR`, `UNAUTHORIZED`, `INSUFFICIENT_FUNDS`, `INSUFFICIENT_BTC`, `PRICE_UNAVAILABLE`.

---

## 8. Security

| Topic | Requirement |
|-------|--------------|
| Passwords | **bcrypt** (cost factor 10–12), never store plaintext |
| Transport | **HTTPS** in production |
| Auth | **JWT** with expiry **24 hours** from issue, signed with strong secret (`JWT_SECRET`) |
| Input | Validate all bodies/params; reject oversize payloads |
| Headers | `helmet`-style headers on Express (recommended) |
| CORS | Restrict to frontend origin(s) via env |
| SQL | Parameterized queries only |

---

## 9. Frontend

### 9.1 Tech

- **Vite + React** (SPA; client-side routing, e.g. React Router)  
- **Tailwind CSS**  
- **Axios** (interceptors for JWT, base URL)

### 9.2 Pages / routes

1. **Auth** — Login + Signup (tabs or toggle).  
2. **Dashboard** — BTC price (large), embedded **chart widget** (e.g. TradingView), buy/sell form (**buy:** linked **BTC quantity** and **USD spend** fields), portfolio summary.  
3. **Trade history** — Table or list; mobile-friendly stacking.

### 9.3 Client behavior

- Poll **price** every **2–3s** (aligned with backend cache).  
- After successful trade, **refresh** portfolio (or apply response payload).  
- **Debounce** submit buttons; show loading and error toasts.  
- Display numbers with fixed decimals (USD 2, BTC up to 8).

### 9.4 Chart widget

- Use vendor’s **embed** / widget script; **no** custom canvas/WebGL chart for MVP.  
- Document any **domain allowlist** or CSP requirements for the iframe/script.

---

## 10. Non-functional requirements

| Area | Target |
|------|--------|
| Latency | API p95 &lt; 500ms excluding Binance (local network) |
| Uptime | Best-effort; no SLA for MVP |
| Logging | Structured logs for errors + trade failures |
| Config | 12-factor env vars: `DATABASE_URL`, `JWT_SECRET` (signing), `JWT_EXPIRES_IN=24h` (or equivalent), `BINANCE_BASE_URL` (optional), `CORS_ORIGIN`, `PORT` |

---

## 11. Testing (recommended scope)

- **Unit:** rounding, P&L, buy/sell balance math with fixtures.  
- **Integration:** DB transactions for buy/sell (rollback on constraint violation).  
- **API:** auth, unauthorized access, happy paths.  
- **E2E (optional):** signup → buy → sell → history visible.

---

## 12. Project structure (suggested)

```
TradeLab/
  server/          # Express app, routes, services, db
  client/          # Vite + React SPA
  PROJECT_SPEC.md  # this document
  README.md        # setup, env, run scripts
```

(Monorepo vs two folders is flexible.)

---

## 13. Milestones (aligned with original plan)

1. **Backend core:** DB schema, auth, wallet init, trade + portfolio services.  
2. **Frontend:** Auth UI, dashboard layout, API wiring.  
3. **Market:** Price worker/cache, dashboard polling.  
4. **Hardening:** Edge cases, balance checks, UI polish, basic tests.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Float rounding bugs | Decimals in DB; strings in JSON; single rounding function |
| Binance downtime | Serve stale cache with timestamp; clear UI banner |
| JWT theft | HTTPS; short-ish expiry; httpOnly cookie optional later |

---

## 15. Glossary

- **Market order (demo):** Immediate execution at **last known** server price — no queue.  
- **Unrealized P&L:** Mark-to-market **total portfolio value** vs **initial $10k** only; no realized/average-cost P&L in MVP.

---

## 16. Resolved product decisions

| # | Topic | Decision |
|---|--------|----------|
| 1 | **Signup** | Return **JWT immediately** with `{ token, user }` (auto-login). |
| 2 | **Buy UX** | UI exposes **both** BTC quantity and USD spend (linked/editing one updates the other). API accepts **either** `quantity` or `quote_usd` per request, **not both** (§5.2, §7.4). |
| 3 | **USD precision** | **2 decimal places** everywhere (storage, API, rounding). |
| 4 | **Password** | **Minimum length 8** (enforced). **Suggest** stronger complexity in copy; **do not** enforce letter/number rules in MVP. |
| 5 | **JWT** | Expiry **24 hours** from issue. |
| 6 | **Frontend** | **Vite + React SPA** (not Next.js for MVP). |
| 7 | **P&L** | **Unrealized vs initial $10k** only; no realized P&L / cost-basis metrics. |

---

*End of specification.*

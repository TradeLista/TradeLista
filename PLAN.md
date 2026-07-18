# TradeLista — Project Plan

> Handover document. This is the full concept for TradeLista, worked out before development.
> Read this first, then help me build it step by step.

## What TradeLista is

A trading journal web app. Traders see their PnL and review their trades on a calendar.
Trades arrive automatically from MetaTrader 4/5 via an Expert Advisor (EA), OR are entered
manually by users without an EA. The whole UI is in **English**. Dark design/theme.

Domain: tradelista.com

## Tech stack (decided)

- **Supabase** — database, authentication (login/signup), file storage (trade images).
  Row Level Security so each user only sees their own data; admin can see all via the DB.
- **Stripe** — subscription billing ($10/month Pro plan). "Cancel subscription" lives in the profile.
- **sevDesk** — accounting, connected to Stripe later (does not touch the website code).
- Frontend framework to be chosen at build time (React/Next.js likely). Dark theme.
- UI design guided by the `ui-ux-pro-max` skill in `.claude/skills/` (dark trading dashboard look).

## Data flow

MT4/MT5 + EA  ─┐
               ├─►  API / server  ─►  Supabase (DB + auth + image storage)  ─►  Calendar + PnL UI
Manual entry  ─┘

The EA fires a WebRequest on each closed trade to the API, including account balance,
equity and currency (via AccountBalance(), AccountEquity(), AccountCurrency()).
The API writes it to Supabase against the correct account (matched by api_key).

## Pages

1. **Home** — landing page.
2. **Contact**.
3. **Pricing** — Free vs Pro ($10/month).
4. **Profile** (icon top-right) — edit name, reset password, cancel subscription.
5. **MT4/MT5 Connection guide** — explains how to connect the EA to the account.
6. **Calendar + PnL** — the core page (see below).
7. **Legal pages** (before launch): Privacy Policy, Imprint (Impressum), Terms.

## Calendar (the core)

- Each day shows green (net profit) or red (net loss) + the day's summed result.
- Percentage PnL shown **above the calendar** (currency-independent).
- Calendar goes back in time; days are viewable/editable.
- Click a day → list of that day's individual trades.
- Click a single trade → user can:
  - upload up to **3 images** per trade,
  - write a text note,
  - answer the **6 reflection questions** (collapsible section).
- Currency: shown per account in the account's own currency (no conversion). Percentage is
  the same regardless of currency. If a user has multiple accounts, they pick which account
  to view at the top.

## The 6 reflection questions (English, Yes/No)

If the user answers **No**, a small text box appears below that question so they can write
what went wrong. On Yes, it stays closed. Each question stores Yes/No + optional explanation.

1. Did you follow your trading strategy?
2. Did you engage in revenge trading?
3. Did you set and respect your stop-loss?
4. Did you stick to your planned position size (risk)?
5. Was this a planned setup — or boredom/FOMO?
6. Did you keep your emotions under control during the trade?

## Golden Trading Rules

- User can save up to **10** personal "golden trading rules" (e.g. "I never trade during news").
- Shown as a **collapsible** panel under the calendar. User can minimize it if not wanted.

## Manual trade entry (users without EA)

User enters: entry, exit, symbol/pair, lot size, profit/loss.
User sets a **starting balance** per account (once), so percentage PnL can be computed
(profit ÷ starting balance). EA accounts get balance/currency automatically, no input needed.

## Plans

**Free**
- 1 trade per calendar week (Mon–Sun, resets every Monday).
- Manual entry only (no EA).
- Text note only — NO image upload.
- NO reflection questions.
- No multiple accounts.

**Pro ($10/month)**
- Everything: EA connection, up to **5** connected accounts, image uploads (3 per trade),
  reflection questions, unlimited trades.

## Database schema (Supabase)

- **profiles**: id (PK), email, full_name, plan
- **subscriptions**: id (PK), user_id (FK), stripe_customer_id, status, current_period_end
- **accounts**: id (PK), user_id (FK), name, source (ea | manual), currency,
  starting_balance, api_key
- **trades**: id (PK), account_id (FK), symbol, lot_size, entry_price, exit_price,
  profit, closed_at
- **trade_images**: id (PK), trade_id (FK), image_url  (max 3 per trade; files in Supabase Storage)
- **trade_notes**: id (PK), trade_id (FK), note, plus per-question Yes/No + optional text:
  q_strategy, q_revenge, q_stoploss, q_position_size, q_planned_setup, q_emotions
  (and a matching explanation text field for each, filled when answer is No)
- **trading_rules**: id (PK), user_id (FK), rule_text, sort_order  (max 10 per user)

Every table links to the user via user_id → RLS ensures each user sees only their own data.

## Legal / privacy notes (before launch, not now)

- Operator is GDPR "controller". Data may be used for the service's purpose (running the journal,
  support, fixes) — NOT for other purposes without consent.
- Needed before taking paying customers: Privacy Policy, Imprint, Terms.
- Trading data is sensitive → strong security expected. Supabase (encryption, RLS) + Stripe
  (never store card data ourselves) cover most of this.
- Get a one-time review from an IT/data-protection lawyer before launch. (Not legal advice.)

## Suggested build order

1. Project scaffold with chosen stack + dark theme, wire up the `.claude/skills` UI skill.
2. Supabase: create the schema above + auth + storage + RLS policies.
3. Pages: Home, Pricing, Profile, Contact.
4. Calendar + PnL core (day view, trade view, images, notes, 6 questions, golden rules).
5. Manual trade entry + percentage calc.
6. Stripe subscription (Pro plan, cancel in profile) + free-tier limits.
7. MT4/MT5 EA (MQL4/MQL5) + the API endpoint that receives trades.
8. Legal pages, then pre-launch security review.

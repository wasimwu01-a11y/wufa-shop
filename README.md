# Wufa Ltd shop

Static site in `public/`, plus two Netlify Functions:

- `GET /api/products` – reads the seller's live fixed-price eBay listings (eBay Browse API, app keys only) and returns them priced for the site. Cached ~5 minutes.
- `POST /api/checkout` – re-checks one listing with eBay and opens a Stripe Checkout page for it.

If eBay isn't connected or fails, the homepage falls back to the pet hair roller with its fixed Stripe Payment Link.

## Netlify environment variables
Required: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `STRIPE_SECRET_KEY`
Optional: `EBAY_SELLER` (default `nuvr_61`), `SITE_DISCOUNT_PERCENT`, `SHIPPING_FEE_GBP`, `SHIPPING_LABEL`, `SHIP_COUNTRIES` (default `GB`)

Never commit keys to this repository – set them only in Netlify.

## Dropship agent (Phase 1: foundations)
See the plan document. Phase 1 adds:
- `netlify/lib/agent/` – settings (approvals only ever go to wasim.wu.01@gmail.com), pricing rule (£1.50 floor, 9p rounding, competitor check), Netlify Blobs store, signed one-time email buttons, email templates (Resend).
- `/agent/act` – the page behind every email button (shows a confirm page; acts only on POST).
- `/agent/selftest?key=<AGENT_SECRET>` – sends two TEST emails so the buttons can be tried.

Extra Netlify environment variables: `AGENT_SECRET` (40+ random characters), `RESEND_API_KEY`.

## Dropship agent (Phase 2: research)
- `netlify/lib/agent/research.mjs` – Claude (web search + web fetch) finds one product + UK wholesale dropship supplier and returns it via a `submit_proposal` tool.
- `netlify/lib/agent/pipeline.mjs` – pacing (one proposal per 3 days, none while one is waiting), price/competition checks (eBay API when connected, otherwise estimated), proposal email.
- `agent-schedule` runs daily 07:10 UTC; `agent-research-background` does the work (up to 15 min).
- `/agent/research-now?key=<AGENT_SECRET>` – start a run now. `/agent/status?key=<AGENT_SECRET>` – what the agent is doing.
- "Registration done" asks for the real trade price and delivery, then re-checks the £1.50 rule.

Extra settings: `ANTHROPIC_API_KEY` (wufa workspace). Optional: `AGENT_MODEL` (default claude-sonnet-5-5), `AGENT_PAUSED=1` to pause, `AGENT_MAX_SEARCHES` (20), `AGENT_MAX_FETCHES` (15), `AGENT_ATTEMPTS` (2).
- Supplier memory (`netlify/lib/agent/suppliers.mjs`): every supplier checked is remembered with its verdict; `/agent/suppliers?key=<AGENT_SECRET>` lets you mark accounts and trade discounts (your settings are never overwritten). An empty run waits 3 days before retrying (research-now still works).
- Persistent research: a run keeps trying new candidates (feedback on each failure) until one passes, up to ~11 minutes; then it chains another run while today's budget remains. `AGENT_DAILY_BUDGET_USD` (default 3), `AGENT_MAX_ATTEMPTS` per run (default 8).
- Rule 8: if the supplier sells the same item on eBay, our price must be at or below its own eBay price.

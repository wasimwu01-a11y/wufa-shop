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
- `netlify/lib/agent/pipeline.mjs` – pacing (one proposal a day, none while one is waiting), price/competition checks (eBay API when connected, otherwise estimated), proposal email.
- `agent-schedule` runs daily 07:10 UTC; `agent-research-background` does the work (up to 15 min).
- `/agent/research-now?key=<AGENT_SECRET>` – start a run now. `/agent/status?key=<AGENT_SECRET>` – what the agent is doing.
- "Registration done" asks for the real trade price and delivery, then re-checks the £1.50 rule.

Extra settings: `ANTHROPIC_API_KEY` (wufa workspace). Optional: `AGENT_MODEL` (default claude-sonnet-5-5), `AGENT_PAUSED=1` to pause, `AGENT_MAX_SEARCHES` (20), `AGENT_MAX_FETCHES` (15), `AGENT_ATTEMPTS` (2).
- Supplier memory (`netlify/lib/agent/suppliers.mjs`): every supplier checked is remembered with its verdict; `/agent/suppliers?key=<AGENT_SECRET>` lets you mark accounts and trade discounts (your settings are never overwritten). An empty run waits 3 days before retrying (research-now still works).
- Persistent research: a run keeps trying new candidates (feedback on each failure) until one passes, up to ~11 minutes; then it chains another run while today's budget remains. `AGENT_DAILY_BUDGET_USD` (default 3), `AGENT_MAX_ATTEMPTS` per run (default 8).
- Rule 8: if the supplier sells the same item on eBay, our price must be at or below its own eBay price.

## Product screener + listing queue
- `/agent/screener?key=<AGENT_SECRET>` – upload Something Different (`DropshipStockFull.txt`) and/or AW (`shop_awd.csv`) files. The browser parses them; the server applies the rules (`netlify/lib/agent/catalog.mjs`: allowed categories, VAT on cost and delivery, supplier delivery bands, £1.50 profit), then checks survivors on eBay UK (`ebayMatch`: barcode + title matches, own listings ignored). Tick winners → "Add selected to listing queue".
- The agent proposes the best queued product once a day (re-checking its eBay price first). Approving a queued product goes straight to `ready_to_list` (known supplier cost).
- When the queue runs out the agent emails you once (weekly reminder): add products with the screener, or press "Allow internet research" (stored in Blobs `agent/settings`; "Stop internet research" button on research proposals). `AGENT_AI_RESEARCH=1` forces it on. Screening uses ~2 eBay API calls per product (Browse API limit ~5,000/day).

## Dropship agent (Phase 4: listing on eBay)
- One-time setup: in the eBay developer portal (User Tokens → "Get a Token from eBay via Your Application") add a redirect URL with
  accept URL `https://wufa-shop.netlify.app/agent/ebay-callback`; copy its **RuName** into Netlify as `EBAY_RUNAME`.
- In Seller Hub → Business policies create postage policies named **Wufa DS 1 day** (Something Different) and **Wufa DS 2 days** (AW),
  or set `EBAY_POSTAGE_POLICY_SD` / `EBAY_POSTAGE_POLICY_AW` to your own names. A return and payment policy must exist.
- Open `/agent/ebay-connect?key=<AGENT_SECRET>` and sign in to eBay as nuvr_61. Access lasts ~18 months; the agent emails before it expires.
- Approving a queue proposal (title editable) lists it on eBay within minutes and emails the link. If eBay refuses, you get an email
  with the fix and a "Try again" button. Agent listings stay off the website until website orders for dropship items are automated
  (`AGENT_SITE_DROPSHIP=1`, Phase 3). Optional: `SD_POSTCODE`, `AW_POSTCODE` for the item location.

## Demand rule
- Before proposing, the agent estimates sales per month across similar new UK eBay listings (eBay's "sold" count ÷ months listed).
- Your original AW / Something Different queue needs at least `DEMAND_MIN_PER_MONTH_EXISTING` (default 1) a month;
  products from any other supplier need `DEMAND_MIN_PER_MONTH` (default 100). Products below the bar are marked `no_demand` and skipped.
- The screener's "Check eBay demand" button shows the breakdown for the whole queue and saves the results.

## CJ Dropshipping (UK warehouse)
- Set `CJ_API_KEY` in Netlify. The screener page has "Find products from CJ"; it also runs daily when fewer than `CJ_QUEUE_TARGET` (10) CJ products wait.
- Only variants with 5+ units in CJ's UK warehouse and a UK→UK delivery of 7 days or less are used.
- Cost = CJ price + delivery (USD → GBP at the day's rate + `CJ_FX_BUFFER` 3% card fee) + 20% VAT (`CJ_ADD_VAT=0` to drop if CJ invoices without VAT).
- Products must sell `DEMAND_MIN_PER_MONTH` (100) a month on eBay UK and beat the cheapest rival with £1.50 profit.
- eBay postage policy for CJ listings: `EBAY_POSTAGE_POLICY_CJ` (default "Wufa DS 2 days"); item location `CJ_LOCATION_CITY` / `CJ_POSTCODE`.

## Pace, EANs and Promoted Listings
- One new proposal a day (`AGENT_LISTING_INTERVAL_DAYS`, default 1); none while one is waiting for you.
- Listings carry the supplier's barcode as EAN/UPC when it has a valid check digit.
- Every new agent listing gets a Promoted Listings Standard ad at the break-even rate (profit ÷ price incl. VAT on the fee),
  in the campaign "Wufa agent – break-even (auto)", for `AGENT_PROMOTE_DAYS` (30) days; then the ad is removed.
  Rates under eBay's 2% minimum are skipped. `AGENT_PROMOTE=0` turns it off. Needs one reconnect at /agent/ebay-connect (marketing permission).

## Self-learning (weekly)
- Each week (`agent-learn-background`, started by the daily schedule) the agent collects, for every agent listing: eBay traffic
  (Analytics API: impressions, views, click-through, conversion), your orders (Fulfillment API), the cheapest rival price, and
  fresh eBay demand for the top of the queue (to spot rising/falling products).
- It learns smoothed click-through × conversion per supplier, supplier category, price band, photo count and promotion, and uses it
  (with the demand trend) to rank the listing queue and to brief Claude and internet research.
- Changes it makes by itself (listings 14+ days old with no sales; at most `AGENT_LEARN_MAX_CHANGES` (6) a week):
  new title (few search appearances, or seen but not clicked; every 21+ days), new description (30+ views, no sale; every 30+ days),
  end the listing (45+ days, no sales after a new title, or rivals now under our minimum price). Selling listings are left alone.
- Claude (`AGENT_WRITER_MODEL`, default claude-haiku-5-5) writes titles/descriptions from the supplier's facts and rival listings'
  search words; results are checked (length, no health/brand claims, same product) with a rule-based fallback. New proposals come
  with a Claude title (editable on the approve page) and new listings with a Claude description. Spend counts against the daily AI budget.
- One weekly email shows what it learned and changed, with Undo / Relist buttons (undo also stops that kind of change on that listing).
- Turn off: `AGENT_LEARN=0` (whole loop), `AGENT_LEARN_AUTO=0` (learn and report but don't change listings), `AGENT_AI_WRITING=0` (no Claude).
- Needs the eBay reconnect (analytics + marketing permissions) at /agent/ebay-connect.

## Website orders for agent products (Stripe webhook)
- `POST /api/stripe-webhook` (signed with `STRIPE_WEBHOOK_SECRET`, event `checkout.session.completed`):
  agent product → order + order pack email (supplier, code, address, NI/Highlands surcharge warning); your own product → "post from stock" email.
- Agent products appear on the website (with the supplier's delivery time) once `STRIPE_WEBHOOK_SECRET` is set; `AGENT_SITE_DROPSHIP=0` hides them.
- After you enter tracking for a website order, the confirmation page has a one-tap email to the customer (sent from your own email app).
- Website wording now says "shipped from the UK" instead of Belfast.

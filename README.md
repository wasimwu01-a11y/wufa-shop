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

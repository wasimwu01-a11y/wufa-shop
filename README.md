# Wufa Ltd shop

Static site in `public/`, plus two Netlify Functions:

- `GET /api/products` – reads the seller's live fixed-price eBay listings (eBay Browse API, app keys only) and returns them priced for the site. Cached ~5 minutes.
- `POST /api/checkout` – re-checks one listing with eBay and opens a Stripe Checkout page for it.

If eBay isn't connected or fails, the homepage falls back to the pet hair roller with its fixed Stripe Payment Link.

## Netlify environment variables
Required: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `STRIPE_SECRET_KEY`
Optional: `EBAY_SELLER` (default `nuvr_61`), `SITE_DISCOUNT_PERCENT`, `SHIPPING_FEE_GBP`, `SHIPPING_LABEL`, `SHIP_COUNTRIES` (default `GB`)

Never commit keys to this repository – set them only in Netlify.

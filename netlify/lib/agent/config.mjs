// Agent settings. The recipient is fixed in code on purpose: no setting, email or web request can redirect
// approvals or order details anywhere else.
export const AGENT_EMAIL = "wasim.wu.01@gmail.com";

export const MIN_PROFIT_GBP = 1.5;          // profit floor per item after every cost
export const LISTING_INTERVAL_DAYS = 3;     // at most one new listing every three days
export const APPROVAL_TTL_DAYS = 5;         // approval buttons expire after this
export const ORDER_TTL_DAYS = 30;           // order-pack buttons stay valid until handled (30-day hard cap)

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
export { env };

export function siteUrl() {
  // Netlify sets URL to the project's main address; SITE_URL can override it.
  return env("SITE_URL") || env("URL") || "http://localhost:8888";
}

// GET /api/products → the shop's live eBay listings, priced for the website.
import { listProducts, configProblem, json } from "../lib/shop.mjs";

export default async () => {
  const problem = configProblem();
  if (problem) return json({ products: [], error: problem }, 503, { "Cache-Control": "no-store" });
  try {
    const products = await listProducts();
    return json({ products, updated: new Date().toISOString() }, 200, {
      // Browsers re-check every minute; Netlify's CDN keeps a copy for 5 minutes,
      // so new eBay listings appear on the site within about 5 minutes.
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    });
  } catch (e) {
    console.error(e);
    return json({ products: [], error: "Could not load products from eBay right now." }, 502, { "Cache-Control": "no-store" });
  }
};

export const config = { path: "/api/products" };

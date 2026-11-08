// Supplier memory: every supplier the agent has checked, its verdict and why,
// plus what Wufa has told it (registered? trade discount?).
import { getJSON, setJSON, listKeys } from "./store.mjs";

export const hostOf = (u) => {
  try { return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};
const keyOf = (host) => "supplier/" + host.replace(/[^a-z0-9.-]/g, "");

// What earlier research runs already established (8 Nov 2026), so the next run doesn't repeat it.
const SEED = [
  { name: "TBTrade (TekBox Ltd)", url: "https://www.tbtrade.co.uk", verdict: "ok",
    reason: "Dropship FAQ: no minimum order or joining fee; each order paid by card (Stripe) or PayPal at checkout; same-day dispatch before 1pm, plain packaging, tracked; free UK delivery (allow up to 5 working days). Also sells on eBay as tekbox.ltd, so its public prices are the competition – only works with the trade discount." },
  { name: "Dropora", url: "https://dropora.uk", verdict: "rejected", reason: "Wallet top-up (£200 minimum); trade prices behind login" },
  { name: "Avasam", url: "https://www.avasam.com", verdict: "rejected", reason: "Automatic card deposit to cover invoices; no per-order card payment" },
  { name: "Not In The Dog House", url: "https://www.notinthedoghouse.co.uk", verdict: "rejected", reason: "Prepaid terms by bank transfer" },
  { name: "Go Dropship", url: "https://godropship.co.uk", verdict: "rejected", reason: "Reports of shipping from China; untracked large-letter parcels; payment terms unverified" },
];

async function seedOnce() {
  if (await getJSON("meta/suppliers-seeded")) return;
  for (const s of SEED) {
    const host = hostOf(s.url);
    if (!(await getJSON(keyOf(host)))) await setJSON(keyOf(host), { ...s, host, registered: false, discountNote: "", by: "seed", checkedAt: "2026-11-08" });
  }
  await setJSON("meta/suppliers-seeded", { at: new Date().toISOString() });
}

export async function allSuppliers() {
  await seedOnce();
  const out = [];
  for (const k of await listKeys("supplier/")) { const s = await getJSON(k); if (s) out.push(s); }
  return out.sort((a, b) => (a.verdict === b.verdict ? a.name.localeCompare(b.name) : a.verdict === "ok" ? -1 : 1));
}

export async function getSupplier(url) {
  const host = hostOf(url);
  return host ? getJSON(keyOf(host)) : null;
}

/** Save what a research run found. Never overrides Wufa's own settings (registered, discount, manual verdict). */
export async function recordChecks(list = []) {
  for (const c of list.slice(0, 20)) {
    const host = hostOf(c?.url);
    if (!host || !c?.name || !["ok", "rejected"].includes(c.verdict)) continue;
    const cur = (await getJSON(keyOf(host))) || {};
    if (cur.by === "you") continue; // Wufa decided this one
    await setJSON(keyOf(host), {
      ...cur, name: cur.name || String(c.name).slice(0, 80), url: cur.url || "https://" + host, host,
      verdict: c.verdict, reason: String(c.reason || "").slice(0, 400), registered: !!cur.registered, discountNote: cur.discountNote || "",
      by: "agent", checkedAt: new Date().toISOString().slice(0, 10),
    });
  }
}

/** Save Wufa's own settings for a supplier (from the suppliers page). */
export async function setByYou(host, changes) {
  const cur = (await getJSON(keyOf(host))) || { host, url: "https://" + host, name: host };
  const next = { ...cur, ...changes, host, by: "you", checkedAt: new Date().toISOString().slice(0, 10) };
  await setJSON(keyOf(host), next);
  return next;
}

/** Text for the research prompt. */
export async function supplierBrief() {
  const all = await allSuppliers();
  const good = all.filter((s) => s.verdict === "ok");
  const bad = all.filter((s) => s.verdict === "rejected");
  const g = good.map((s) => `- ${s.name} (${s.url})${s.registered ? " – WUFA HAS AN ACCOUNT" : ""}${s.discountNote ? " – trade pricing: " + s.discountNote : ""}. ${s.reason}`).join("\n");
  const b = bad.map((s) => `- ${s.name} (${s.host}): ${s.reason}`).join("\n");
  return `Suppliers already approved (start with these; prefer ones where Wufa has an account):\n${g || "- none yet"}\n\nSuppliers already rejected (do NOT re-check them):\n${b || "- none yet"}`;
}

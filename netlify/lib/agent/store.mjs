// Small key-value store for the agent (proposals, suppliers, listings, orders, used buttons).
// On Netlify it uses Netlify Blobs; tests set AGENT_STORE=memory.
import { env } from "./config.mjs";

const mem = new Map();
let getStoreFn = null;

// A fresh store handle on every call: Netlify gives each request its own short-lived access token,
// so a handle kept from an earlier request fails with "Token expired" once the function stays warm.
async function store() {
  if (env("AGENT_STORE") === "memory") return null;
  if (!getStoreFn) getStoreFn = (await import("@netlify/blobs")).getStore;
  return getStoreFn({ name: "wufa-agent", consistency: "strong" });
}

export async function getJSON(key) {
  const s = await store();
  if (!s) return mem.has(key) ? structuredClone(mem.get(key)) : null;
  return (await s.get(key, { type: "json" })) ?? null;
}

export async function setJSON(key, value) {
  const s = await store();
  if (!s) { mem.set(key, structuredClone(value)); return; }
  await s.setJSON(key, value);
}

export async function listKeys(prefix) {
  const s = await store();
  if (!s) return [...mem.keys()].filter((k) => k.startsWith(prefix)).sort();
  const { blobs: items } = await s.list({ prefix });
  return items.map((b) => b.key).sort();
}

/** Reads every item under a prefix, many at a time (fast even with hundreds of items). Returns [{ k, v }]. */
export async function getAll(prefix, concurrency = 40) {
  const keys = await listKeys(prefix);
  const out = new Array(keys.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (i < keys.length) { const n = i++; out[n] = { k: keys[n], v: await getJSON(keys[n]).catch(() => null) }; }
  }));
  return out.filter((x) => x.v);
}

// Append a line to an item's history so every decision can be traced later.
export async function update(key, changes, note) {
  const cur = (await getJSON(key)) || {};
  const next = { ...cur, ...changes, history: [...(cur.history || []), { at: new Date().toISOString(), note }] };
  await setJSON(key, next);
  return next;
}

export function newId(prefix) {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return prefix + "-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Buffer.from(r).toString("hex");
}

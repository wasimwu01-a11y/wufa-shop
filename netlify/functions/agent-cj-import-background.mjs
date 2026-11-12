// Background job (up to 15 min): finds CJ UK-warehouse products that sell 100+ a month on eBay UK
// and leave £1.50 profit, and adds them to the listing queue. Started by the daily schedule or the screener page.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, setJSON } from "../lib/agent/store.mjs";
import { importFromCJ, cjProblem } from "../lib/agent/cj.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  if (req.method !== "POST" || !env("AGENT_SECRET") || !same(req.headers.get("x-agent-key") || "", env("AGENT_SECRET"))) return;
  if (cjProblem()) { console.log(cjProblem()); return; }
  const lock = await getJSON("cj/running");
  if (lock && Date.now() - Date.parse(lock.at) < 16 * 60e3) { console.log("CJ import already running"); return; }
  await setJSON("cj/running", { at: new Date().toISOString() });
  try { console.log("CJ import:", JSON.stringify(await importFromCJ())); }
  catch (e) { console.error("CJ import failed:", e); }
  finally { await setJSON("cj/running", { at: new Date(0).toISOString() }); }
};

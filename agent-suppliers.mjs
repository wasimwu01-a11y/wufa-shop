// /agent/suppliers?key=<AGENT_SECRET>  – see the agent's supplier memory and tell it
// which suppliers you have an account with and what trade discount you get.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { allSuppliers, setByYou, hostOf } from "../lib/agent/suppliers.mjs";
import { esc } from "../lib/agent/email.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function page(key, list, msg = "") {
  const rows = list.map((s) => `
<form method="post" class="c">
  <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="host" value="${esc(s.host)}">
  <div class="h"><b>${esc(s.name)}</b> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a>
    <span class="tag ${s.verdict === "ok" ? "ok" : "no"}">${s.verdict === "ok" ? "approved" : "rejected"}</span>
    <span class="m">checked ${esc(s.checkedAt || "")} by ${s.by === "you" ? "you" : s.by === "seed" ? "earlier research" : "agent"}</span></div>
  <p class="m">${esc(s.reason || "")}</p>
  <div class="g">
    <label>Verdict <select name="verdict"><option value="ok"${s.verdict === "ok" ? " selected" : ""}>Approved</option><option value="rejected"${s.verdict === "rejected" ? " selected" : ""}>Rejected</option></select></label>
    <label><input type="checkbox" name="registered" value="1"${s.registered ? " checked" : ""}> I have an account</label>
    <label class="w">Trade pricing note <input name="discountNote" maxlength="200" value="${esc(s.discountNote || "")}" placeholder="e.g. about 25% off the listed price, inc VAT"></label>
  </div>
  <button>Save</button>
</form>`).join("");
  return new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Agent suppliers</title>
<style>:root{--bg:#fafaf8;--card:#fff;--text:#1d1d1b;--muted:#625f58;--line:#e4e1da;--accent:#c8372d}@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#201f1d;--text:#f2f0eb;--muted:#a9a59c;--line:#34322e}}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
.w0{max-width:760px;margin:0 auto;padding:24px 16px}.c{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
.h{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}.m{color:var(--muted);font-size:.88rem;margin:6px 0}a{color:inherit}
.tag{font-size:.75rem;font-weight:700;padding:2px 8px;border-radius:99px}.ok{background:#1f8a4c22;color:#1f8a4c}.no{background:#c8372d22;color:var(--accent)}
.g{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:8px 0}.w{flex:1 1 260px}label{font-size:.9rem}
input[name=discountNote],input[name=url],input[name=name],select{display:block;width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{font:inherit;font-weight:600;padding:8px 16px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}.msg{background:#1f8a4c22;padding:10px 12px;border-radius:8px}</style></head>
<body><div class="w0"><h1 style="font-size:1.3rem">Agent suppliers</h1>
<p class="m">The agent starts with approved suppliers and skips rejected ones. Tick "I have an account" and add a trade pricing note so it can price products properly. Your settings are never overwritten by the agent.</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ""}
${rows}
<form method="post" class="c"><input type="hidden" name="key" value="${esc(key)}"><b>Add a supplier</b>
<div class="g"><label class="w">Name <input name="name" maxlength="80" required></label><label class="w">Website <input name="url" type="url" required placeholder="https://"></label>
<label>Verdict <select name="verdict"><option value="ok">Approved</option><option value="rejected">Rejected</option></select></label></div><button>Add</button></form>
</div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

export default async (req) => {
  let key = new URL(req.url).searchParams.get("key") || "";
  let form = null;
  if (req.method === "POST") { form = await req.formData(); key = String(form.get("key") || ""); }
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return new Response("Not found", { status: 404 });
  let msg = "";
  if (form) {
    const verdict = form.get("verdict") === "rejected" ? "rejected" : "ok";
    if (form.get("host")) {
      const s = await setByYou(String(form.get("host")), { verdict, registered: form.get("registered") === "1", discountNote: String(form.get("discountNote") || "").slice(0, 200) });
      msg = "Saved " + s.name + ".";
    } else {
      const host = hostOf(form.get("url"));
      if (!host || !/^https?:\/\//i.test(String(form.get("url")))) msg = "Please enter a full website address starting with https://";
      else { await setByYou(host, { name: String(form.get("name")).slice(0, 80), url: "https://" + host, verdict, registered: false, discountNote: "", reason: "Added by you" }); msg = "Added " + host + "."; }
    }
  }
  return page(key, await allSuppliers(), msg);
};

export const config = { path: "/agent/suppliers" };

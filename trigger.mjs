// Starts the background research job.
import { env, siteUrl } from "./config.mjs";

export async function startResearch(force = false) {
  const res = await fetch(siteUrl() + "/.netlify/functions/agent-research-background", {
    method: "POST",
    headers: { "x-agent-key": env("AGENT_SECRET"), "content-type": "application/json" },
    body: JSON.stringify({ force }),
  });
  // Netlify answers 202 straight away for background functions.
  return res.status;
}

export async function startListing() {
  const res = await fetch(siteUrl() + "/.netlify/functions/agent-list-background", {
    method: "POST", headers: { "x-agent-key": env("AGENT_SECRET"), "content-type": "application/json" }, body: "{}",
  });
  return res.status;
}

export async function startCjImport() {
  const res = await fetch(siteUrl() + "/.netlify/functions/agent-cj-import-background", {
    method: "POST", headers: { "x-agent-key": env("AGENT_SECRET"), "content-type": "application/json" }, body: "{}",
  });
  return res.status;
}

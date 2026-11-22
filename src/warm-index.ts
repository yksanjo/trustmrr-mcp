#!/usr/bin/env node
// Pages through the whole TrustMRR catalogue once so every website lookup is instant.
// At the API's 20 requests/min this takes about (startups / 10) * 3.3 seconds.
import { configFromEnv, createContext } from "./server.js";

const { client, index } = createContext(configFromEnv());
const started = Date.now();
while (!index.status().scanComplete) {
  await index.scan(client, 5);
  const st = index.status();
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.error(`scanned ${st.scannedStartups}/${st.catalogueTotal ?? "?"} · ${st.indexedDomains} domains · ${mins} min`);
}
console.error(`Done. Index saved to ${index.status().indexPath}`);

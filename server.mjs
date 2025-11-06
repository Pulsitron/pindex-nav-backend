import express from "express";
import cors from "cors";
import cron from "node-cron";
import pkg from "pg";
const { Client } = pkg;

// Railway port / DB URL
const PORT = process.env.PORT || 8080;
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.log("DATABASE_URL is not set. Set this in Railway.");
}

// Dexscreener PINDEX/USD pair
// https://dexscreener.com/pulsechain/0xc4056ab039378dee12de721f39b6e54fa09ee55b
const DEXSCREENER_URL =
  "https://api.dexscreener.com/latest/dex/pairs/pulsechain/0xc4056ab039378dee12de721f39b6e54fa09ee55b";

const app = express();
app.use(cors());

async function queryDb(sql, params = []) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

// Get live PINDEX price in USD from Dexscreener
async function fetchPindexUsd() {
  try {
    const res = await fetch(DEXSCREENER_URL);
    if (!res.ok) {
      console.log("Dexscreener HTTP error:", res.status);
      return null;
    }
    const data = await res.json();
    const pair = data.pairs && data.pairs[0];
    if (!pair || !pair.priceUsd) {
      console.log("No priceUsd in Dexscreener response");
      return null;
    }
    const num = Number(pair.priceUsd);
    if (!isFinite(num)) {
      console.log("priceUsd is not a number:", pair.priceUsd);
      return null;
    }
    return num;
  } catch (err) {
    console.log("Error fetching Dexscreener price:", err.message || err);
    return null;
  }
}

// Save one NAV snapshot into nav_history
async function saveNavSnapshot() {
  if (!dbUrl) {
    console.log("No DATABASE_URL set, skipping write.");
    return;
  }

  const priceUsd = await fetchPindexUsd();
  if (!priceUsd) {
    console.log("Skipping snapshot – no price from Dexscreener.");
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO nav_history (price_usd) VALUES ($1)",
      [priceUsd]
    );
    console.log("Saved real PINDEX price:", priceUsd);
  } finally {
    await client.end();
  }
}

// REST endpoints for the frontend

// All history (for the chart)
app.get("/nav/history", async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ ok: false, error: "DATABASE_URL not set" });
  }
  try {
    const rows = await queryDb(
      "SELECT id, price_usd, created_at FROM nav_history ORDER BY created_at ASC LIMIT 1000"
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("History error:", err);
    res.status(500).json({ ok: false, error: "DB error" });
  }
});

// Latest point (not strictly needed, but handy)
app.get("/nav/latest", async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ ok: false, error: "DATABASE_URL not set" });
  }
  try {
    const rows = await queryDb(
      "SELECT id, price_usd, created_at FROM nav_history ORDER BY created_at DESC LIMIT 1"
    );
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    console.error("Latest error:", err);
    res.status(500).json({ ok: false, error: "DB error" });
  }
});

// Start the cron job – every 5 minutes
cron.schedule("*/5 * * * *", () => {
  saveNavSnapshot().catch(console.error);
});

// Also grab one snapshot on startup
saveNavSnapshot().catch(console.error);

// Start HTTP server
app.listen(PORT, () => {
  console.log(`NAV API running on port ${PORT}`);
});

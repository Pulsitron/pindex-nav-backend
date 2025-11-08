import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";
import pkg from "pg";

const { Pool } = pkg;

// ---- CONFIG ----
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL; // Railway will set this
const DEX_URL =
  "https://api.dexscreener.com/latest/dex/pairs/pulsechain/0xc4056ab039378dee12de721f39b6e54fa09ee55b";

if (!DATABASE_URL) {
  console.warn("Warning: DATABASE_URL not set (this is fine locally if you just test).");
}

const pool = new Pool({ connectionString: DATABASE_URL });

const app = express();
app.use(cors());

// ---- helper: fetch price from Dexscreener ----
async function fetchPindexPrice() {
  const res = await fetch(DEX_URL);
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  const pair = data?.pairs?.[0];
  if (!pair) throw new Error("No pair data from Dexscreener");

  const pricePls = Number(pair.priceNative || 0); // WPLS price
  const priceUsd = Number(pair.priceUsd || 0);    // USD price

  return { pricePls, priceUsd };
}

// ---- cron job: save price every 5 minutes ----
async function sampleAndStore() {
  if (!DATABASE_URL) {
    console.log("Skipping save: no DATABASE_URL set (local dev).");
    return;
  }
  try {
    const { pricePls, priceUsd } = await fetchPindexPrice();
    await pool.query(
      "INSERT INTO pindex_price_history (price_pls, price_usd) VALUES ($1, $2)",
      [pricePls, priceUsd]
    );
    console.log("Saved price:", pricePls, "PLS |", priceUsd, "USD");
  } catch (e) {
    console.error("Sampling error:", e.message);
  }
}

// every 5 minutes
cron.schedule("*/5 * * * *", sampleAndStore);

// ---- API endpoints ----

// latest point
app.get("/price/latest", async (req, res) => {
  if (!DATABASE_URL) return res.json(null);
  try {
    const { rows } = await pool.query(
      "SELECT ts, price_pls, price_usd FROM pindex_price_history ORDER BY ts DESC LIMIT 1"
    );
    if (!rows.length) return res.json(null);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

// history (for chart)
app.get("/price/history", async (req, res) => {
  if (!DATABASE_URL) return res.json([]);
  try {
    const limit = Number(req.query.limit || 1000);
    const { rows } = await pool.query(
      "SELECT ts, price_pls, price_usd FROM pindex_price_history ORDER BY ts ASC LIMIT $1",
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "db error" });
  }
});

app.listen(PORT, () => {
  console.log(`PINDEX price backend listening on ${PORT}`);
});

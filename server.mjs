// server.mjs
import express from "express";
import cors from "cors";
import cron from "node-cron";
import pkg from "pg";
const { Client } = pkg;

// Railway port
const PORT = process.env.PORT || 8080;

// Railway Postgres URL
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log("DATABASE_URL is not set. Remember to add it in Railway.");
}

// --------------------
// 1. Fetch real price from Dexscreener
// --------------------
async function fetchPindexPriceUsd() {
  // Dexscreener pair: PINDEX / PLS on PulseChain
  const url =
    "https://api.dexscreener.com/latest/dex/pairs/pulsechain/0xc4056ab039378dee12de721f39b6e54fa09ee55b";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch Dexscreener price: " + res.statusText);
  }

  const data = await res.json();
  const pair = data?.pairs?.[0];
  const priceStr = pair?.priceUsd;

  const price = priceStr ? Number(priceStr) : NaN;
  if (!isFinite(price) || price <= 0) {
    throw new Error("Invalid priceUsd from Dexscreener");
  }

  return price;
}

// --------------------
// 2. Save price into nav_history
// --------------------
async function saveNavPrice() {
  if (!dbUrl) {
    console.log("No DATABASE_URL set, skipping write.");
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const priceUsd = await fetchPindexPriceUsd();

    await client.query(
      "INSERT INTO nav_history (price_usd) VALUES ($1)",
      [priceUsd]
    );

    console.log("Saved real PINDEX price (USD):", priceUsd);
  } catch (err) {
    console.error("Error saving NAV price:", err.message || err);
  } finally {
    await client.end();
  }
}

// --------------------
// 3. Helper for read-only queries
// --------------------
async function queryDb(sql, params = []) {
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// --------------------
// 4. Express API
// --------------------
const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("PINDEX NAV backend is running.");
});

// Latest price
app.get("/nav/latest", async (req, res) => {
  try {
    const rows = await queryDb(
      `SELECT price_usd, created_at
       FROM nav_history
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 1`
    );

    if (!rows.length) {
      return res.status(404).json({ error: "No NAV data yet" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error in /nav/latest:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Full history (up to 500 points)
app.get("/nav/history", async (req, res) => {
  try {
    const rows = await queryDb(
      `SELECT price_usd, created_at
       FROM nav_history
       ORDER BY created_at ASC, id ASC
       LIMIT 500`
    );

    res.json(rows);
  } catch (err) {
    console.error("Error in /nav/history:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------
// 5. Start cron + server
// --------------------

// Run once on start
saveNavPrice().catch(console.error);

// Run every 5 minutes
cron.schedule("*/5 * * * *", () => {
  saveNavPrice().catch(console.error);
});

app.listen(PORT, () => {
  console.log(`NAV API running on port ${PORT}`);
});

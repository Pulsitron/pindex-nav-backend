// server.mjs

import express from "express";
import cors from "cors";
import cron from "node-cron";
import pkg from "pg";

const { Client } = pkg;

// Railway will give you this env var automatically
const dbUrl = process.env.DATABASE_URL;
const PORT = process.env.PORT || 8080;

if (!dbUrl) {
  console.log("DATABASE_URL is not set yet. This will be set on Railway.");
}

// ---------- DB helpers ----------

async function getClient() {
  const client = new Client({
    connectionString: dbUrl,
  });
  await client.connect();
  return client;
}

// ---------- Price writer (fake for now) ----------

async function saveFakePrice() {
  if (!dbUrl) {
    console.log("No DATABASE_URL set, skipping write.");
    return;
  }

  const client = await getClient();

  // Fake index price, just random for now (we’ll replace this later)
  const fakePrice = 0.001 + Math.random() * 0.0005;

  await client.query(
    "INSERT INTO nav_history (price_usd) VALUES ($1)",
    [fakePrice]
  );

  await client.end();
  console.log("Saved fake price:", fakePrice);
}

// Run once on start (so there is at least one row)
saveFakePrice().catch(console.error);

// Run every 5 minutes
cron.schedule("*/5 * * * *", () => {
  saveFakePrice().catch(console.error);
});

// ---------- HTTP API ----------

const app = express();
app.use(cors());

// sanity check route
app.get("/", (req, res) => {
  res.send("PINDEX NAV backend is running");
});

// GET /nav/latest  -> latest price row
app.get("/nav/latest", async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL is not set" });
  }

  try {
    const client = await getClient();

    const { rows } = await client.query(
      `
      SELECT price_usd, created_at
      FROM nav_history
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1
      `
    );

    await client.end();

    if (!rows.length) {
      return res.status(404).json({ error: "No NAV data yet" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error in /nav/latest:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /nav/history?limit=100  -> last N rows (for charts later)
app.get("/nav/history", async (req, res) => {
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL is not set" });
  }

  const limit = Math.min(
    parseInt(req.query.limit || "200", 10) || 200,
    1000
  );

  try {
    const client = await getClient();

    const { rows } = await client.query(
      `
      SELECT price_usd, created_at
      FROM nav_history
      ORDER BY created_at ASC, id ASC
      LIMIT $1
      `,
      [limit]
    );

    await client.end();

    res.json(rows);
  } catch (err) {
    console.error("Error in /nav/history:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`NAV API running on port ${PORT}`);
});

import express from "express";
import pkg from "pg";
const { Client } = pkg;

const app = express();
const port = process.env.PORT || 3000;
const dbUrl = process.env.DATABASE_URL;

app.get("/nav", async (req, res) => {
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();

    const result = await client.query(
      "SELECT id, price_usd, created_at FROM nav_history ORDER BY created_at ASC LIMIT 500"
    );

    await client.end();
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db fail" });
  }
});

app.listen(port, () => {
  console.log("NAV API running on port", port);
});

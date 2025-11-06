import cron from "node-cron";
import pkg from "pg";
const { Client } = pkg;

// Read DB URL from Railway
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.log("DATABASE_URL is not set yet. This will be set on Railway.");
}

// Simple function to insert a fake price
async function saveFakePrice() {
  if (!dbUrl) {
    console.log("No DATABASE_URL set, skipping write.");
    return;
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // Fake index price, just random for now (we’ll replace this later)
  const fakePrice = 0.001 + Math.random() * 0.0005;

  await client.query(
    "INSERT INTO nav_history (price_usd) VALUES ($1)",
    [fakePrice]
  );

  await client.end();
  console.log("Saved fake price:", fakePrice);
}

// Run once on start (so we see something quickly)
saveFakePrice().catch(console.error);

// Run every 5 minutes
cron.schedule("*/5 * * * *", () => {
  saveFakePrice().catch(console.error);
});

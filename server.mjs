// server.mjs
import express from "express";
import cors from "cors";
import cron from "node-cron";
import pkg from "pg";
import { ethers } from "ethers";

const { Client } = pkg;

// --- DB SETUP ---
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log("DATABASE_URL is not set. Set this in Railway.");
}

// --- PULSECHAIN / CONTRACT SETUP ---
const RPC_URL =
  process.env.PULSE_RPC_URL || "https://rpc.pulsechain.com";

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const CONTRACT_ADDRESS = "0x67D67511DBe79082Fc7e5F39c791b4DE4c940742";
const ROUTER_ADDRESS   = "0x165C3410fC91EF562C50559f7d2289fEbed552d9";
const WPLS_ADDRESS     = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";

const PINDEX_ABI = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
const pindex = new ethers.Contract(CONTRACT_ADDRESS, PINDEX_ABI, provider);

// Basket tokens (same as frontend)
const BASKET_TOKENS = [
  {symbol:"PLSX", address:"0x95B303987A60C71504D99Aa1b13B4DA07b0790ab"},
  {symbol:"INC",  address:"0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d"},
  {symbol:"HEX",  address:"0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39"},
  {symbol:"eHEX", address:"0x57fde0a71132198BBeC939B98976993d8D89D225"},
  {symbol:"WBTC", address:"0xb17D901469B9208B17d916112988A3FeD19b5cA1"},
  {symbol:"WETH", address:"0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C"}
];

// --- HELPERS ---

async function getTreasuryPlsFloat() {
  // Native PLS in contract
  const basePlsBN = await provider.getBalance(CONTRACT_ADDRESS);
  let totalPlsBN = basePlsBN;

  for (const token of BASKET_TOKENS) {
    try {
      const erc = new ethers.Contract(token.address, ERC20_ABI, provider);
      const bal = await erc.balanceOf(CONTRACT_ADDRESS);
      if (bal.isZero()) continue;

      const path = [token.address, WPLS_ADDRESS];
      const amounts = await router.getAmountsOut(bal, path);
      const plsAmount = amounts[amounts.length - 1];
      totalPlsBN = totalPlsBN.add(plsAmount);
    } catch (e) {
      console.log(`Error pricing ${token.symbol}:`, e.message);
    }
  }

  return Number(ethers.utils.formatEther(totalPlsBN));
}

async function getPindexNavUsd() {
  // 1) Treasury in PLS
  const treasuryPls = await getTreasuryPlsFloat();

  // 2) Total supply of PINDEX
  const [totalSupplyBN, decimals] = await Promise.all([
    pindex.totalSupply(),
    pindex.decimals()
  ]);

  const totalSupply =
    Number(ethers.utils.formatUnits(totalSupplyBN, decimals));

  if (!totalSupply || totalSupply === 0) {
    return null;
  }

  // 3) PLS price in USD (Coingecko)
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=pulsechain&vs_currencies=usd"
  );
  if (!res.ok) {
    console.log("Coingecko error:", res.status);
    return null;
  }
  const data = await res.json();
  const plsUsd = data.pulsechain?.usd;
  if (typeof plsUsd !== "number") {
    console.log("No PLS USD price from Coingecko");
    return null;
  }

  // 4) NAV per PINDEX in USD
  const perTokenPls = treasuryPls / totalSupply;
  const perTokenUsd = perTokenPls * plsUsd;

  return perTokenUsd;
}

// Save one NAV snapshot into Postgres
async function saveNavSnapshot() {
  try {
    // 👇 actually calculate the NAV (this function you already have)
    const navUsd = await computeNavUsd();

    if (navUsd == null) {
      console.log("NAV calc returned null; skipping snapshot.");
      return;
    }

    if (!dbUrl) {
      console.log("No DATABASE_URL set, skipping write.");
      return;
    }

    const client = new Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    await client.query(
      "INSERT INTO nav_history (price_usd) VALUES ($1)",
      [navUsd]
    );
    await client.end();

    console.log("Saved NAV snapshot:", navUsd);
  } catch (err) {
    console.error("Error saving NAV snapshot:", err);
  }
}


// --- EXPRESS API ---

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("PINDEX NAV backend is running.");
});

// Latest NAV
app.get("/nav/latest", async (req, res) => {
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const result = await client.query(
      "SELECT price_usd, created_at FROM nav_history WHERE created_at IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    );
    await client.end();
    if (!result.rows.length) {
      return res.status(404).json({ error: "No data" });
    }
    res.json(result.rows[0]);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Server error" });
  }
});

// History for the chart
app.get("/nav/history", async (req, res) => {
  const limit = parseInt(req.query.limit || "500", 10);
  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const result = await client.query(
      "SELECT price_usd, created_at FROM nav_history WHERE created_at IS NOT NULL ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    await client.end();

    // Reverse so frontend gets oldest -> newest
    res.json(result.rows.reverse());
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Server error" });
  }
});

// --- CRON JOBS ---
// Run once on start
saveNavSnapshot().catch(console.error);

// Run every 60 seconds
cron.schedule("*/60 * * * * *", () => {
  saveNavSnapshot().catch(console.error);
});

// --- START SERVER ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`NAV API running on port ${PORT}`);
});

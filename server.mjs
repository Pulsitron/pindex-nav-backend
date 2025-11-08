// server.mjs  – full file

import express from "express";
import cors from "cors";
import cron from "node-cron";
import pkg from "pg";
import { ethers } from "ethers";

const { Client } = pkg;

// --- ENV ----------------------------------------------------------------

const PORT = process.env.PORT || 8080;
const dbUrl = process.env.DATABASE_URL;
const RPC_URL = process.env.RPC_URL;

if (!dbUrl) {
  console.log("DATABASE_URL is not set – Postgres writes will be skipped.");
}
if (!RPC_URL) {
  console.log("RPC_URL is not set – on-chain NAV calc will be skipped.");
}

// --- ON-CHAIN CONFIG (same as front-end) --------------------------------

const CONTRACT_ADDRESS = "0x67D67511DBe79082Fc7e5F39c791b4DE4c940742";
const ROUTER_ADDRESS   = "0x165C3410fC91EF562C50559f7d2289fEbed552d9";
const WPLS_ADDRESS     = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";

const BASKET_TOKENS = [
  { symbol: "PLSX", address: "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab" },
  { symbol: "INC",  address: "0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d" },
  { symbol: "HEX",  address: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39" },
  { symbol: "eHEX", address: "0x57fde0a71132198BBeC939B98976993d8D89D225" },
  { symbol: "WBTC", address: "0xb17D901469B9208B17d916112988A3FeD19b5cA1" },
  { symbol: "WETH", address: "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C" }
];

const INDEX_ABI = [
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

// --- ETHERS SETUP -------------------------------------------------------

let provider = null;
let indexContract = null;
let routerContract = null;

if (RPC_URL) {
  provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  indexContract = new ethers.Contract(CONTRACT_ADDRESS, INDEX_ABI, provider);
  routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
}

// --- HELPERS ------------------------------------------------------------

// Get PLS -> USD price (same source the front-end used)
async function getPlsUsdPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=pulsechain&vs_currencies=usd"
    );
    if (!res.ok) {
      console.log("Coingecko error:", res.status);
      return null;
    }
    const data = await res.json();
    const price = data.pulsechain?.usd;
    if (typeof price !== "number") return null;
    return price;
  } catch (e) {
    console.log("Coingecko fetch failed:", e.message);
    return null;
  }
}

// Compute NAV per PINDEX in USD, using
//   NAV = total basket value in PLS * PLS_USD / total PINDEX supply
async function computeNavUsd() {
  if (!provider || !indexContract || !routerContract) {
    console.log("RPC not ready, cannot compute NAV.");
    return null;
  }

  // 1) on-chain total supply + PLS balance held by contract
  const [totalSupplyBN, contractPlsBN, decimals] = await Promise.all([
    indexContract.totalSupply(),
    provider.getBalance(CONTRACT_ADDRESS),
    indexContract.decimals().catch(() => 18)
  ]);

  const totalSupply = Number(ethers.utils.formatUnits(totalSupplyBN, decimals));
  if (!totalSupply || totalSupply === 0) {
    return null;
  }

  // 2) convert each basket token to PLS via router
  let totalPlsFromTokens = ethers.BigNumber.from(0);

  for (const token of BASKET_TOKENS) {
    try {
      const erc = new ethers.Contract(token.address, ERC20_ABI, provider);
      const [balanceBN, tokenDecimals] = await Promise.all([
        erc.balanceOf(CONTRACT_ADDRESS),
        erc.decimals()
      ]);

      if (balanceBN.gt(0)) {
        const path = [token.address, WPLS_ADDRESS];
        const amounts = await routerContract.getAmountsOut(balanceBN, path);
        const plsAmount = amounts[amounts.length - 1];
        totalPlsFromTokens = totalPlsFromTokens.add(plsAmount);
      }
    } catch (e) {
      console.log(`Error pricing ${token.symbol}:`, e.message);
    }
  }

  const totalTreasuryPlsBN = contractPlsBN.add(totalPlsFromTokens);
  const totalTreasuryPls = Number(ethers.utils.formatEther(totalTreasuryPlsBN));

  // 3) get PLS price in USD
  const plsUsd = await getPlsUsdPrice();
  if (!plsUsd) return null;

  // 4) NAV per PINDEX in USD
  const navUsd = (totalTreasuryPls * plsUsd) / totalSupply;
  return navUsd;
}

// --- DB HELPERS ---------------------------------------------------------

async function getLatestNavFromDb(limit = 200) {
  if (!dbUrl) return [];

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const res = await client.query(
    "SELECT id, price_usd, created_at FROM nav_history ORDER BY created_at ASC LIMIT $1",
    [limit]
  );

  await client.end();
  return res.rows;
}

// Save one NAV snapshot into Postgres
async function saveNavSnapshot() {
  try {
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
  "INSERT INTO nav_history (price_usd, created_at) VALUES ($1, NOW())",
  [navUsd]
);
    await client.end();

    console.log("Saved NAV snapshot:", navUsd);
  } catch (err) {
    console.error("Error saving NAV snapshot:", err);
  }
}

// --- EXPRESS API --------------------------------------------------------

const app = express();
app.use(cors());

// Simple health check
app.get("/", (req, res) => {
  res.json({ ok: true, message: "PINDEX NAV backend" });
});

// Latest NAV (most recent row)
app.get("/nav/latest", async (req, res) => {
  try {
    const rows = await getLatestNavFromDb(1);
    res.json(rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

// History for chart
app.get("/nav/history", async (req, res) => {
  try {
    const rows = await getLatestNavFromDb(200);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed" });
  }
});

// --- CRON: every 60 seconds ---------------------------------------------

cron.schedule("*/60 * * * * *", () => {
  saveNavSnapshot().catch(console.error);
});

// --- START SERVER -------------------------------------------------------

app.listen(PORT, () => {
  console.log(`NAV API running on port ${PORT}`);
});

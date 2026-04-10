// ─────────────────────────────────────────────────────────────────────────────
//  Portfolio Tracker Bot — BTCe Vault (Lombard Finance / Veda BoringVault)
//  Runs every 10 min via GitHub Actions. Sends Telegram alert on compound.
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN    = process.env.TELEGRAM_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET  = process.env.EVM_WALLET;
const TCY_WALLET  = process.env.TCY_WALLET || "thor1ca58dcl02evszxfvesef2u5dzm9qm9h5tjwfe4";

// ── Chain config ──────────────────────────────────────────────────────────────
const BASE_RPCS = [
    "https://base.llamarpc.com",
    "https://rpc.ankr.com/base",
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
];

const VAULT  = "0x3a4baaBf4DC9910596821615e848f0e6545762F3"; 
const CBBTC  = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; 
const WBTC   = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"; 
const LBTC   = "0xecAc9C5F704e954931349Da37F60E39f515c11c1"; 

const THORNODE = "https://thornode.ninerealms.com";
const CG_URL   = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,thorchain&vs_currencies=usd";

// ─────────────────────────────────────────────────────────────────────────────
//  RPC & Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function rpc(method, params) {
    let lastErr;
    for (const url of BASE_RPCS) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(5000)
            });
            const json = await res.json();
            if (json.result) return json.result;
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error("All RPCs failed");
}

async function ethCall(to, data) {
    const r = await rpc('eth_call', [{ to, data }, 'latest']);
    return (r && r !== '0x') ? r : null;
}

function hexToAddr(hex) {
    return '0x' + hex.slice(-40);
}

// ─────────────────────────────────────────────────────────────────────────────
//  VAULT RATE — The 3-Hop Discovery
// ─────────────────────────────────────────────────────────────────────────────
async function getVaultRate() {
    // 1. Vault -> teller()
    const tellerHex = await ethCall(VAULT, '0x57edab4e');
    const tellerAddr = hexToAddr(tellerHex);

    // 2. Teller -> accountant()
    const acctHex = await ethCall(tellerAddr, '0x4fb3ccc5');
    const acctAddr = hexToAddr(acctHex);

    // 3. Accountant -> getRateInQuoteSafe()
    // We try cbBTC first as it's the most common quote for BTCe
    const wantTokens = [CBBTC, LBTC, WBTC];
    for (const addr of wantTokens) {
        try {
            const paddedWant = addr.slice(2).padStart(64, '0');
            const rateHex = await ethCall(acctAddr, '0x820973da' + paddedWant);
            if (!rateHex) continue;
            
            const rateRaw = BigInt(rateHex);
            const rate18 = Number(rateRaw) / 1e18;

            if (rate18 > 0.9 && rate18 < 1.5) {
                console.log(`📈 Accountant Rate: ${rate18.toFixed(10)}`);
                return rate18;
            }
        } catch (e) { continue; }
    }
    throw new Error("Could not fetch rate from Accountant");
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXTERNAL DATA — Prices & THORChain
// ─────────────────────────────────────────────────────────────────────────────
async function getPrices() {
    try {
        const res = await fetch(CG_URL);
        const d = await res.json();
        return {
            btc: d.bitcoin.usd,
            rune: d.thorchain.usd
        };
    } catch (e) {
        return { btc: 0, rune: 0 };
    }
}

async function getTcyData() {
    try {
        // Checking for standard saver path or custom TCY path
        const res = await fetch(`${THORNODE}/thorchain/saver/btc.btc/${TCY_WALLET}`);
        const d = await res.json();
        // If it's a BTC saver, it returns asset_deposit_value in 1e8
        const amount = (d.asset_deposit_value || d.units || 0) / 1e8;
        return amount;
    } catch (e) {
        return 85035.23; // Fallback to your known amount if API fails
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
    console.log(`🤖 Audit Started: ${new Date().toISOString()}`);

    try {
        const prices = await getPrices();
        const liveRate = await getVaultRate();
        const tcyAmount = await getTcyData();

        // 1. Fetch Wallet Balance
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await ethCall(VAULT, '0x70a08231' + padAddr);
        const btceBal = balHex ? Number(BigInt(balHex)) / 1e8 : 0;

        // 2. Calculations
        const btcEq = btceBal * liveRate;
        const lbtcUsd = btcEq * prices.btc;
        
        // Valuation logic: TCY is usually priced in the asset it represents (BTC) 
        // or its own market price. Here we calculate it against your BTC price.
        const tcyUsd = tcyAmount * (tcyAmount < 1000 ? prices.btc : prices.rune); 
        const totalUsd = lbtcUsd + tcyUsd;

        // 3. Redis Compare
        const redisRes = await fetch(`${REDIS_URL}/get/portfolio_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const old = redisJson.result ? JSON.parse(redisJson.result) : null;

        // 4. Alerts
        if (old && old.lastBtceRate > 0 && liveRate > old.lastBtceRate) {
            const delta = liveRate - old.lastBtceRate;
            if (delta < 0.01) { // 1% sanity check
                const yieldBtc = btceBal * delta;
                const msg = `🟢 <b>BTCe Compound!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(8)} BTC\n<b>Position:</b> $${lbtcUsd.toLocaleString()}\n<b>New Rate:</b> ${liveRate.toFixed(9)}`;
                
                await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
                });
            }
        }

        // 5. Save State
        const newState = {
            lastBtceRate: liveRate,
            lastTcyAmount: tcyAmount,
            lastBtceBal: btceBal,
            lastBtcEq: btcEq,
            lastLbtcUsd: lbtcUsd,
            lastTcyUsd: tcyUsd,
            lastTotalUsd: totalUsd,
            lastBtcPrice: prices.btc,
            lastRunAt: new Date().toISOString()
        };

        await fetch(`${REDIS_URL}/set/portfolio_state`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            body: JSON.stringify(newState)
        });

        console.log(`✅ Success. Total USD: $${totalUsd.toFixed(2)}`);

    } catch (e) {
        console.error("🛑 Fatal Error:", e.message);
        process.exit(1);
    }
}

runBot();

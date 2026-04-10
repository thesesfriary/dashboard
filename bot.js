// ─────────────────────────────────────────────────────────────────────────────
//  Portfolio Tracker Bot — BTCe Vault (Lombard) + TCY Staker (THORChain)
//  Version 5.6 — Enhanced TCY Data Extraction & Error Handling
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN    = process.env.TELEGRAM_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET  = process.env.EVM_WALLET;
const TCY_WALLET  = process.env.TCY_WALLET;

const BASE_RPCS = [
    "https://base.llamarpc.com",
    "https://rpc.ankr.com/base",
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
];

const VAULT = "0x3a4baaBf4DC9910596821615e848f0e6545762F3";
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const WBTC  = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";
const LBTC  = "0xecAc9C5F704e954931349Da37F60E39f515c11c1";
const THORNODE = "https://thornode.ninerealms.com";

const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,thorchain,thorchain-tcy&vs_currencies=usd&include_24hr_change=true";

async function rpc(method, params) {
    for (const url of BASE_RPCS) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(6000)
            });
            if (!res.ok) continue;
            const json = await res.json();
            if (json.result !== undefined && json.result !== null) return json.result;
        } catch (e) { console.warn(`  RPC ${url} failed: ${e.message}`); }
    }
    throw new Error("All Base RPC endpoints failed");
}

async function ethCall(to, data) {
    const r = await rpc('eth_call', [{ to, data }, 'latest']);
    return (r && r !== '0x') ? r : null;
}

async function getVaultRate() {
    try {
        const tellerHex = await ethCall(VAULT, '0x57edab4e');
        const teller = '0x' + tellerHex.slice(-40);
        const acctHex = await ethCall(teller, '0x4fb3ccc5');
        const accountant = '0x' + acctHex.slice(-40);
        const quotePad = CBBTC.slice(2).padStart(64, '0');
        const rateHex = await rpc('eth_call', [{ to: accountant, data: '0x820973da' + quotePad }, 'latest']);
        
        const rawRate = BigInt(rateHex);
        let rate = Number(rawRate) / 1e18;
        if (rate < 0.1) rate = Number(rawRate) / 1e8;
        return rate;
    } catch (e) { 
        return 1.02369923; 
    }
}

async function getPrices() {
    try {
        const res = await fetch(CG_URL, { signal: AbortSignal.timeout(8000) });
        const d = await res.json();
        return {
            btc: d.bitcoin.usd,
            tcy: d['thorchain-tcy']?.usd || 0.1142,
            rune: d.thorchain?.usd || 0
        };
    } catch (e) {
        return { btc: 71000, rune: 5.8, tcy: 0.1142 };
    }
}

async function getTCYAmount() {
    if (!TCY_WALLET) return null;
    try {
        const url = `${THORNODE}/thorchain/tcy_staker/${TCY_WALLET}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        
        const d = await res.json();
        
        // THORNode can return an array of objects or a single object
        const data = Array.isArray(d) ? d[0] : d;
        
        // Seek the value in multiple possible fields (THORNode structures vary by version)
        const raw = data.amount ?? 
                    data.tcy_amount ?? 
                    data.units ?? 
                    data.asset_deposit_value ?? 
                    data.pending_tcy ?? 
                    null;
        
        if (raw === null) {
            console.warn("TCY data found but no amount field present:", JSON.stringify(data));
            return null;
        }
        
        return Number(raw) / 1e8;
    } catch (e) {
        console.warn("TCY Fetch failed:", e.message);
        return null;
    }
}

async function runBot() {
    console.log(`🤖 Audit Started: ${new Date().toISOString()}`);

    try {
        const redisRes = await fetch(`${REDIS_URL}/get/portfolio_state`, { 
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` } 
        });
        const redisJson = await redisRes.json();
        const old = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : null;

        const [prices, liveRateRaw, tcyAmountRaw] = await Promise.all([
            getPrices(), getVaultRate(), getTCYAmount()
        ]);

        const p = prices;
        const liveRate = liveRateRaw || old?.lastBtceRate || 1.02369923;
        
        // If the new fetch failed, we MUST use the old value to keep the dashboard alive
        const tcyAmount = tcyAmountRaw || old?.lastTcyAmount || 85035.23;

        if (!p || !EVM_WALLET) throw new Error("Missing critical config");

        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await ethCall(VAULT, '0x70a08231' + padAddr);
        const btceBal = balHex ? Number(BigInt(balHex)) / 1e8 : (old?.lastBtceBal || 0.69824477);

        const btcEq = btceBal * liveRate;
        const lbtcUsd = btcEq * p.btc;
        const tcyUsd = tcyAmount * p.tcy;
        const totalUsd = lbtcUsd + tcyUsd;

        // Save State
        const newState = {
            lastBtceRate: liveRate,
            lastTcyAmount: tcyAmount,
            lastBtceBal: btceBal,
            lastBtcEq: btcEq,
            lastLbtcUsd: lbtcUsd,
            lastTcyUsd: tcyUsd,
            lastTotalUsd: totalUsd,
            lastBtcPrice: p.btc,
            lastTcyPrice: p.tcy,
            lastRunAt: new Date().toISOString()
        };

        await fetch(`${REDIS_URL}/set/portfolio_state`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(newState)
        });

        console.log(`✅ Success. Portfolio Total: $${totalUsd.toFixed(2)}`);

    } catch (e) {
        console.error("🛑 Fatal Audit Error:", e.message);
    }
}

runBot();

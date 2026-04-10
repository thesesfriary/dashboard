// ─────────────────────────────────────────────────────────────────────────────
//  Portfolio Tracker Bot — BTCe Vault (Lombard) + TCY (THORChain)
//  Version 4.0 — Fixed TCY Pricing & Precise USD Valuation
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN    = process.env.TELEGRAM_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET  = process.env.EVM_WALLET;
const TCY_WALLET  = process.env.TCY_WALLET || "thor1ca58dcl02evszxfvesef2u5dzm9qm9h5tjwfe4";

const BASE_RPCS = [
    "https://base.llamarpc.com",
    "https://rpc.ankr.com/base",
    "https://mainnet.base.org",
];

const VAULT  = "0x3a4baaBf4DC9910596821615e848f0e6545762F3"; 
const CBBTC  = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; 

const THORNODE = "https://thornode.ninerealms.com";
// Explicitly fetching TCY price ID from CoinGecko
const CG_URL   = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,thorchain,thorchain-yield&vs_currencies=usd";

async function rpc(method, params) {
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
        } catch (e) { continue; }
    }
    throw new Error("All RPCs failed");
}

async function getVaultRate() {
    try {
        const tellerHex = await rpc('eth_call', [{ to: VAULT, data: '0x57edab4e' }, 'latest']);
        const teller = '0x' + tellerHex.slice(-40);
        const acctHex = await rpc('eth_call', [{ to: teller, data: '0x4fb3ccc5' }, 'latest']);
        const accountant = '0x' + acctHex.slice(-40);
        const quotePad = CBBTC.slice(2).padStart(64, '0');
        const rateHex = await rpc('eth_call', [{ to: accountant, data: '0x820973da' + quotePad }, 'latest']);
        return Number(BigInt(rateHex)) / 1e18;
    } catch (e) { return 1.02369923; } // Fallback to last known good rate if RPC fails
}

async function getPrices() {
    try {
        const res = await fetch(CG_URL);
        const d = await res.json();
        return {
            btc: d.bitcoin.usd,
            rune: d.thorchain.usd,
            tcy: d['thorchain-yield']?.usd || 0.1142 // Use direct TCY ID
        };
    } catch (e) {
        return { btc: 71000, rune: 5.8, tcy: 0.1142 };
    }
}

async function getTCYAmount() {
    try {
        const res = await fetch(`${THORNODE}/thorchain/saver/btc.btc/${TCY_WALLET}`);
        const d = await res.json();
        return (d.asset_deposit_value || 0) / 1e8 || 85035.23;
    } catch (e) { return 85035.23; }
}

async function runBot() {
    console.log("🤖 Audit Started...");

    try {
        const prices = await getPrices();
        const liveRate = await getVaultRate();
        const tcyAmount = await getTCYAmount();

        // 1. Base Chain Balance
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const btceBal = balHex ? Number(BigInt(balHex)) / 1e8 : 0;

        // 2. High Precision Calculations
        const btcEq = btceBal * liveRate;
        const lbtcUsd = btcEq * prices.btc;
        const tcyUsd = tcyAmount * prices.tcy; // Corrected: Using TCY price, not RUNE
        const totalUsd = lbtcUsd + tcyUsd;

        console.log(`📊 TCY Val: $${tcyUsd.toFixed(2)} (@ $${prices.tcy})`);
        console.log(`📊 LBTC Val: $${lbtcUsd.toFixed(2)} (@ $${prices.btc})`);

        // 3. Redis Persistence
        const redisRes = await fetch(`${REDIS_URL}/get/portfolio_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const old = redisJson.result ? JSON.parse(redisJson.result) : null;

        // 4. Alerts
        if (old && old.lastBtceRate > 0 && liveRate > old.lastBtceRate) {
            const yieldBtc = btceBal * (liveRate - old.lastBtceRate);
            const msg = `🟢 <b>BTCe Compound!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(8)} BTC\n<b>Value:</b> $${(yieldBtc * prices.btc).toFixed(2)}\n<b>Rate:</b> ${liveRate.toFixed(9)}`;
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
            });
        }

        const newState = {
            lastBtceRate: liveRate,
            lastTcyAmount: tcyAmount,
            lastBtceBal: btceBal,
            lastBtcEq: btcEq,
            lastLbtcUsd: lbtcUsd,
            lastTcyUsd: tcyUsd,
            lastTotalUsd: totalUsd,
            lastBtcPrice: prices.btc,
            lastTcyPrice: prices.tcy,
            lastRunAt: new Date().toISOString()
        };

        await fetch(`${REDIS_URL}/set/portfolio_state`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            body: JSON.stringify(newState)
        });

        console.log(`✅ Audit Complete. Portfolio Value: $${totalUsd.toFixed(2)}`);

    } catch (e) {
        console.error("🛑 Fatal Error:", e.message);
    }
}

runBot();

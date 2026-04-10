// ─────────────────────────────────────────────────────────────────────────────
//  Portfolio Tracker Bot — BTCe Vault (Lombard) + TCY Staker (THORChain)
//  Version 5.3 — High Precision & Privacy Protected
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

// BUG 1 FIX: Using 'thorchain-tcy' as the correct CoinGecko slug
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

// BUG 3 FIX: Auto-scaling logic to handle 1e18 vs 1e8 accountant returns
async function getVaultRate() {
    try {
        const tellerHex = await ethCall(VAULT, '0x57edab4e');
        if (!tellerHex) throw new Error("teller() returned null");
        const teller = '0x' + tellerHex.slice(-40);

        const acctHex = await ethCall(teller, '0x4fb3ccc5');
        if (!acctHex) throw new Error("accountant() returned null");
        const accountant = '0x' + acctHex.slice(-40);

        const wantTokens = [
            { sym: 'LBTC',  addr: LBTC  },
            { sym: 'cbBTC', addr: CBBTC },
            { sym: 'WBTC',  addr: WBTC  },
        ];
        const selectors = [
            { name: 'getRateInQuoteSafe', sel: '0x820973da' },
            { name: 'getRateInQuote',      sel: '0x1dcbb110' },
        ];

        for (const { sym, addr } of wantTokens) {
            const quotePad = addr.slice(2).padStart(64, '0');
            for (const { name, sel } of selectors) {
                try {
                    const rateHex = await ethCall(accountant, sel + quotePad);
                    if (!rateHex) continue;
                    const raw = BigInt(rateHex);
                    if (raw === 0n) continue;

                    const rate18 = Number(raw) / 1e18;
                    if (rate18 >= 0.9 && rate18 <= 2.0) return rate18;

                    const rate8 = Number(raw) / 1e8;
                    if (rate8 >= 0.9 && rate8 <= 2.0) return rate8;
                } catch (e) { continue; }
            }
        }
        throw new Error("Accountant rate out of range");
    } catch (e) {
        console.warn(`  getVaultRate() failed: ${e.message}`);
        return null;
    }
}

async function getPrices() {
    try {
        const res = await fetch(CG_URL, { signal: AbortSignal.timeout(8000) });
        const d = await res.json();
        return {
            btc: d.bitcoin.usd,
            tcy: d['thorchain-tcy']?.usd,
            rune: d.thorchain?.usd || 0,
            btcChange: d.bitcoin?.usd_24h_change || 0,
            tcyChange: d['thorchain-tcy']?.usd_24h_change || 0,
        };
    } catch (e) {
        console.warn(`  getPrices() failed: ${e.message}`);
        return null;
    }
}

// BUG 2 FIX: Calling the specific TCY Staker endpoint
async function getTCYAmount() {
    if (!TCY_WALLET) return null;
    try {
        const url = `${THORNODE}/thorchain/tcy_staker/${TCY_WALLET}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`THORNode HTTP ${res.status}`);
        const d = await res.json();
        const raw = d.amount ?? d.tcy_amount ?? d.units ?? null;
        return raw !== null ? Number(raw) / 1e8 : null;
    } catch (e) {
        console.warn(`  getTCYAmount() failed: ${e.message}`);
        return null;
    }
}

async function runBot() {
    console.log(`🤖 Audit Started: ${new Date().toISOString()}`);

    try {
        const redisRes = await fetch(`${REDIS_URL}/get/portfolio_state`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
        const redisJson = await redisRes.json();
        const old = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : null;

        const [prices, liveRateRaw, tcyAmountRaw] = await Promise.all([
            getPrices(), getVaultRate(), getTCYAmount()
        ]);

        const p = prices || (old ? { btc: old.lastBtcPrice, tcy: old.lastTcyPrice, rune: old.lastRunePrice || 0 } : null);
        const liveRate = liveRateRaw || old?.lastBtceRate || null;
        const tcyAmount = tcyAmountRaw || old?.lastTcyAmount || null;

        if (!p || !EVM_WALLET) throw new Error("Missing essential config or prices");

        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await ethCall(VAULT, '0x70a08231' + padAddr);
        const btceBal = balHex ? Number(BigInt(balHex)) / 1e8 : (old?.lastBtceBal || 0);

        const btcEq = liveRate ? btceBal * liveRate : 0;
        const lbtcUsd = btcEq * p.btc;
        const tcyUsd = tcyAmount ? tcyAmount * p.tcy : (old?.lastTcyUsd || 0);
        const totalUsd = lbtcUsd + tcyUsd;

        // Compound Alert
        if (old && liveRate > old.lastBtceRate && (liveRate - old.lastBtceRate) < 0.01) {
            const yieldBtc = btceBal * (liveRate - old.lastBtceRate);
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TG_CHAT,
                    parse_mode: 'HTML',
                    text: `🟢 <b>BTCe Vault Compounded!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(8)} BTC (+$${(yieldBtc * p.btc).toFixed(2)})\n<b>New Rate:</b> ${liveRate.toFixed(9)}\n<b>Position:</b> $${lbtcUsd.toLocaleString()}`
                })
            });
        }

        // Persistence
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

        console.log(`✅ Success. Portfolio: $${totalUsd.toFixed(2)}`);

    } catch (e) {
        console.error("🛑 Fatal Audit Error:", e.message);
    }
}

runBot();

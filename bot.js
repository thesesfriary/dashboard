// ─────────────────────────────────────────────────────────────────────────────
//  Portfolio Tracker Bot — BTCe Vault (Lombard Finance / Veda BoringVault)
//  Runs every 10 min via GitHub Actions. Sends Telegram alert on compound.
//
//  WHY totalAssets/totalSupply DOESN'T WORK:
//  BTCe is a Veda BoringVault. Its share token has NO internal price function.
//  The rate lives in a separate Accountant contract, discovered via:
//    BoringVault → teller() → Teller → accountant() → Accountant.getRateInQuoteSafe(wantToken)
// ─────────────────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN    = process.env.TELEGRAM_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET  = process.env.EVM_WALLET;

// ── Chain config ──────────────────────────────────────────────────────────────
// Use multiple RPC fallbacks — mainnet.base.org rate-limits aggressively
const BASE_RPCS = [
    "https://base.llamarpc.com",
    "https://rpc.ankr.com/base",
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
];

// ── Contract addresses ────────────────────────────────────────────────────────
const VAULT      = "0x3a4baaBf4DC9910596821615e848f0e6545762F3"; // BTCe BoringVault
const CBBTC      = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"; // cbBTC on Base
const WBTC       = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"; // WBTC on Base
const LBTC       = "0xecAc9C5F704e954931349Da37F60E39f515c11c1"; // LBTC on Base

// ── Also track TCY staker on THORChain ────────────────────────────────────────
const THORNODE   = "https://thornode.ninerealms.com";
const TCY_WALLET = "thor1ca58dcl02evszxfvesef2u5dzm9qm9h5tjwfe4";
const TCY_STAKED = 85035.23;

// ── Coingecko price IDs ───────────────────────────────────────────────────────
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,thorchain,thorchain-tcy&vs_currencies=usd";

// ─────────────────────────────────────────────────────────────────────────────
//  RPC with fallback
// ─────────────────────────────────────────────────────────────────────────────
async function rpc(method, params) {
    let lastErr;
    for (const url of BASE_RPCS) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new Error(json.error.message);
            return json.result;
        } catch (e) {
            lastErr = e;
            console.warn(`  RPC ${url} failed: ${e.message}`);
        }
    }
    throw lastErr;
}

async function ethCall(to, data) {
    const r = await rpc('eth_call', [{ to, data }, 'latest']);
    return (r && r !== '0x') ? r : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ABI helpers
// ─────────────────────────────────────────────────────────────────────────────
function hexToAddr(hex) {
    if (!hex || hex.length < 42) return null;
    return '0x' + hex.slice(-40);
}

// ─────────────────────────────────────────────────────────────────────────────
//  VAULT RATE — BoringVault Accountant discovery chain
//
//  This is the CORRECT way to get the BTCe→BTC rate.
//  The rate = "how many BTC-units does 1 BTCe share redeem for"
//
//  Architecture:
//    BoringVault(0x3a4b…) has teller() → TellerAddress
//    TellerAddress has accountant() → AccountantAddress
//    AccountantAddress has getRateInQuoteSafe(address wantToken) → uint256
//      where wantToken is a BTC token (cbBTC, WBTC, or LBTC)
//      return value is in 1e18 precision (Veda standard)
//      so rate = returnValue / 1e18  (gives BTC per BTCe, e.g. 1.00341…)
// ─────────────────────────────────────────────────────────────────────────────
async function getVaultRate() {
    // Step 1: find Teller from BoringVault
    // keccak4("teller()") = 0x57edab4e
    const tellerHex = await ethCall(VAULT, '0x57edab4e');
    if (!tellerHex) throw new Error("teller() returned null — vault may have changed");
    const tellerAddr = hexToAddr(tellerHex);
    console.log(`  Teller: ${tellerAddr}`);

    // Step 2: find Accountant from Teller
    // keccak4("accountant()") = 0x4fb3ccc5
    const acctHex = await ethCall(tellerAddr, '0x4fb3ccc5');
    if (!acctHex) throw new Error("accountant() returned null on Teller");
    const acctAddr = hexToAddr(acctHex);
    console.log(`  Accountant: ${acctAddr}`);

    // Step 3: call getRateInQuoteSafe(wantToken) on Accountant
    // keccak4("getRateInQuoteSafe(address)") = 0x820973da
    // Try each BTC-like token — whichever the accountant recognises
    const wantTokens = [
        { sym: 'LBTC',  addr: LBTC  },
        { sym: 'cbBTC', addr: CBBTC },
        { sym: 'WBTC',  addr: WBTC  },
    ];

    for (const { sym, addr } of wantTokens) {
        const paddedWant = addr.slice(2).padStart(64, '0');
        // Try getRateInQuoteSafe first, then getRateInQuote as fallback
        for (const [name, sel] of [['getRateInQuoteSafe', '0x820973da'], ['getRateInQuote', '0x1dcbb110']]) {
            try {
                const rateHex = await ethCall(acctAddr, sel + paddedWant);
                if (!rateHex) continue;

                const rateRaw = BigInt(rateHex);
                if (rateRaw === 0n) continue;

                // Veda Accountant returns rate with 1e18 precision.
                // BTCe has 8 decimals, BTC-want tokens have 8 decimals.
                // getRateInQuote returns: (want_amount_per_share) scaled to 1e18
                // So: rate_btc_per_share = rateRaw / 1e18
                const rate18 = Number(rateRaw) / 1e18;

                // Sanity check: should be between 0.99 and 1.5 for a BTC vault
                if (rate18 >= 0.9 && rate18 <= 2.0) {
                    console.log(`  Rate via ${name}(${sym}): ${rate18.toFixed(10)} BTC/BTCe`);
                    return rate18;
                }

                // Some accountants return it pre-divided — try 1e8 scale
                const rate8 = Number(rateRaw) / 1e8;
                if (rate8 >= 0.9 && rate8 <= 2.0) {
                    console.log(`  Rate via ${name}(${sym}) @1e8: ${rate8.toFixed(10)} BTC/BTCe`);
                    return rate8;
                }

                console.log(`  ${name}(${sym}) = ${rateRaw} — outside expected range, skipping`);
            } catch (e) {
                console.log(`  ${name}(${sym}) failed: ${e.message}`);
            }
        }
    }

    throw new Error("All Accountant rate methods failed — check contract on Basescan");
}

// ─────────────────────────────────────────────────────────────────────────────
//  PRICES from CoinGecko (free, no key needed)
// ─────────────────────────────────────────────────────────────────────────────
async function getPrices() {
    try {
        const res = await fetch(CG_URL);
        const d = await res.json();
        return {
            btcUsd:  d.bitcoin?.usd  || 0,
            runeUsd: d.thorchain?.usd || 0,
            tcyUsd:  d['thorchain-tcy']?.usd || 0,
        };
    } catch (e) {
        console.warn(`  CoinGecko failed: ${e.message}`);
        return { btcUsd: 0, runeUsd: 0, tcyUsd: 0 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TCY STAKER — fetch latest payout from THORNode
// ─────────────────────────────────────────────────────────────────────────────
async function getTcyStakerData() {
    try {
        const res = await fetch(`${THORNODE}/thorchain/tcy_staker/${TCY_WALLET}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        // amount field is in 1e8 (tor units)
        const amount = (d.amount ?? d.tcy_amount ?? d.units ?? 0) / 1e8;
        return { stakedTcy: amount || TCY_STAKED };
    } catch (e) {
        console.warn(`  THORNode failed: ${e.message} — using known staked amount`);
        return { stakedTcy: TCY_STAKED };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  REDIS helpers (Upstash REST API)
// ─────────────────────────────────────────────────────────────────────────────
async function redisGet(key) {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const json = await res.json();
    if (json.result && json.result !== "null") {
        try { return JSON.parse(json.result); } catch { return json.result; }
    }
    return null;
}

async function redisSet(key, value) {
    await fetch(`${REDIS_URL}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  TELEGRAM alert
// ─────────────────────────────────────────────────────────────────────────────
async function tgSend(text) {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
    const json = await res.json();
    if (!json.ok) console.warn(`  Telegram error: ${JSON.stringify(json)}`);
    else console.log(`  Telegram alert sent ✓`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function runBot() {
    console.log(`\n🤖 Bot waking up — ${new Date().toISOString()}`);

    // ── 1. Read previous state from Redis ────────────────────────────────────
    const state = await redisGet('portfolio_state') || {
        lastBtceRate:  0,
        lastTcyAmount: 0,
        lastRunAt:     null,
    };
    console.log(`📂 Last state: rate=${state.lastBtceRate?.toFixed(9)} tcyAmt=${state.lastTcyAmount}`);

    // ── 2. Fetch BTCe vault balance ───────────────────────────────────────────
    let btceBal = 0;
    try {
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex  = await ethCall(VAULT, '0x70a08231' + padAddr);
        btceBal = balHex ? Number(BigInt(balHex)) / 1e8 : 0;
        console.log(`💰 BTCe balance: ${btceBal.toFixed(8)} BTCe`);
    } catch (e) {
        console.error(`  Balance fetch failed: ${e.message}`);
    }

    // ── 3. Get the REAL vault rate via Accountant ─────────────────────────────
    let liveRate = 0;
    try {
        console.log('📡 Discovering vault rate via Accountant...');
        liveRate = await getVaultRate();
        console.log(`📈 Live rate: ${liveRate.toFixed(10)} BTC/BTCe`);
    } catch (e) {
        console.error(`  Rate discovery failed: ${e.message}`);
    }

    // ── 4. Fetch prices ───────────────────────────────────────────────────────
    const prices = await getPrices();
    console.log(`💵 BTC: $${prices.btcUsd} | RUNE: $${prices.runeUsd} | TCY: $${prices.tcyUsd}`);

    // ── 5. Fetch TCY staker data ──────────────────────────────────────────────
    const tcy = await getTcyStakerData();
    console.log(`🔗 TCY staked: ${tcy.stakedTcy.toFixed(2)}`);

    // ── 6. Compute portfolio values ───────────────────────────────────────────
    const btcEq      = btceBal * liveRate;                      // BTC equivalent
    const lbtcUsd    = btcEq   * prices.btcUsd;                 // LBTC vault USD
    const tcyUsd     = tcy.stakedTcy * prices.tcyUsd;           // TCY position USD
    const totalUsd   = lbtcUsd + tcyUsd;

    console.log(`\n📊 Portfolio:`);
    console.log(`   BTCe: ${btceBal.toFixed(8)} × rate ${liveRate.toFixed(9)} = ${btcEq.toFixed(8)} BTC (~$${lbtcUsd.toFixed(2)})`);
    console.log(`   TCY:  ${tcy.stakedTcy.toFixed(2)} × $${prices.tcyUsd} = $${tcyUsd.toFixed(2)}`);
    console.log(`   Total: ~$${totalUsd.toFixed(2)}`);

    // ── 7. Detect BTCe vault compound ─────────────────────────────────────────
    const prevRate    = state.lastBtceRate || 0;
    const rateDelta   = liveRate - prevRate;
    const rateGrowth  = prevRate > 0 ? (rateDelta / prevRate) * 100 : 0;

    const vaultCompounded = (
        prevRate > 0 &&
        liveRate > prevRate &&
        btceBal > 0 &&
        rateDelta < 0.01          // sanity cap — > 1% jump in one run = data error
    );

    if (vaultCompounded) {
        const yieldBtc  = btceBal * rateDelta;
        const yieldUsd  = yieldBtc * prices.btcUsd;
        const newBtcUsd = btcEq * prices.btcUsd;

        const msg =
`🟢 <b>BTCe Vault Compounded!</b>

<b>Yield this period:</b> +${yieldBtc.toFixed(8)} BTC (+$${yieldUsd.toFixed(4)})
<b>Rate:</b> ${prevRate.toFixed(9)} → ${liveRate.toFixed(9)} (+${rateGrowth.toFixed(4)}%)
<b>Your position:</b> ${btceBal.toFixed(8)} BTCe = ${btcEq.toFixed(8)} BTC (~$${newBtcUsd.toFixed(2)})
<b>BTC price:</b> $${prices.btcUsd.toLocaleString()}
<b>Checked at:</b> ${new Date().toUTCString()}`;

        await tgSend(msg);
    } else {
        console.log(`   No compound detected (prevRate=${prevRate.toFixed(9)}, delta=${rateDelta.toFixed(10)})`);
    }

    // ── 8. Detect TCY payout (amount increase in staked RUNE rewards) ─────────
    // THORNode doesn't expose cumulative rewards directly on the staker endpoint
    // so we track the raw TCY staked amount — if it increases (auto-compound)
    // or if you add more TCY. For now we just log; extend as THORNode exposes more.
    const prevTcyAmt = state.lastTcyAmount || 0;
    if (prevTcyAmt > 0 && tcy.stakedTcy > prevTcyAmt + 0.0001) {
        const tcyGain  = tcy.stakedTcy - prevTcyAmt;
        const gainUsd  = tcyGain * prices.tcyUsd;

        const msg =
`🟢 <b>TCY Position Increased!</b>

<b>Gained:</b> +${tcyGain.toFixed(4)} TCY (+$${gainUsd.toFixed(4)})
<b>Staked:</b> ${tcy.stakedTcy.toFixed(4)} TCY (~$${tcyUsd.toFixed(2)})
<b>TCY price:</b> $${prices.tcyUsd}`;

        await tgSend(msg);
    }

    // ── 9. Save new state ─────────────────────────────────────────────────────
    const newState = {
        lastBtceRate:    liveRate,
        lastTcyAmount:   tcy.stakedTcy,
        lastBtceBal:     btceBal,
        lastBtcEq:       btcEq,
        lastLbtcUsd:     lbtcUsd,
        lastTcyUsd:      tcyUsd,
        lastTotalUsd:    totalUsd,
        lastBtcPrice:    prices.btcUsd,
        lastRunAt:       new Date().toISOString(),
    };
    await redisSet('portfolio_state', newState);
    console.log(`\n💾 State saved to Upstash Redis`);
    console.log(`✅ Done — next run in 10 min`);
}

runBot().catch(e => {
    console.error('🛑 Fatal error:', e.message);
    process.exit(1);
});

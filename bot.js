const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET = process.env.EVM_WALLET;

const RPC_URL = "https://mainnet.base.org";
const VAULT = "0x3a4baaBf4DC9910596821615e848f0e6545762F3";

async function rpc(method, params) {
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const json = await res.json();
    return json.result;
}

async function sendTelegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
}

async function runBot() {
    console.log("🤖 Bot Waking Up...");

    try {
        // 1. Get Wallet Balance (BTCe is 8 decimals)
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const bal = balHex && balHex !== '0x' ? Number(BigInt(balHex)) / 1e8 : 0;
        console.log(`💰 Balance: ${bal} BTCe`);

        // 2. Get Exchange Rate (totalAssets / totalSupply)
        // Using raw math to ensure precision
        const assetsHex = await rpc('eth_call', [{ to: VAULT, data: '0x01e1d114' }, 'latest']);
        const sharesHex = await rpc('eth_call', [{ to: VAULT, data: '0x18160ddd' }, 'latest']);
        
        let liveRate = 0;
        if (assetsHex && sharesHex && assetsHex !== '0x' && sharesHex !== '0x') {
            const assets = BigInt(assetsHex);
            const shares = BigInt(sharesHex);
            // Multiply by 10^10 before dividing to keep 10 decimal places of precision
            liveRate = Number((assets * BigInt(1e10)) / shares) / 1e10;
        }

        console.log(`📈 Live Rate: ${liveRate}`);

        if (liveRate < 1 || liveRate > 2) {
            console.error("🛑 Rate seems unrealistic. Skipping save.");
            return;
        }

        // 3. Get Previous State
        const redisRes = await fetch(`${REDIS_URL}/get/bot_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const state = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : { lastRate: 0 };

        // 4. Compare & Alert
        // Only alert if the rate increased by a meaningful amount
        if (state.lastRate > 0 && liveRate > state.lastRate && (liveRate - state.lastRate) < 0.1 && bal > 0) {
            const yieldBtc = bal * (liveRate - state.lastRate);
            console.log(`🎉 COMPOUND! +${yieldBtc} BTC`);
            await sendTelegram(`🟢 <b>BTCe Vault Compounded!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(8)} BTC\n<b>New Rate:</b> 1 BTCe = ${liveRate.toFixed(8)} BTC`);
        } else {
            console.log("ℹ️ No new compound detected or first run.");
        }

        // 5. Save New State
        await fetch(`${REDIS_URL}/set/bot_state`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            body: JSON.stringify({ lastRate: liveRate })
        });
        console.log("💾 State saved to Upstash.");

    } catch (e) {
        console.error("🛑 Error:", e.message);
    }
}

runBot();

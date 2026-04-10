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
        // 1. Get Wallet Balance
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const bal = balHex && balHex !== '0x' ? Number(BigInt(balHex)) / 1e8 : 0;
        console.log(`💰 Balance: ${bal} BTCe`);

        // 2. Get Exchange Rate using the "convertToAssets" function for 1 share (0x07a2d13a)
        // This is more reliable than doing the division ourselves
        const oneShare = "1".padEnd(9, '0').padStart(64, '0'); // 1.0 share in 8 decimals
        const rateHex = await rpc('eth_call', [{ to: VAULT, data: '0x07a2d13a' + oneShare }, 'latest']);
        
        let liveRate = 0;
        if (rateHex && rateHex !== '0x') {
            liveRate = Number(BigInt(rateHex)) / 1e8;
        }

        console.log(`📈 Live Rate: ${liveRate}`);

        if (liveRate === 0) {
            console.error("🛑 Could not fetch rate. Skipping save to prevent overwriting with 0.");
            return;
        }

        // 3. Get Previous State from Upstash
        const redisRes = await fetch(`${REDIS_URL}/get/bot_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const state = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : { lastRate: 0 };

        // 4. Compare & Alert
        if (state.lastRate > 0 && liveRate > (state.lastRate + 0.00000001) && bal > 0) {
            const yieldBtc = bal * (liveRate - state.lastRate);
            console.log(`🎉 COMPOUND! +${yieldBtc} BTC`);
            await sendTelegram(`🟢 <b>BTCe Vault Compounded!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(6)} BTC\n<b>New Rate:</b> 1 BTCe = ${liveRate.toFixed(8)} BTC`);
        } else {
            console.log("ℹ️ No new compound detected.");
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

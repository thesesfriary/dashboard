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

async function runBot() {
    console.log("🤖 Bot Waking Up...");

    try {
        // 1. Get Balance
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const bal = balHex && balHex !== '0x' ? Number(BigInt(balHex)) / 1e8 : 0;
        console.log(`💰 Balance: ${bal} BTCe`);

        // 2. Get Exchange Rate (Using high-precision BigInt math)
        const assetsHex = await rpc('eth_call', [{ to: VAULT, data: '0x01e1d114' }, 'latest']);
        const sharesHex = await rpc('eth_call', [{ to: VAULT, data: '0x18160ddd' }, 'latest']);
        
        let liveRate = 0;
        if (assetsHex && sharesHex && assetsHex !== '0x' && sharesHex !== '0x') {
            const assets = BigInt(assetsHex);
            const shares = BigInt(sharesHex);
            
            // We multiply the assets by 1,000,000,000 BEFORE dividing. 
            // This preserves 9 decimal places of growth.
            const precision = BigInt(1e9);
            const scaledRate = (assets * precision) / shares;
            liveRate = Number(scaledRate) / 1e9; 
        }

        console.log(`📈 Live Rate: ${liveRate}`);

        if (liveRate <= 1) {
            console.log("⚠️ Rate is still exactly 1 or 0. Check back when the vault updates.");
        }

        // 3. Get Previous State
        const redisRes = await fetch(`${REDIS_URL}/get/bot_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const state = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : { lastRate: 0 };

        // 4. Compare & Save
        if (state.lastRate > 0 && liveRate > state.lastRate && bal > 0) {
            const yieldBtc = bal * (liveRate - state.lastRate);
            const text = `🟢 <b>BTCe Vault Compounded!</b>\n\n<b>Yield:</b> +${yieldBtc.toFixed(8)} BTC\n<b>New Rate:</b> 1 BTCe = ${liveRate.toFixed(9)} BTC`;
            
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
            });
        }

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

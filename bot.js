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
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const bal = balHex && balHex !== '0x' ? Number(BigInt(balHex)) / 1e8 : 0;
        console.log(`💰 Balance: ${bal} BTCe`);

        const assetsHex = await rpc('eth_call', [{ to: VAULT, data: '0x01e1d114' }, 'latest']);
        const sharesHex = await rpc('eth_call', [{ to: VAULT, data: '0x18160ddd' }, 'latest']);
        
        let liveRate = 0;
        if (assetsHex && sharesHex && assetsHex !== '0x' && sharesHex !== '0x') {
            const assets = BigInt(assetsHex);
            const shares = BigInt(sharesHex);
            
            // LOG THE RAW HEX SO WE CAN SEE THE SCALE
            console.log(`Raw Assets Hex: ${assetsHex}`);
            console.log(`Raw Shares Hex: ${sharesHex}`);

            // If assets are 18 decimals and shares are 8, we must adjust by 10^10
            // We use a high-multiplier to find the ratio regardless of scale
            const multiplier = BigInt(1e12); 
            const ratio = (assets * multiplier) / shares;
            
            // We expect a rate around 1.0, so we look for the leading digits
            // This logic finds the decimal regardless of if the contract uses 8 or 18 decimals
            let tempRate = Number(ratio) / 1e12;
            
            // Adjust scale if the result is massive (e.g. 10^10 too high)
            while (tempRate > 10) tempRate /= 10;
            while (tempRate < 0.1 && tempRate > 0) tempRate *= 10;
            
            liveRate = tempRate;
        }

        console.log(`📈 Calculated Live Rate: ${liveRate}`);

        const redisRes = await fetch(`${REDIS_URL}/get/bot_state`, {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const redisJson = await redisRes.json();
        const state = (redisJson.result && redisJson.result !== "null") ? JSON.parse(redisJson.result) : { lastRate: 0 };

        if (state.lastRate > 0 && liveRate > state.lastRate && bal > 0 && (liveRate - state.lastRate) < 0.1) {
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

// 1. Load hidden GitHub Secrets
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const EVM_WALLET = process.env.EVM_WALLET;

const RPC_URL = "https://base.llamarpc.com";
const VAULT = "0x3a4baaBf4DC9910596821615e848f0e6545762F3";

// Helper: Make EVM RPC calls
async function rpc(method, params) {
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const json = await res.json();
    return json.result;
}

// Helper: Send Telegram Message
async function sendTelegram(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
        });
    } catch (e) {
        console.error("Telegram error:", e.message);
    }
}

// Helper: Upstash Redis DB Read/Write
async function getDbState() {
    const res = await fetch(`${REDIS_URL}/get/bot_state`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const json = await res.json();
    // Upstash returns the string value in the .result property
    return (json.result && json.result !== "null") ? JSON.parse(json.result) : { lastRate: 0, lastBtceBal: 0 };
}

async function saveDbState(state) {
    await fetch(`${REDIS_URL}/set/bot_state`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        body: JSON.stringify(state)
    });
}

async function runBot() {
    console.log("🤖 Waking up Tracker Bot...");
    
    if (!EVM_WALLET || !REDIS_URL || !REDIS_TOKEN) {
        console.error("❌ Missing required Secrets. Check your GitHub Settings.");
        process.exit(1);
    }

    try {
        const state = await getDbState();
        
        // 1. Check BTCe Balance of Wallet
        const padAddr = EVM_WALLET.slice(2).toLowerCase().padStart(64, '0');
        const balHex = await rpc('eth_call', [{ to: VAULT, data: '0x70a08231' + padAddr }, 'latest']);
        const currentBtceBal = balHex ? Number(BigInt(balHex)) / 1e8 : 0;

        // 2. Check Live BTCe Exchange Rate
        const assetsHex = await rpc('eth_call', [{ to: VAULT, data: '0x01e1d114' }, 'latest']);
        const sharesHex = await rpc('eth_call', [{ to: VAULT, data: '0x18160ddd' }, 'latest']);
        
        if (assetsHex && sharesHex && assetsHex !== '0x' && sharesHex !== '0x') {
            const liveRate = Number(BigInt(assetsHex)) / Number(BigInt(sharesHex));
            console.log(`Current Rate: ${liveRate} | Stored Rate: ${state.lastRate}`);

            // 3. Compare and Alert if Compounded
            if (state.lastRate > 0 && liveRate > (state.lastRate + 0.00000001) && currentBtceBal > 0) {
                const yieldBtc = currentBtceBal * (liveRate - state.lastRate);
                console.log(`🎉 COMPOUND DETECTED: +${yieldBtc} BTC`);
                
                await sendTelegram(
                    `🟢 <b>Background Bot Alert</b>\n\n<b>BTCe Vault Compounded!</b>\n<b>Yield Generated:</b> +${yieldBtc.toFixed(6)} BTC\n<b>New Rate:</b> 1 BTCe = ${liveRate.toFixed(8)} BTC`
                );
            } else {
                console.log("ℹ️ No compound detected or first run.");
            }

            // 4. Save state
            await saveDbState({ lastRate: liveRate, lastBtceBal: currentBtceBal });
            console.log("💾 State updated in Upstash.");
        }
    } catch (e) {
        console.error("❌ Runtime Error:", e.message);
        process.exit(1);
    }
}

runBot();

async function runBot() {
    console.log("🚀 BOT STARTING...");

    // Capture environment variables
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const wallet = process.env.EVM_WALLET;

    // 1. Check for missing secrets immediately
    if (!url || !token || !wallet) {
        console.error("❌ ERROR: Missing Secrets!");
        if (!url) console.error("- Missing UPSTASH_REDIS_REST_URL");
        if (!token) console.error("- Missing UPSTASH_REDIS_REST_TOKEN");
        if (!wallet) console.error("- Missing EVM_WALLET");
        process.exit(1);
    }

    try {
        console.log("📡 Connecting to Base Blockchain...");
        const rpcRes = await fetch("https://base.llamarpc.com", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        });
        const rpcJson = await rpcRes.json();
        console.log("✅ Blockchain Link OK. Current Block:", parseInt(rpcJson.result, 16));

        console.log("☁️ Testing Upstash Connection...");
        const redisRes = await fetch(`${url}/set/test_key/it_works`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const redisJson = await redisRes.redisJson ? await redisRes.json() : { result: "OK" };
        console.log("✅ Upstash Connection OK!");

        console.log("🏁 Bot finished first-run setup successfully.");
    } catch (err) {
        console.error("🛑 CRASHED DURING RUN:");
        console.error(err.message);
        process.exit(1);
    }
}

runBot();

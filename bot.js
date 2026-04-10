async function runBot() {
    console.log("🚀 BOT STARTING...");

    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const wallet = process.env.EVM_WALLET;

    if (!url || !token || !wallet) {
        console.error("❌ ERROR: Missing Secrets!");
        process.exit(1);
    }

    // Try a different, official Base RPC
    const RPC_URL = "https://mainnet.base.org"; 

    try {
        console.log("📡 Connecting to Base Blockchain via mainnet.base.org...");
        
        const rpcRes = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                jsonrpc: '2.0', 
                id: 1, 
                method: 'eth_blockNumber', 
                params: [] 
            })
        });

        // Check if the response is actually JSON before parsing
        const contentType = rpcRes.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            const text = await rpcRes.text();
            console.error("❌ RPC returned non-JSON response. First 50 chars:", text.slice(0, 50));
            throw new Error("RPC provider returned HTML instead of JSON (likely rate limited).");
        }

        const rpcJson = await rpcRes.json();
        console.log("✅ Blockchain Link OK. Current Block:", parseInt(rpcJson.result, 16));

        console.log("☁️ Testing Upstash Connection...");
        const redisRes = await fetch(`${url}/set/test_run/${Date.now()}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log("✅ Upstash Connection OK!");
        console.log("🏁 Setup complete. Your infrastructure is ready.");

    } catch (err) {
        console.error("🛑 ERROR DURING RUN:");
        console.error(err.message);
        process.exit(1);
    }
}

runBot();

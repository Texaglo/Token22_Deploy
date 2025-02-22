"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const { workerId, pattern, basePubkey, caseInsensitive, batchSize } = worker_threads_1.workerData;
const matchesPattern = (address) => {
    if (caseInsensitive) {
        return address.toLowerCase().startsWith(pattern.toLowerCase());
    }
    else {
        return address.startsWith(pattern);
    }
};
const searchBatch = async () => {
    const basePub = new web3_js_1.PublicKey(basePubkey);
    for (let i = 0; i < batchSize; i++) {
        const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        try {
            const tokenAddress = await web3_js_1.PublicKey.createWithSeed(basePub, seed, spl_token_1.TOKEN_2022_PROGRAM_ID);
            const address = tokenAddress.toBase58();
            if (matchesPattern(address)) {
                worker_threads_1.parentPort?.postMessage({
                    found: true,
                    workerId,
                    seed,
                    address
                });
                return;
            }
            // Report progress every 1000 attempts
            if (i % 1000 === 0) {
                worker_threads_1.parentPort?.postMessage({
                    found: false,
                    workerId,
                    attempts: 1000
                });
            }
        }
        catch (error) {
            console.error(`Worker ${workerId} error generating address:`, error);
        }
    }
    // Continue searching if no match found
    searchBatch();
};
// Start the search
searchBatch();

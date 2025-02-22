import { parentPort, workerData } from 'worker_threads';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const { workerId, pattern, basePubkey, caseInsensitive, batchSize } = workerData;

const matchesPattern = (address: string) => {
    if (caseInsensitive) {
        return address.toLowerCase().startsWith(pattern.toLowerCase());
    } else {
        return address.startsWith(pattern);
    }
};

const searchBatch = async () => {
    const basePub = new PublicKey(basePubkey);
    
    for (let i = 0; i < batchSize; i++) {
        const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        
        try {
            const tokenAddress = await PublicKey.createWithSeed(
                basePub,
                seed,
                TOKEN_2022_PROGRAM_ID
            );
            
            const address = tokenAddress.toBase58();
            if (matchesPattern(address)) {
                parentPort?.postMessage({
                    found: true,
                    workerId,
                    seed,
                    address
                });
                return;
            }
            
            // Report progress every 1000 attempts
            if (i % 1000 === 0) {
                parentPort?.postMessage({
                    found: false,
                    workerId,
                    attempts: 1000
                });
            }
        } catch (error) {
            console.error(`Worker ${workerId} error generating address:`, error);
        }
    }
    
    // Continue searching if no match found
    searchBatch();
};

// Start the search
searchBatch(); 
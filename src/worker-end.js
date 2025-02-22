"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const worker_threads_1 = require("worker_threads");
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const os = __importStar(require("os"));
const GPUBufferUsage = {
    STORAGE: 0x0020,
    COPY_SRC: 0x0002,
    COPY_DST: 0x0004,
    MAP_READ: 0x0001,
};
const GPUMapMode = {
    READ: 0x0001,
};
const { workerId, pattern, basePubkey, caseInsensitive } = worker_threads_1.workerData;
// Get CPU info for Apple Silicon
function getCPUInfo() {
    const cpus = os.cpus();
    const isAppleSilicon = process.arch === 'arm64' && process.platform === 'darwin';
    return {
        isAppleSilicon,
        cores: cpus.length,
        performance: isAppleSilicon ? 2 : 1 // Apple Silicon cores are roughly 2x faster
    };
}
// Update constants based on CPU info
const CPU_INFO = getCPUInfo();
const TOTAL_CORES = CPU_INFO.cores;
const BATCH_SIZE = CPU_INFO.isAppleSilicon ? 1000000 : 100000; // Larger batches for Apple Silicon
const TOTAL_WORKERS = TOTAL_CORES * (CPU_INFO.isAppleSilicon ? 4 : 1); // More workers on Apple Silicon
// Initialize workers
function initWorkers(numWorkers) {
    return Array(numWorkers).fill(null).map((_, i) => ({
        id: i,
        batchSize: BATCH_SIZE,
    }));
}
// Process batch using optimized CPU approach
async function processBatch(worker) {
    const { batchSize } = worker;
    const startTime = process.hrtime.bigint();
    // Pre-allocate buffer for better performance
    const seedBuffer = Buffer.alloc(32);
    for (let i = 0; i < batchSize; i++) {
        // Generate random seed more efficiently
        const randomBytes = crypto.getRandomValues(new Uint8Array(32));
        seedBuffer.set(randomBytes);
        const seed = seedBuffer.toString('hex');
        try {
            const tokenAddress = await web3_js_1.PublicKey.createWithSeed(new web3_js_1.PublicKey(basePubkey), seed, spl_token_1.TOKEN_2022_PROGRAM_ID);
            const address = tokenAddress.toBase58();
            if (matchesPattern(address)) {
                const endTime = process.hrtime.bigint();
                const duration = Number(endTime - startTime) / 1e9; // Convert to seconds
                return {
                    found: true,
                    seed,
                    address,
                    attempts: i + 1,
                    duration,
                    workerId: worker.id
                };
            }
        }
        catch (error) {
            console.error(`Worker ${worker.id} error:`, error);
        }
    }
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1e9; // Convert to seconds
    return {
        found: false,
        attempts: batchSize,
        duration,
        workerId: worker.id
    };
}
const matchesPattern = (address) => {
    if (caseInsensitive) {
        return address.toLowerCase().endsWith(pattern.toLowerCase());
    }
    else {
        return address.endsWith(pattern);
    }
};
// Main search function utilizing all CPU cores efficiently
async function parallelSearch() {
    console.log(`Running on ${CPU_INFO.isAppleSilicon ? 'Apple Silicon' : 'standard CPU'}`);
    console.log(`Using ${TOTAL_WORKERS} workers with ${BATCH_SIZE} addresses per batch`);
    const workers = initWorkers(TOTAL_WORKERS);
    let totalAttempts = 0;
    let lastProgressUpdate = Date.now();
    let running = true;
    // Process function for each worker
    const processWorker = async (worker) => {
        while (running) {
            const result = await processBatch(worker);
            totalAttempts += result.attempts;
            // Report progress every second
            const now = Date.now();
            if (now - lastProgressUpdate >= 1000) {
                const attemptsPerSecond = Math.floor(totalAttempts / ((now - lastProgressUpdate) / 1000));
                worker_threads_1.parentPort?.postMessage({
                    found: false,
                    workerId: worker.id,
                    attempts: attemptsPerSecond,
                    totalAttempts
                });
                lastProgressUpdate = now;
                totalAttempts = 0;
            }
            if (result.found) {
                running = false;
                worker_threads_1.parentPort?.postMessage({
                    found: true,
                    workerId: worker.id,
                    seed: result.seed,
                    address: result.address,
                    performance: Math.floor(result.attempts / result.duration)
                });
                return;
            }
        }
    };
    // Start all workers in parallel
    try {
        await Promise.race(workers.map(worker => processWorker(worker)));
    }
    catch (error) {
        console.error('Search error:', error);
    }
}
// Start the parallel search
parallelSearch();

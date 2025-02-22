import { parentPort, workerData, Worker } from 'worker_threads';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as os from 'os';
import { spawnSync } from 'child_process';

// WebGPU type definitions
declare global {
    interface Navigator {
        gpu: {
            requestAdapter(): Promise<GPUAdapter | null>;
        };
    }

    interface GPUAdapter {
        requestDevice(): Promise<GPUDevice>;
    }

    interface GPUBufferDescriptor {
        size: number;
        usage: number;
    }

    interface GPUBindGroupDescriptor {
        layout: GPUBindGroupLayout;
        entries: {
            binding: number;
            resource: { buffer: GPUBuffer };
        }[];
    }

    interface GPUComputePipelineDescriptor {
        layout: 'auto' | GPUPipelineLayout;
        compute: {
            module: GPUShaderModule;
            entryPoint: string;
        };
    }

    interface GPUShaderModule {
        [key: string]: any;
    }

    interface GPUPipelineLayout {
        [key: string]: any;
    }

    interface GPUDevice {
        createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
        createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
        createCommandEncoder(): GPUCommandEncoder;
        createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline;
        createShaderModule(descriptor: { code: string }): GPUShaderModule;
        queue: GPUQueue;
    }

    interface GPUBuffer {
        mapAsync(mode: number): Promise<void>;
        getMappedRange(): ArrayBuffer;
        unmap(): void;
    }

    interface GPUBindGroup {
        [key: string]: any;
    }

    interface GPUCommandEncoder {
        beginComputePass(): GPUComputePassEncoder;
        copyBufferToBuffer(
            source: GPUBuffer,
            sourceOffset: number,
            destination: GPUBuffer,
            destinationOffset: number,
            size: number
        ): void;
        finish(): GPUCommandBuffer;
    }

    interface GPUComputePassEncoder {
        setPipeline(pipeline: GPUComputePipeline): void;
        setBindGroup(index: number, bindGroup: GPUBindGroup): void;
        dispatchWorkgroups(x: number): void;
        end(): void;
    }

    interface GPUQueue {
        submit(commandBuffers: GPUCommandBuffer[]): void;
    }

    interface GPUCommandBuffer {
        [key: string]: any;
    }

    interface GPUComputePipeline {
        getBindGroupLayout(index: number): GPUBindGroupLayout;
    }

    interface GPUBindGroupLayout {
        [key: string]: any;
    }

    var navigator: Navigator;
}

const GPUBufferUsage = {
    STORAGE: 0x0020,
    COPY_SRC: 0x0002,
    COPY_DST: 0x0004,
    MAP_READ: 0x0001,
} as const;

const GPUMapMode = {
    READ: 0x0001,
} as const;

const { workerId, pattern, basePubkey, caseInsensitive } = workerData;

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
function initWorkers(numWorkers: number) {
    return Array(numWorkers).fill(null).map((_, i) => ({
        id: i,
        batchSize: BATCH_SIZE,
    }));
}

// Process batch using optimized CPU approach
async function processBatch(worker: any): Promise<SearchResult> {
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
            const tokenAddress = await PublicKey.createWithSeed(
                new PublicKey(basePubkey),
                seed,
                TOKEN_2022_PROGRAM_ID
            );
            
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
        } catch (error) {
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

const matchesPattern = (address: string) => {
    if (caseInsensitive) {
        return address.toLowerCase().endsWith(pattern.toLowerCase());
    } else {
        return address.endsWith(pattern);
    }
};

interface SearchResult {
    found: boolean;
    seed?: string;
    address?: string;
    attempts: number;
    duration: number;
    workerId: number;
}

// Main search function utilizing all CPU cores efficiently
async function parallelSearch() {
    console.log(`Running on ${CPU_INFO.isAppleSilicon ? 'Apple Silicon' : 'standard CPU'}`);
    console.log(`Using ${TOTAL_WORKERS} workers with ${BATCH_SIZE} addresses per batch`);
    
    const workers = initWorkers(TOTAL_WORKERS);
    let totalAttempts = 0;
    let lastProgressUpdate = Date.now();
    let running = true;

    // Process function for each worker
    const processWorker = async (worker: any) => {
        while (running) {
            const result = await processBatch(worker);
            totalAttempts += result.attempts;
            
            // Report progress every second
            const now = Date.now();
            if (now - lastProgressUpdate >= 1000) {
                const attemptsPerSecond = Math.floor(totalAttempts / ((now - lastProgressUpdate) / 1000));
                parentPort?.postMessage({
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
                parentPort?.postMessage({
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
        await Promise.race(
            workers.map(worker => processWorker(worker))
        );
    } catch (error) {
        console.error('Search error:', error);
    }
}

// Start the parallel search
parallelSearch(); 
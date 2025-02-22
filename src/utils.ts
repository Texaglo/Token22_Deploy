import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { 
    TOKEN_2022_PROGRAM_ID, 
    createInitializeMetadataPointerInstruction, 
    createInitializeMintInstruction, 
    ExtensionType, 
    getMintLen,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    createUpdateMetadataPointerInstruction,
    createSetAuthorityInstruction,
    AuthorityType
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import * as os from 'os';
import { execSync } from 'child_process';

export interface TokenSeed {
    pattern: string;
    seed: string;
    tokenName: string;
    tokenAddress: string;
    timestamp: string;
}

export interface TokenConfig {
    pattern: string;
    position: 'start' | 'end';
    caseInsensitive: boolean;
    name: string;
    symbol: string;
    description: string;
}

export const SEEDS_FILE = path.join(__dirname, '../seeds/token_seeds.json');
export const KEYS_DIR = path.join(__dirname, '../token_keys');

export function ensureDirectoryExists(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function saveTokenSeed(tokenSeed: TokenSeed) {
    ensureDirectoryExists(path.dirname(SEEDS_FILE));
    let seeds: TokenSeed[] = [];
    if (fs.existsSync(SEEDS_FILE)) {
        seeds = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf-8'));
    }
    seeds.push(tokenSeed);
    fs.writeFileSync(SEEDS_FILE, JSON.stringify(seeds, null, 2));
}

export function saveTokenKeypair(keypair: Keypair, tokenName: string) {
    ensureDirectoryExists(KEYS_DIR);
    const filename = path.join(KEYS_DIR, `${tokenName.toLowerCase()}_keys.json`);
    fs.writeFileSync(filename, JSON.stringify(Array.from(keypair.secretKey)));
}

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

    interface GPUDevice {
        [key: string]: any;
    }

    var navigator: Navigator;
}

interface GPUContext {
    device: GPUDevice;
    adapter: GPUAdapter;
}

export async function findVanityAddress(
    pattern: string,
    position: 'start' | 'end',
    connection: Connection,
    caseInsensitive: boolean = false
): Promise<{ keypair: Keypair; seed: string; tokenAddress: PublicKey }> {
    console.log(`Searching for vanity address ${position === 'start' ? 'starting' : 'ending'} with '${pattern}'...`);
    console.log(`Case ${caseInsensitive ? 'insensitive' : 'sensitive'} search`);
    
    // Create token keypair if it doesn't exist
    const keypairPath = path.join(KEYS_DIR, 'token_keypair.json');
    if (!fs.existsSync(keypairPath)) {
        await new Promise<void>((resolve, reject) => {
            const process = spawn('solana-keygen', [
                'new',
                '--no-bip39-passphrase',
                '--force',
                '-o',
                keypairPath
            ]);
            
            process.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('Failed to create token keypair'));
                }
            });
        });
    }
    
    // Get the base pubkey
    const basePubkey = await new Promise<string>((resolve, reject) => {
        const process = spawn('solana-keygen', ['pubkey', keypairPath]);
        let output = '';
        
        process.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.on('close', (code: number) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`Failed to get base pubkey: ${output}`));
            }
        });
    });

    // Use appropriate method based on position
    if (position === 'start') {
        console.log('Using vanity CLI for start pattern...');
        return findVanityAddressStart(pattern, basePubkey, caseInsensitive);
    } else {
        console.log('Using GPU-accelerated search for end pattern...');
        return findVanityAddressEnd(pattern, basePubkey, caseInsensitive);
    }
}

async function findVanityAddressStart(
    pattern: string,
    basePubkey: string,
    caseInsensitive: boolean
): Promise<{ keypair: Keypair; seed: string; tokenAddress: PublicKey }> {
    return new Promise((resolve, reject) => {
        const args = [
            'grind',
            '--base',
            basePubkey,
            '--owner',
            'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
            '--target',
            pattern,
            '--num-cpus',
            os.cpus().length.toString()
        ];

        if (caseInsensitive) {
            args.push('--case-insensitive');
        }

        console.log(`Running vanity CLI with ${os.cpus().length} CPU cores...`);
        const process = spawn('vanity', args);
        let output = '';
        
        process.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            output += text;
            if (text.includes('attempts per second')) {
                console.log(text.trim()); // Show progress
            }
        });
        
        process.stderr.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.on('close', (code: number) => {
            if (code === 0) {
                const seedMatch = output.match(/-> ([^\s]+) in/);
                const addressMatch = output.match(/found target: ([^\s;]+);/);
                
                if (seedMatch && addressMatch) {
                    const seed = seedMatch[1];
                    const tokenAddress = new PublicKey(addressMatch[1]);
                    
                    const keypairPath = path.join(KEYS_DIR, 'token_keypair.json');
                    const baseKeypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
                    const keypair = Keypair.fromSecretKey(new Uint8Array(baseKeypairData));
                    
                    resolve({ keypair, seed, tokenAddress });
                } else {
                    reject(new Error('Could not parse vanity address from output'));
                }
            } else {
                reject(new Error(`Process exited with code ${code}: ${output}`));
            }
        });
    });
}

async function findVanityAddressEnd(
    pattern: string,
    basePubkey: string,
    caseInsensitive: boolean
): Promise<{ keypair: Keypair; seed: string; tokenAddress: PublicKey }> {
    const numCPUs = os.cpus().length;
    console.log(`Using ${numCPUs} CPU cores for parallel search...`);

    // Initialize GPU if available
    let gpuContext: GPUContext | null = null;
    try {
        if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const device = await adapter.requestDevice();
                gpuContext = { device, adapter };
                console.log('GPU acceleration enabled');
            }
        }
    } catch (error) {
        console.log('GPU acceleration not available, falling back to CPU only');
    }

    return new Promise((resolve, reject) => {
        let activeWorkers = 0;
        let foundMatch = false;
        let totalAttempts = 0;
        const startTime = Date.now();
        let lastProgressUpdate = Date.now();

        // Function to create a worker
        const createWorker = (workerId: number) => {
            const worker = new Worker(path.join(__dirname, 'worker-end.js'), {
                workerData: {
                    workerId,
                    pattern,
                    basePubkey,
                    caseInsensitive,
                    batchSize: 1000000, // Increased batch size for better performance
                    gpuDevice: gpuContext?.device
                }
            });

            activeWorkers++;

            worker.on('message', (result) => {
                if (result.found && !foundMatch) {
                    foundMatch = true;
                    
                    const keypairPath = path.join(KEYS_DIR, 'token_keypair.json');
                    const baseKeypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
                    const keypair = Keypair.fromSecretKey(new Uint8Array(baseKeypairData));
                    
                    resolve({
                        keypair,
                        seed: result.seed,
                        tokenAddress: new PublicKey(result.address)
                    });

                    // Terminate all workers
                    process.emit('SIGINT');
                } else if (!result.found) {
                    totalAttempts += result.attempts;
                    
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 1000) {
                        const elapsedSeconds = (now - startTime) / 1000;
                        const attemptsPerSecond = Math.floor(totalAttempts / elapsedSeconds);
                        process.stdout.write(`\rTotal attempts: ${totalAttempts.toLocaleString()} (${attemptsPerSecond.toLocaleString()}/s)`);
                        lastProgressUpdate = now;
                    }
                }
            });

            worker.on('error', (err) => {
                console.error(`Worker ${workerId} error:`, err);
            });

            worker.on('exit', () => {
                activeWorkers--;
                if (activeWorkers === 0 && !foundMatch) {
                    reject(new Error('All workers completed without finding a match'));
                }
            });

            return worker;
        };

        // Create workers for each CPU core
        const workers = Array(numCPUs).fill(null).map((_, i) => createWorker(i));

        // Handle process termination
        process.on('SIGINT', () => {
            console.log('\nTerminating workers...');
            workers.forEach(worker => worker.terminate());
        });
    });
}

// Worker thread code
if (!isMainThread) {
    const { workerId, pattern, basePubkey, caseInsensitive, position, batchSize } = workerData;

    const matchesPattern = (address: string) => {
        if (caseInsensitive) {
            return address.toLowerCase().endsWith(pattern.toLowerCase());
        } else {
            return address.endsWith(pattern);
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
                
                if (matchesPattern(tokenAddress.toBase58())) {
                    parentPort?.postMessage({
                        found: true,
                        workerId,
                        seed,
                        address: tokenAddress.toBase58()
                    });
                    return;
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
}

export async function fundAccount(
    connection: Connection,
    from: Keypair,
    to: PublicKey,
    amount: number
): Promise<string> {
    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: from.publicKey,
            toPubkey: to,
            lamports: amount * LAMPORTS_PER_SOL
        })
    );
    
    const signature = await connection.sendTransaction(transaction, [from]);
    await connection.confirmTransaction(signature);
    return signature;
}

export async function createToken(
    connection: Connection,
    config: TokenConfig,
    payer: Keypair
): Promise<{ tokenAddress: PublicKey; signature: string }> {
    // Find vanity address
    const { keypair, seed, tokenAddress } = await findVanityAddress(
        config.pattern,
        config.position,
        connection,
        config.caseInsensitive
    );
    
    // Save keypair
    saveTokenKeypair(keypair, config.name);
    
    // Fund the keypair
    await fundAccount(connection, payer, keypair.publicKey, 0.1);
    
    // Calculate space needed for mint with metadata
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    
    // Create transaction
    const transaction = new Transaction();
    
    // Create token account
    transaction.add(
        SystemProgram.createAccountWithSeed({
            fromPubkey: keypair.publicKey,
            newAccountPubkey: tokenAddress,
            basePubkey: keypair.publicKey,
            seed: seed,
            lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
            space: mintLen,
            programId: TOKEN_2022_PROGRAM_ID
        })
    );
    
    // Initialize metadata pointer
    transaction.add(
        createInitializeMetadataPointerInstruction(
            tokenAddress,
            keypair.publicKey,
            keypair.publicKey,
            TOKEN_2022_PROGRAM_ID
        )
    );
    
    // Initialize mint
    transaction.add(
        createInitializeMintInstruction(
            tokenAddress,
            6, // Decimals
            keypair.publicKey,
            keypair.publicKey,
            TOKEN_2022_PROGRAM_ID
        )
    );

    // Send transaction
    const signature = await connection.sendTransaction(transaction, [keypair]);
    await connection.confirmTransaction(signature);
    
    // Save seed information
    saveTokenSeed({
        pattern: config.pattern,
        seed,
        tokenName: config.name,
        tokenAddress: tokenAddress.toBase58(),
        timestamp: new Date().toISOString()
    });

    // Transfer mint authority to admin wallet
    const mintAuthTransaction = new Transaction().add(
        createSetAuthorityInstruction(
            tokenAddress,
            keypair.publicKey,
            AuthorityType.MintTokens,
            payer.publicKey,
            [],
            TOKEN_2022_PROGRAM_ID
        )
    );
    const mintAuthSignature = await connection.sendTransaction(mintAuthTransaction, [keypair]);
    await connection.confirmTransaction(mintAuthSignature);

    // Transfer freeze authority to admin wallet
    const freezeAuthTransaction = new Transaction().add(
        createSetAuthorityInstruction(
            tokenAddress,
            keypair.publicKey,
            AuthorityType.FreezeAccount,
            payer.publicKey,
            [],
            TOKEN_2022_PROGRAM_ID
        )
    );
    const freezeAuthSignature = await connection.sendTransaction(freezeAuthTransaction, [keypair]);
    await connection.confirmTransaction(freezeAuthSignature);

    // Verify authorities
    console.log('Verifying authority transfers...');
    const verifyResult = execSync(`spl-token display ${tokenAddress.toBase58()} --url devnet`, { encoding: 'utf8' });
    console.log(verifyResult);
    
    return { tokenAddress, signature };
}

export async function initializeMetadata(
    connection: Connection,
    tokenAddress: PublicKey,
    keypair: Keypair,
    config: TokenConfig
): Promise<string> {
    // Use spl-token CLI to initialize metadata
    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
        const process = spawn('spl-token', [
            'initialize-metadata',
            tokenAddress.toBase58(),
            config.name,
            config.symbol,
            config.description,
            '--url',
            'devnet',
            '--fee-payer',
            path.join(KEYS_DIR, `${config.name.toLowerCase()}_keys.json`),
            '--owner',
            path.join(KEYS_DIR, `${config.name.toLowerCase()}_keys.json`)
        ]);
        
        let output = '';
        
        process.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.stderr.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.on('close', (code: number) => {
            if (code === 0) {
                const match = output.match(/Signature: ([^\s]+)/);
                if (match) {
                    resolve(match[1]);
                } else {
                    resolve(output);
                }
            } else {
                reject(new Error(`Process exited with code ${code}: ${output}`));
            }
        });
    });
}

export interface MetadataUpdate {
    name?: string;
    symbol?: string;
    description?: string;
}

export async function updateMetadata(
    connection: Connection,
    tokenKeypair: Keypair,
    update: MetadataUpdate
): Promise<string[]> {
    const { spawn } = require('child_process');
    const signatures: string[] = [];

    // Get token address from seeds file
    let tokenAddress: string | undefined;
    if (fs.existsSync(SEEDS_FILE)) {
        const seeds = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf-8'));
        const tokenSeed = seeds.find((seed: TokenSeed) => 
            seed.tokenAddress.toLowerCase().startsWith('cat')
        );
        if (tokenSeed) {
            tokenAddress = tokenSeed.tokenAddress;
        }
    }

    if (!tokenAddress) {
        throw new Error('Token address not found in seeds file');
    }

    const updateField = async (field: string, value: string): Promise<string> => {
        return new Promise((resolve, reject) => {
            const process = spawn('spl-token', [
                'update-metadata',
                tokenAddress!,
                field,
                value,
                '--fee-payer',
                path.join(KEYS_DIR, `cattoken_keys.json`),
                '--url',
                'devnet'
            ]);
            
            let output = '';
            
            process.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            });
            
            process.stderr.on('data', (data: Buffer) => {
                output += data.toString();
            });
            
            process.on('close', (code: number) => {
                if (code === 0) {
                    const match = output.match(/Signature: ([^\s]+)/);
                    if (match) {
                        resolve(match[1]);
                    } else {
                        resolve(output);
                    }
                } else {
                    reject(new Error(`Process exited with code ${code}: ${output}`));
                }
            });
        });
    };

    try {
        // Update each field if provided
        if (update.name) {
            const sig = await updateField('name', update.name);
            signatures.push(sig);
        }
        if (update.symbol) {
            const sig = await updateField('symbol', update.symbol);
            signatures.push(sig);
        }
        if (update.description) {
            const sig = await updateField('uri', update.description);
            signatures.push(sig);
        }
        return signatures;
    } catch (error: any) {
        throw new Error(`Failed to update metadata: ${error?.message || 'Unknown error'}`);
    }
}

export async function revokeUpdateAuthority(
    connection: Connection,
    tokenKeypair: Keypair
): Promise<string> {
    // Get token address from seeds file
    let tokenAddress: string | undefined;
    if (fs.existsSync(SEEDS_FILE)) {
        const seeds = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf-8'));
        const tokenSeed = seeds.find((seed: TokenSeed) => 
            seed.tokenAddress.toLowerCase().startsWith('cat')
        );
        if (tokenSeed) {
            tokenAddress = tokenSeed.tokenAddress;
        }
    }

    if (!tokenAddress) {
        throw new Error('Token address not found in seeds file');
    }

    const { spawn } = require('child_process');
    
    return new Promise((resolve, reject) => {
        const process = spawn('spl-token', [
            'authorize',
            tokenAddress,
            'metadata',
            '--disable',
            '--fee-payer',
            path.join(KEYS_DIR, `cattoken_keys.json`),
            '--url',
            'devnet'
        ]);
        
        let output = '';
        
        process.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.stderr.on('data', (data: Buffer) => {
            output += data.toString();
        });
        
        process.on('close', (code: number) => {
            if (code === 0) {
                const match = output.match(/Signature: ([^\s]+)/);
                if (match) {
                    resolve(match[1]);
                } else {
                    resolve(output);
                }
            } else {
                reject(new Error(`Process exited with code ${code}: ${output}`));
            }
        });
    });
}

export async function mintTokens(
    connection: Connection,
    tokenMint: PublicKey,
    mintAuthority: Keypair,
    recipient: PublicKey,
    amount: number
): Promise<string> {
    // Load the token keypair for signing
    const tokenKeypairPath = path.join(KEYS_DIR, 'token_keypair.json');
    const tokenKeypairData = JSON.parse(fs.readFileSync(tokenKeypairPath, 'utf-8'));
    const tokenKeypair = Keypair.fromSecretKey(new Uint8Array(tokenKeypairData));
    
    const transaction = new Transaction();
    
    // Get the token account address
    const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        recipient,
        true,
        TOKEN_2022_PROGRAM_ID
    );
    
    // Check if token account exists
    const tokenAccountInfo = await connection.getAccountInfo(tokenAccount);
    
    // Create token account if it doesn't exist
    if (!tokenAccountInfo) {
        transaction.add(
            createAssociatedTokenAccountInstruction(
                tokenKeypair.publicKey,
                tokenAccount,
                recipient,
                tokenMint,
                TOKEN_2022_PROGRAM_ID
            )
        );
    }
    
    // Add mint instruction
    transaction.add(
        createMintToInstruction(
            tokenMint,
            tokenAccount,
            tokenKeypair.publicKey,
            amount * Math.pow(10, 6), // Assuming 6 decimals
            [],
            TOKEN_2022_PROGRAM_ID
        )
    );
    
    // Send transaction with token keypair
    const signature = await connection.sendTransaction(transaction, [tokenKeypair]);
    await connection.confirmTransaction(signature);
    return signature;
}

export const sleep = (ms: number): Promise<void> => 
    new Promise(resolve => setTimeout(resolve, ms)); 
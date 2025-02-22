#!/usr/bin/env node
import { Command } from 'commander';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { 
    TOKEN_2022_PROGRAM_ID,
    createInitializeMetadataPointerInstruction,
    createInitializeMintInstruction,
    ExtensionType,
    getMintLen,
    createSetAuthorityInstruction,
    AuthorityType
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import { createReadStream } from 'fs';
import Bundlr from '@bundlr-network/client';
import { NETWORK_CONFIG, MAINNET_WARNINGS, VALIDATION, ERRORS } from './config';
import * as readline from 'readline';

const program = new Command();

interface TokenConfig {
    pattern: string;
    position: 'start' | 'end';
    name: string;
    symbol: string;
    description: string;
    image?: string;
    initialSupply?: number;
    useGpu?: boolean;
    threads?: number;
    caseInsensitive?: boolean;
}

interface RustResult {
    token_address: string;
    seed: string;
    keypair_json: string;
}

function getAdminKeypairPath(): string {
    // Get the absolute path to the admin keypair
    const adminKeypairPath = path.join(__dirname, '..', 'admin', 'admin_keypair.json');
    if (!fs.existsSync(adminKeypairPath)) {
        throw new Error('Admin keypair not found. Please run setup first.');
    }
    return adminKeypairPath;
}

async function findVanityAddress(config: TokenConfig): Promise<{
    tokenAddress: string;
    seed: string;
    keypairJson: string;
}> {
    // For end patterns, use our Rust implementation for better performance
    if (config.position === 'end') {
        console.log('Using optimized Rust implementation for end pattern search...');
        const args = [
            '--pattern', config.pattern,
            '--position', 'end',
            config.useGpu ? '--gpu' : '',
            config.caseInsensitive ? '--case-insensitive' : '',
            config.threads ? `--threads ${config.threads}` : ''
        ].filter(Boolean);

        // Set RUST_LOG for better output
        const env = { ...process.env, RUST_LOG: 'info' };
        
        // Use spawn instead of execSync to get real-time output
        const rustProcess = require('child_process').spawn(
            './target/release/token22-vanity',
            args,
            { env }
        );

        return new Promise<{ tokenAddress: string; seed: string; keypairJson: string }>((resolve, reject) => {
            let output = '';
            let jsonResult: RustResult | null = null;

            rustProcess.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                output += text;
                process.stdout.write(text); // Show output in real-time
                
                // Try to extract JSON result if present
                const resultMatch = text.match(/RESULT_START\n([\s\S]*?)\nRESULT_END/);
                if (resultMatch) {
                    try {
                        jsonResult = JSON.parse(resultMatch[1]);
                    } catch (error) {
                        console.error('Failed to parse JSON result:', resultMatch[1]);
                    }
                }
            });

            rustProcess.stderr.on('data', (data: Buffer) => {
                process.stderr.write(data); // Show errors in real-time
            });

            rustProcess.on('close', (code: number) => {
                if (code !== 0) {
                    reject(new Error(`Process exited with code ${code}`));
                    return;
                }

                // Try to find JSON result in complete output if not found in streaming
                if (!jsonResult) {
                    const finalMatch = output.match(/RESULT_START\n([\s\S]*?)\nRESULT_END/);
                    if (finalMatch) {
                        try {
                            jsonResult = JSON.parse(finalMatch[1]);
                        } catch (error) {
                            console.error('Failed to parse JSON result:', finalMatch[1]);
                        }
                    }
                }

                if (!jsonResult) {
                    console.error('Full output:', output);
                    reject(new Error('Could not find result markers in Rust output'));
                    return;
                }

                const { token_address: tokenAddress, seed } = jsonResult;

                // The keypair should have been saved by the Rust program
                if (!fs.existsSync('token_keys/token_keypair.json')) {
                    reject(new Error('Keypair file not found - the Rust program should have created it'));
                    return;
                }

                const keypairJson = fs.readFileSync('token_keys/token_keypair.json', 'utf8');
                console.log('Successfully parsed Rust output:', { tokenAddress, seed });
                resolve({ tokenAddress, seed, keypairJson });
            });

            // Handle process errors
            rustProcess.on('error', (error: Error) => {
                reject(new Error(`Failed to start Rust process: ${error.message}`));
            });
        });
    } else {
        // For start patterns, use the existing Solana CLI (it's fast enough for start patterns)
        console.log('Using Solana CLI for start pattern search...');
        const result = execSync(`solana-keygen grind --starts-with ${config.pattern}:1${config.caseInsensitive ? ' --ignore-case' : ''}`, {
            encoding: 'utf8'
        });

        // Parse the output
        const lines = result.split('\n');
        const keypairLine = lines.find(l => l.includes('Wrote keypair to'));
        if (!keypairLine) {
            throw new Error('Could not find keypair in output');
        }

        // Extract the filename
        const keypairFile = keypairLine.split('Wrote keypair to ')[1].trim();
        
        // Read the generated keypair file
        const keypairJson = fs.readFileSync(keypairFile, 'utf8');
        
        // Create keypair to verify it matches the pattern
        const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(keypairJson)));
        const pubkey = keypair.publicKey.toBase58();
        
        if (!pubkey.toLowerCase().startsWith(config.pattern.toLowerCase())) {
            fs.unlinkSync(keypairFile);
            throw new Error(`Generated address ${pubkey} does not start with ${config.pattern}`);
        }
        
        // Move the keypair file to our token_keys directory
        fs.renameSync(keypairFile, 'token_keys/token_keypair.json');

        // For start patterns, use the keypair's public key directly
        return {
            tokenAddress: pubkey,
            seed: '', // No seed needed for start patterns
            keypairJson
        };
    }
}

async function fundKeypair(keypairPath: string): Promise<void> {
    console.log('Funding keypair...');
    
    // Ensure we're on mainnet
    execSync('solana config set --url mainnet-beta', { stdio: 'inherit' });
    
    // Get the admin wallet path
    const adminWalletPath = getAdminKeypairPath();
    const targetPubkey = execSync(`solana-keygen pubkey "${keypairPath}"`, { encoding: 'utf8' }).trim();
    
    // Check admin wallet balance
    const adminBalance = execSync(`solana balance ${adminWalletPath} --url mainnet-beta`, { encoding: 'utf8' });
    const solBalance = parseFloat(adminBalance);
    console.log(`Admin wallet balance: ${solBalance} SOL`);
    
    // Ensure admin has enough SOL for the transfer and future operations
    const requiredBalance = NETWORK_CONFIG.MIN_SOL_BALANCE;
    if (solBalance < requiredBalance) {
        throw new Error(`Insufficient balance. Admin wallet needs at least ${requiredBalance} SOL`);
    }
    
    // Transfer minimum SOL needed for token operations
    console.log('Transferring 0.01 SOL for token operations...');
    execSync(`solana transfer --from ${adminWalletPath} ${targetPubkey} 0.01 --url mainnet-beta --allow-unfunded-recipient`);
    
    // Wait for confirmation
    execSync('sleep 2');
    
    // Verify the transfer
    const newBalance = execSync(`solana balance ${targetPubkey} --url mainnet-beta`, { encoding: 'utf8' });
    const newSolBalance = parseFloat(newBalance);
    
    if (newSolBalance < 0.01) {
        throw new Error('Failed to fund keypair - balance too low after transfer');
    }
    
    console.log(`Keypair funded successfully. Balance: ${newBalance.trim()}`);
}

async function processImage(imagePath: string): Promise<string> {
    // Check if it's a URL
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        try {
            // Test if the URL is accessible
            const response = await fetch(imagePath);
            if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.statusText}`);
            }
            
            // Check content type
            const contentType = response.headers.get('content-type');
            if (!contentType?.startsWith('image/')) {
                throw new Error('URL does not point to an image');
            }
            
            return imagePath;
        } catch (error: any) {
            throw new Error(`Invalid image URL: ${error.message || 'Unknown error'}`);
        }
    } else {
        // Treat as local file
        if (!fs.existsSync(imagePath)) {
            throw new Error(`Image file not found: ${imagePath}`);
        }

        // Check file extension
        const ext = path.extname(imagePath).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
            throw new Error('Unsupported image format. Use PNG, JPG, GIF, or WebP');
        }

        // Upload to Arweave using Bundlr
        console.log('Uploading image to Arweave...');
        const jwk = JSON.parse(fs.readFileSync(getAdminKeypairPath(), 'utf8'));
        const bundlr = new Bundlr('https://node1.bundlr.network', 'solana', jwk);

        // Fund bundlr if needed
        const size = fs.statSync(imagePath).size;
        const price = await bundlr.getPrice(size);
        const balance = await bundlr.getLoadedBalance();
        
        if (balance.isLessThan(price)) {
            console.log('Funding Bundlr...');
            await bundlr.fund(price);
        }

        // Upload file
        const tags = [{ name: 'Content-Type', value: `image/${ext.slice(1)}` }];
        const response = await bundlr.uploadFile(imagePath, { tags });
        
        return `https://arweave.net/${response.id}`;
    }
}

// Add mainnet safety check function
async function checkMainnetSafety(config: TokenConfig): Promise<void> {
    if (NETWORK_CONFIG.SAFETY_CHECKS.CONFIRM_MAINNET) {
        console.log('\n=== MAINNET SAFETY CHECKS ===');
        console.log('⚠️  WARNING: You are about to create a token on Solana Mainnet');
        console.log(MAINNET_WARNINGS.COST);
        console.log(MAINNET_WARNINGS.IRREVERSIBLE);
        console.log('\nToken Details:');
        console.log(`Name: ${config.name}`);
        console.log(`Symbol: ${config.symbol}`);
        console.log(`Description: ${config.description}`);
        if (config.initialSupply) {
            console.log(`Initial Supply: ${config.initialSupply}`);
        }
        console.log('\nPlease verify all details are correct.');
        
        // Check admin wallet balance
        const adminWalletPath = getAdminKeypairPath();
        const balance = execSync(`solana balance ${adminWalletPath} --url mainnet-beta`, { encoding: 'utf8' });
        const solBalance = parseFloat(balance);
        
        if (solBalance < NETWORK_CONFIG.MIN_SOL_BALANCE) {
            throw new Error(ERRORS.INSUFFICIENT_BALANCE);
        }
        
        console.log(`\nAdmin wallet balance: ${solBalance} SOL`);
        console.log(`Minimum required: ${NETWORK_CONFIG.MIN_SOL_BALANCE} SOL`);
        console.log('----------------------------------------\n');
    }
}

// Add mainnet confirmation function
async function confirmMainnetOperation(skipConfirmation: boolean = false): Promise<boolean> {
    if (skipConfirmation) {
        return true;
    }

    console.log('\n⚠️  MAINNET OPERATION WARNING ⚠️');
    console.log('You are about to perform operations on Solana Mainnet');
    console.log('This will use real SOL and cannot be undone\n');

    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        readline.question('Are you sure you want to proceed? (yes/no): ', (answer: string) => {
            readline.close();
            resolve(answer.toLowerCase() === 'yes');
        });
    });
}

// Add after imports
async function switchToMainnet(): Promise<void> {
    // Switch to mainnet
    execSync('solana config set --url mainnet-beta', { stdio: 'inherit' });
    
    // Verify the switch
    const config = execSync('solana config get', { encoding: 'utf8' });
    if (!config.includes('mainnet-beta')) {
        throw new Error('Failed to switch to mainnet');
    }
    
    console.log('\nSwitched to Solana Mainnet');
}

// Update createToken function to use mainnet
async function createToken(config: TokenConfig): Promise<void> {
    // Validate token details
    if (config.name.length < VALIDATION.MIN_NAME_LENGTH || config.name.length > VALIDATION.MAX_NAME_LENGTH) {
        throw new Error(`Token name must be between ${VALIDATION.MIN_NAME_LENGTH} and ${VALIDATION.MAX_NAME_LENGTH} characters`);
    }
    if (config.symbol.length < VALIDATION.MIN_SYMBOL_LENGTH || config.symbol.length > VALIDATION.MAX_SYMBOL_LENGTH) {
        throw new Error(`Token symbol must be between ${VALIDATION.MIN_SYMBOL_LENGTH} and ${VALIDATION.MAX_SYMBOL_LENGTH} characters`);
    }
    if (config.description.length > VALIDATION.MAX_DESCRIPTION_LENGTH) {
        throw new Error(`Description too long (max ${VALIDATION.MAX_DESCRIPTION_LENGTH} characters)`);
    }

    // Perform mainnet safety checks
    await checkMainnetSafety(config);

    console.log('Finding vanity address...');
    const { tokenAddress: expectedTokenAddress, seed, keypairJson } = await findVanityAddress(config);
    
    // Create keypair from JSON
    const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(keypairJson)));
    
    // For start patterns, use the keypair's public key directly
    const tokenAddress = config.position === 'start'
        ? keypair.publicKey
        : await PublicKey.createWithSeed(keypair.publicKey, seed, TOKEN_2022_PROGRAM_ID);
    
    // Verify the address matches what we found
    if (tokenAddress.toBase58() !== expectedTokenAddress) {
        throw new Error(`Token address mismatch! Expected ${expectedTokenAddress} but got ${tokenAddress.toBase58()}`);
    }
    
    // Save the keypair and seed info
    const keysDir = path.join(process.cwd(), 'token_keys');
    if (!fs.existsSync(keysDir)) {
        fs.mkdirSync(keysDir, { recursive: true });
    }
    
    // Save with token name
    const keypairPath = path.join(keysDir, `${config.name.toLowerCase().replace(/\s+/g, '')}_keys.json`);
    fs.writeFileSync(keypairPath, keypairJson);

    // Save seed information
    const seedsDir = path.join(process.cwd(), 'seeds');
    if (!fs.existsSync(seedsDir)) {
        fs.mkdirSync(seedsDir, { recursive: true });
    }
    const seedFile = path.join(seedsDir, 'token_seeds.json');
    let seedData = [];
    if (fs.existsSync(seedFile)) {
        seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
    }
    seedData.push({
        pattern: config.pattern,
        seed,
        tokenAddress: tokenAddress.toBase58(),
        name: config.name
    });
    fs.writeFileSync(seedFile, JSON.stringify(seedData, null, 2));

    // Fund the keypair
    await fundKeypair(keypairPath);

    // Create token with seed
    console.log('Initializing token...');
    const connection = new Connection(NETWORK_CONFIG.RPC_URL, NETWORK_CONFIG.COMMITMENT);
    
    // Calculate space needed for mint with metadata
    const space = getMintLen([ExtensionType.MetadataPointer]);
    const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(space);

    // Create transaction
    const transaction = new Transaction();
    
    // Get admin keypair for authorities
    const adminKeypairPath = getAdminKeypairPath();
    const adminKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(adminKeypairPath, 'utf8'))));
    
    if (config.position === 'end') {
        // Add instruction to create account with seed for end patterns
        transaction.add(
            SystemProgram.createAccountWithSeed({
                fromPubkey: keypair.publicKey,
                newAccountPubkey: tokenAddress,
                basePubkey: keypair.publicKey,
                seed: seed,
                lamports: rentExemptBalance,
                space: space,
                programId: TOKEN_2022_PROGRAM_ID
            })
        );
    } else {
        // For start patterns, create account directly using the keypair
        transaction.add(
            SystemProgram.createAccount({
                fromPubkey: keypair.publicKey,
                newAccountPubkey: tokenAddress,
                lamports: rentExemptBalance,
                space: space,
                programId: TOKEN_2022_PROGRAM_ID
            })
        );
    }

    // Add instruction to initialize metadata pointer FIRST
    transaction.add(
        createInitializeMetadataPointerInstruction(
            tokenAddress,
            keypair.publicKey,
            keypair.publicKey,
            TOKEN_2022_PROGRAM_ID
        )
    );

    // THEN add instruction to initialize mint
    transaction.add(
        createInitializeMintInstruction(
            tokenAddress,
            6, // decimals
            keypair.publicKey,
            keypair.publicKey,
            TOKEN_2022_PROGRAM_ID
        )
    );

    // Send and confirm transaction
    console.log('Sending transaction...');
    const signature = await connection.sendTransaction(transaction, [keypair]);
    await connection.confirmTransaction(signature);
    
    console.log(`Token created with signature: ${signature}`);
    console.log(`Token address: ${tokenAddress.toBase58()}`);

    // Add comments about authority transfers
    console.log('\n=== Transferring Token Authorities ===');
    console.log('This step is critical for token management:');
    console.log('1. Mint Authority: Controls token supply');
    console.log('2. Freeze Authority: Controls token freezing');
    console.log('Both authorities will be transferred to the admin wallet for secure management.');
    console.log('Current authorities: Token Keypair');
    console.log('New authorities: Admin Wallet');
    console.log('Admin wallet address:', adminKeypair.publicKey.toBase58());
    console.log('----------------------------------------\n');

    // Transfer mint authority to admin wallet
    console.log('Step 1: Transferring Mint Authority...');
    execSync(`spl-token authorize ${tokenAddress.toBase58()} mint ${adminKeypair.publicKey.toBase58()} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${keypairPath}" --owner "${keypairPath}" --url mainnet-beta`);
    console.log('✓ Mint authority transferred successfully');

    // Transfer freeze authority to admin wallet
    console.log('\nStep 2: Transferring Freeze Authority...');
    execSync(`spl-token authorize ${tokenAddress.toBase58()} freeze ${adminKeypair.publicKey.toBase58()} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${keypairPath}" --owner "${keypairPath}" --url mainnet-beta`);
    console.log('✓ Freeze authority transferred successfully');

    // Verify authorities were transferred correctly
    console.log('\nVerifying authority transfers...');
    const authorityVerifyResult = execSync(`spl-token display ${tokenAddress.toBase58()} --url mainnet-beta`, { encoding: 'utf8' });
    console.log(authorityVerifyResult);
    console.log('----------------------------------------\n');

    // Process image and create metadata
    console.log('=== Setting Up Token Metadata ===');
    let imageUrl: string | undefined;
    if (config.image) {
        console.log('Processing image...');
        imageUrl = await processImage(config.image);
        console.log('✓ Image processed:', imageUrl);
    }

    // Create metadata JSON
    console.log('\nPreparing metadata...');
    const metadata = {
        name: config.name,
        symbol: config.symbol,
        description: config.description,
        image: imageUrl
    };
    console.log('Metadata content:', JSON.stringify(metadata, null, 2));

    // Upload metadata to Arweave
    console.log('\nUploading metadata to Arweave...');
    const jwk = JSON.parse(fs.readFileSync(getAdminKeypairPath(), 'utf8'));
    const bundlr = new Bundlr(NETWORK_CONFIG.BUNDLR_NODE, 'solana', jwk);
    
    const metadataResponse = await bundlr.upload(JSON.stringify(metadata), {
        tags: [{ name: 'Content-Type', value: 'application/json' }]
    });
    
    const metadataUrl = `https://arweave.net/${metadataResponse.id}`;
    console.log('✓ Metadata uploaded:', metadataUrl);

    // Initialize metadata
    console.log('\nInitializing on-chain metadata...');
    execSync(`spl-token initialize-metadata ${tokenAddress.toBase58()} "${config.name}" "${config.symbol}" "${metadataUrl}" --url mainnet-beta --fee-payer "${adminKeypairPath}" --mint-authority "${adminKeypairPath}"`, { stdio: 'inherit' });
    console.log('✓ On-chain metadata initialized');
    console.log('----------------------------------------\n');

    // Create token account and mint initial supply if specified
    if (config.initialSupply) {
        console.log('=== Minting Initial Supply ===');
        
        // Create token account for admin wallet
        console.log('Step 1: Creating admin token account...');
        const adminPubkey = execSync(`solana-keygen pubkey ${adminKeypairPath}`, { encoding: 'utf8' }).trim();
        
        const accountResult = execSync(`spl-token create-account ${tokenAddress.toBase58()} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${adminKeypairPath}" --owner "${adminPubkey}" --url mainnet-beta`, {
            encoding: 'utf8'
        });
        const accountAddress = accountResult.match(/Creating account ([A-Za-z0-9]+)/)?.[1];
        
        if (!accountAddress) {
            throw new Error('Failed to extract token account address from output');
        }
        console.log('✓ Admin token account created:', accountAddress);

        // Mint tokens directly to admin account
        console.log(`\nStep 2: Minting ${config.initialSupply} tokens...`);
        execSync(`spl-token mint ${tokenAddress.toBase58()} ${config.initialSupply} ${accountAddress} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${adminKeypairPath}" --owner "${adminKeypairPath}" --url mainnet-beta`);
        console.log('✓ Tokens minted successfully');
        console.log('✓ Tokens minted directly to admin wallet:', adminPubkey);
        console.log('----------------------------------------\n');
    }

    console.log('=== Token Creation Summary ===');
    console.log(`Token mint address: ${tokenAddress.toBase58()}`);
    console.log(`Seed: ${seed}`);
    console.log(`Keypair saved to: ${keypairPath}`);
    console.log('Token creation completed successfully! 🎉\n');
}

interface MetadataUpdate {
    name?: string;
    symbol?: string;
    description?: string;
    image?: string;
}

interface TokenMetadata {
    name?: string;
    symbol?: string;
    description?: string;
    image?: string;
}

async function updateMetadata(tokenAddress: string, updates: MetadataUpdate): Promise<void> {
    try {
        // Load admin keypair
        const adminKeypairPath = getAdminKeypairPath();
        if (!fs.existsSync(adminKeypairPath)) {
            console.error('Admin keypair not found. Please run setup first.');
            process.exit(1);
        }

        const adminKeypair = Keypair.fromSecretKey(
            new Uint8Array(JSON.parse(fs.readFileSync(adminKeypairPath, 'utf8')))
        );

        // Check admin wallet balance
        const connection = new Connection(NETWORK_CONFIG.RPC_URL, NETWORK_CONFIG.COMMITMENT);
        const balance = await connection.getBalance(adminKeypair.publicKey);
        const solBalance = balance / 1e9;

        if (solBalance < NETWORK_CONFIG.MIN_SOL_BALANCE) {
            console.error(ERRORS.INSUFFICIENT_BALANCE);
            process.exit(1);
        }

        console.log('Admin wallet balance:', solBalance.toFixed(8), 'SOL');
        console.log('----------------------------------------\n');

        let imageUrl;
        if (updates.image) {
            const imagePath = path.resolve(updates.image);
            if (!fs.existsSync(imagePath)) {
                console.error('Image file not found:', updates.image);
                process.exit(1);
            }

            console.log('Uploading image to Arweave...');
            await ensureBundlrBalance(adminKeypair);
            imageUrl = await uploadMedia(imagePath, adminKeypair);
            console.log('Image uploaded:', imageUrl);
        }

        // Create metadata update
        const metadata: TokenMetadata = {
            name: updates.name,
            symbol: updates.symbol,
            description: updates.description,
            image: imageUrl
        };

        // Only include fields that were provided
        const updateMetadata: TokenMetadata = Object.fromEntries(
            Object.entries(metadata).filter(([_, v]) => v !== undefined)
        );

        if (Object.keys(updateMetadata).length === 0) {
            console.error('No update parameters provided. Use -n, -s, -d, or -i to specify updates.');
            process.exit(1);
        }

        console.log('Uploading metadata to Arweave...');
        const metadataUrl = await uploadMetadata(updateMetadata, adminKeypair);
        console.log('Metadata uploaded:', metadataUrl);

        console.log('Updating token metadata...');
        const updateCommand = `spl-token update-metadata ${tokenAddress} uri ${metadataUrl} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --url mainnet-beta --fee-payer ${adminKeypairPath}`;
        execSync(updateCommand, { stdio: 'inherit' });

        console.log('\n✨ Token metadata updated successfully!');
        console.log('View on Solscan:', `https://solscan.io/token/${tokenAddress}`);

    } catch (error: any) {
        console.error('Error updating metadata:', error?.message || error);
        process.exit(1);
    }
}

async function revokeAuthorities(tokenIdentifier: string): Promise<void> {
    try {
        let tokenAddress: string | null = null;

        // If tokenIdentifier is an address, use it directly
        if (tokenIdentifier.length === 44 || tokenIdentifier.length === 43) {
            tokenAddress = tokenIdentifier;
        } else {
            // Try to find token address by name in seeds
            const seedsFile = path.join(process.cwd(), 'seeds', 'token_seeds.json');
            if (fs.existsSync(seedsFile)) {
                const seedData = JSON.parse(fs.readFileSync(seedsFile, 'utf-8'));
                const tokenEntry = seedData.find((entry: any) => entry.name.toLowerCase() === tokenIdentifier.toLowerCase());
                if (tokenEntry) {
                    tokenAddress = tokenEntry.tokenAddress;
                }
            }
        }

        if (!tokenAddress) {
            throw new Error(`Could not find token address for ${tokenIdentifier}`);
        }

        // Use admin keypair for all operations
        const adminKeypairPath = getAdminKeypairPath();
        console.log(`Using admin keypair for revocation: ${adminKeypairPath}`);
        
        // Check admin wallet balance
        const balance = execSync(`solana balance ${adminKeypairPath} --url mainnet-beta`, { encoding: 'utf8' });
        const solBalance = parseFloat(balance);
        
        if (solBalance < NETWORK_CONFIG.MIN_SOL_BALANCE) {
            throw new Error(ERRORS.INSUFFICIENT_BALANCE);
        }
        
        console.log(`Admin wallet balance: ${solBalance} SOL`);
        console.log('----------------------------------------\n');
        
        const commonArgs = `--url mainnet-beta --fee-payer "${adminKeypairPath}" --owner "${adminKeypairPath}" --keypair "${adminKeypairPath}" --signer "${adminKeypairPath}" --signer-keypair "${adminKeypairPath}"`;
        
        console.log(`Revoking authorities for token: ${tokenAddress}`);
        console.log(MAINNET_WARNINGS.AUTHORITY);
        console.log('This action cannot be undone!\n');
        
        // First try to disable mint authority
        console.log('Disabling minting...');
        try {
            execSync(`spl-token authorize ${tokenAddress} mint --disable ${commonArgs}`, { stdio: 'inherit' });
            console.log('Mint authority disabled successfully');
        } catch (error) {
            console.log('Note: Mint authority may already be disabled');
        }
        
        // Then try to disable metadata authority
        console.log('Disabling metadata updates...');
        try {
            execSync(`spl-token authorize ${tokenAddress} metadata --disable ${commonArgs}`, { stdio: 'inherit' });
            console.log('Metadata authority disabled successfully');
        } catch (error) {
            console.log('Note: Metadata authority may already be disabled');
        }
        
        // Verify the changes
        console.log('\nVerifying authority changes...');
        const verifyResult = execSync(`spl-token display ${tokenAddress} --url mainnet-beta`, { encoding: 'utf8' });
        console.log(verifyResult);
        
        console.log('Token authorities revoked successfully!');
    } catch (error: any) {
        console.error('Error revoking authorities:', error?.message || error);
        process.exit(1);
    }
}

async function ensureBundlrBalance(adminKeypair: Keypair): Promise<void> {
    const bundlr = new Bundlr(NETWORK_CONFIG.BUNDLR_NODE, 'solana', adminKeypair);
    const balance = await bundlr.getLoadedBalance();
    const price = await bundlr.getPrice(1024 * 1024); // 1MB estimate
    
    if (balance.isLessThan(price)) {
        console.log('Funding Bundlr...');
        await bundlr.fund(price);
    }
}

async function uploadMedia(imagePath: string, adminKeypair: Keypair): Promise<string> {
    const bundlr = new Bundlr(NETWORK_CONFIG.BUNDLR_NODE, 'solana', adminKeypair);
    const ext = path.extname(imagePath).toLowerCase();
    const tags = [{ name: 'Content-Type', value: `image/${ext.slice(1)}` }];
    const response = await bundlr.uploadFile(imagePath, { tags });
    return `https://arweave.net/${response.id}`;
}

async function uploadMetadata(metadata: TokenMetadata, adminKeypair: Keypair): Promise<string> {
    const bundlr = new Bundlr(NETWORK_CONFIG.BUNDLR_NODE, 'solana', adminKeypair);
    const response = await bundlr.upload(JSON.stringify(metadata), {
        tags: [{ name: 'Content-Type', value: 'application/json' }]
    });
    return `https://arweave.net/${response.id}`;
}

program
    .name('token22')
    .description('Create and manage Token-2022 tokens with vanity addresses')
    .version('1.0.0')
    .option('--skip-confirmation', 'Skip mainnet confirmation prompt');

program
    .command('create')
    .description('Create a new token with a vanity address')
    .requiredOption('-p, --pattern <pattern>', 'pattern to search for')
    .requiredOption('--position <position>', 'pattern position: "start" (coming soon) or "end"')
    .requiredOption('-n, --name <name>', 'token name')
    .requiredOption('-s, --symbol <symbol>', 'token symbol')
    .requiredOption('-d, --description <description>', 'token description')
    .option('-i, --image <path>', 'image URL or local file path')
    .option('-m, --mint <amount>', 'initial supply to mint')
    .option('-g, --gpu', 'use GPU acceleration for end patterns (if available)')
    .option('-t, --threads <number>', 'number of CPU threads to use for end pattern search')
    .option('--case-insensitive', 'case insensitive pattern matching')
    .action((options) => {
        // Exit immediately for start pattern with just the message
        if (options.position === 'start') {
            console.log('\n🚧 Start pattern matching is coming soon! 🚧');
            console.log('Please use --position end for now.\n');
            process.exit(0);
        }

        // Switch to mainnet immediately
        execSync('solana config set --url mainnet-beta', { stdio: 'inherit' });
        console.log('\nSwitched to Solana Mainnet');

        // Wrap the async part in an async IIFE
        (async () => {
            try {
                // Get mainnet confirmation
                const skipConfirmation = program.opts().skipConfirmation;
                const proceed = await confirmMainnetOperation(skipConfirmation);
                if (!proceed) {
                    console.log('Operation cancelled');
                    process.exit(0);
                }

                const config: TokenConfig = {
                    pattern: options.pattern,
                    position: options.position,
                    name: options.name,
                    symbol: options.symbol,
                    description: options.description,
                    image: options.image,
                    initialSupply: options.mint ? parseInt(options.mint) : undefined,
                    useGpu: options.gpu,
                    threads: options.threads ? parseInt(options.threads) : undefined,
                    caseInsensitive: options.caseInsensitive
                };

                console.log('Token creation config:', config);
                await createToken(config);
            } catch (error: any) {
                console.error('Error creating token:', error?.message || error);
                process.exit(1);
            }
        })();
    });

program
    .command('update')
    .description('Update token metadata')
    .argument('<token-address>', 'token address')
    .option('-n, --name <name>', 'new token name')
    .option('-s, --symbol <symbol>', 'new token symbol')
    .option('-d, --description <description>', 'new token description')
    .option('-i, --image <path>', 'path to image file')
    .action(async (tokenAddress, options) => {
        try {
            await updateMetadata(tokenAddress, {
                name: options.name,
                symbol: options.symbol,
                description: options.description,
                image: options.image
            });
        } catch (error: any) {
            console.error('Error:', error?.message || error);
            process.exit(1);
        }
    });

program
    .command('revoke')
    .description('Revoke mint and metadata update authorities')
    .argument('<token-identifier>', 'token address or token name (e.g., "test" or full address)')
    .action(async (tokenIdentifier) => {
        try {
            // Switch to mainnet first
            await switchToMainnet();
            
            // Get mainnet confirmation
            const skipConfirmation = program.opts().skipConfirmation;
            const proceed = await confirmMainnetOperation(skipConfirmation);
            if (!proceed) {
                console.log('Operation cancelled');
                process.exit(0);
            }
            
            await revokeAuthorities(tokenIdentifier);
        } catch (error: any) {
            console.error('Error:', error?.message || error);
            process.exit(1);
        }
    });

program
    .command('mint')
    .description('Mint new tokens')
    .argument('<token-address>', 'token address')
    .argument('<amount>', 'amount to mint')
    .action(async (tokenAddress, amount) => {
        try {
            // Switch to mainnet first
            await switchToMainnet();
            
            // Get mainnet confirmation
            const skipConfirmation = program.opts().skipConfirmation;
            const proceed = await confirmMainnetOperation(skipConfirmation);
            if (!proceed) {
                console.log('Operation cancelled');
                process.exit(0);
            }

            // Use admin keypair for all operations
            const adminKeypairPath = getAdminKeypairPath();
            console.log(`Using admin keypair for minting: ${adminKeypairPath}`);
            
            // Check admin wallet balance
            const balance = execSync(`solana balance ${adminKeypairPath} --url mainnet-beta`, { encoding: 'utf8' });
            const solBalance = parseFloat(balance);
            
            if (solBalance < NETWORK_CONFIG.MIN_SOL_BALANCE) {
                throw new Error(ERRORS.INSUFFICIENT_BALANCE);
            }
            
            console.log(`Admin wallet balance: ${solBalance} SOL`);
            console.log('----------------------------------------\n');

            // Create token account if it doesn't exist
            console.log('Creating/verifying token account...');
            const adminPubkey = execSync(`solana-keygen pubkey ${adminKeypairPath}`, { encoding: 'utf8' }).trim();
            
            try {
                const accountResult = execSync(
                    `spl-token create-account ${tokenAddress} --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --url mainnet-beta --fee-payer "${adminKeypairPath}" --owner "${adminPubkey}"`,
                    { encoding: 'utf8' }
                );
                console.log('Token account created:', accountResult);
            } catch (error: any) {
                if (!error.message.includes('already exists')) {
                    throw error;
                }
                console.log('Token account already exists');
            }

            // Get token account address
            console.log('\nGetting token account address...');
            const accounts = execSync(
                `spl-token accounts ${tokenAddress} --owner ${adminPubkey} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`,
                { encoding: 'utf8' }
            );
            const accountLines = accounts.split('\n').filter(line => line.trim());
            const balanceLine = accountLines.find(line => /^\d+$/.test(line.trim()));
            if (!balanceLine) {
                throw new Error('No token account found for admin wallet');
            }

            // Get account address from verbose output
            const accountsVerbose = execSync(
                `spl-token accounts ${tokenAddress} --owner ${adminPubkey} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --verbose`,
                { encoding: 'utf8' }
            );
            const verboseLines = accountsVerbose.split('\n').filter(line => line.trim());
            const accountLine = verboseLines.find(line => line.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
            if (!accountLine) {
                throw new Error('Could not find token account address');
            }
            
            const accountAddress = accountLine.split(/\s+/)[1];
            console.log(`Token account: ${accountAddress}`);
            
            // Get current balance
            const currentBalance = balanceLine.trim();
            console.log(`Current balance: ${currentBalance} tokens`);

            if (parseInt(currentBalance) < parseInt(amount)) {
                throw new Error(`Insufficient token balance. Have ${currentBalance}, trying to burn ${amount}`);
            }

            // Mint tokens
            console.log(`\nMinting ${amount} tokens...`);
            execSync(
                `spl-token mint ${tokenAddress} ${amount} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${adminKeypairPath}" --owner "${adminKeypairPath}"`,
                { stdio: 'inherit' }
            );

            console.log('\n✨ Tokens minted successfully!');
            
            // Display updated supply
            console.log('\nUpdated token info:');
            execSync(
                `spl-token display ${tokenAddress} --url mainnet-beta`,
                { stdio: 'inherit' }
            );

        } catch (error: any) {
            console.error('Error minting tokens:', error?.message || error);
            process.exit(1);
        }
    });

program
    .command('burn')
    .description('Burn tokens from the admin wallet')
    .argument('<token-identifier>', 'token address or token name')
    .argument('<amount>', 'amount of tokens to burn')
    .action(async (tokenIdentifier, amount) => {
        try {
            // Switch to mainnet first
            await switchToMainnet();
            
            // Get mainnet confirmation
            const skipConfirmation = program.opts().skipConfirmation;
            const proceed = await confirmMainnetOperation(skipConfirmation);
            if (!proceed) {
                console.log('Operation cancelled');
                process.exit(0);
            }

            // Resolve token address if name was provided
            let tokenAddress = tokenIdentifier;
            if (tokenIdentifier.length !== 44 && tokenIdentifier.length !== 43) {
                // Try to find token address by name in seeds
                const seedsFile = path.join(process.cwd(), 'seeds', 'token_seeds.json');
                if (fs.existsSync(seedsFile)) {
                    const seedData = JSON.parse(fs.readFileSync(seedsFile, 'utf-8'));
                    const tokenEntry = seedData.find((entry: any) => 
                        entry.name.toLowerCase() === tokenIdentifier.toLowerCase()
                    );
                    if (tokenEntry) {
                        tokenAddress = tokenEntry.tokenAddress;
                        console.log(`Resolved token name "${tokenIdentifier}" to address: ${tokenAddress}`);
                    } else {
                        throw new Error(`Could not find token address for name: ${tokenIdentifier}`);
                    }
                } else {
                    throw new Error('Token seeds file not found');
                }
            }

            // Get admin wallet info
            const adminKeypairPath = getAdminKeypairPath();
            const adminPubkey = execSync(`solana-keygen pubkey "${adminKeypairPath}"`, { encoding: 'utf8' }).trim();
            console.log(`Using admin wallet: ${adminPubkey}`);

            // Check admin wallet balance and get account address
            console.log('\nChecking admin wallet token balance...');
            const accountsDetail = execSync(
                `spl-token accounts ${tokenAddress} --owner ${adminPubkey} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`,
                { encoding: 'utf8' }
            );
            
            // Parse account address and balance
            const lines = accountsDetail.split('\n').filter(line => line.trim());
            const balanceLine = lines.find(line => /^\d+$/.test(line.trim()));
            if (!balanceLine) {
                throw new Error('Could not find token balance');
            }
            
            const currentBalance = balanceLine.trim();
            console.log(`Current balance: ${currentBalance} tokens`);

            if (parseInt(currentBalance) < parseInt(amount)) {
                throw new Error(`Insufficient token balance. Have ${currentBalance}, trying to burn ${amount}`);
            }

            // Get token account address
            const accountsVerbose = execSync(
                `spl-token accounts ${tokenAddress} --owner ${adminPubkey} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --verbose`,
                { encoding: 'utf8' }
            );
            
            const accountLines = accountsVerbose.split('\n').filter(line => line.trim());
            const accountLine = accountLines.find(line => line.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
            if (!accountLine) {
                throw new Error('Could not find token account address');
            }
            
            const accountAddress = accountLine.split(/\s+/)[1];
            console.log(`Token account: ${accountAddress}`);

            // Burn tokens
            console.log(`\nBurning ${amount} tokens from admin wallet...`);
            execSync(
                `spl-token burn ${accountAddress} ${amount} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --fee-payer "${adminKeypairPath}" --owner "${adminKeypairPath}"`,
                { stdio: 'inherit' }
            );

            console.log('\n🔥 Tokens burned successfully!');
            
            // Display updated supply
            console.log('\nUpdated token info:');
            execSync(
                `spl-token display ${tokenAddress} --url mainnet-beta --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`,
                { stdio: 'inherit' }
            );

        } catch (error: any) {
            console.error('Error burning tokens:', error?.message || error);
            process.exit(1);
        }
    });

program.parse(); 
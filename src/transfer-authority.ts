#!/usr/bin/env node
import { Command } from 'commander';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { 
    TOKEN_2022_PROGRAM_ID,
    createInitializeMetadataPointerInstruction,
    ExtensionType,
    getMintLen,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createSetAuthorityInstruction,
    AuthorityType,
    getMetadataPointerState
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getAdminKeypairPath(): string {
    return path.join(process.cwd(), 'admin', 'admin_keypair.json');
}

async function transferMetadataAuthority(tokenAddress: string): Promise<void> {
    try {
        // Connect to devnet
        const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

        // Load admin keypair
        const adminKeypairPath = getAdminKeypairPath();
        const adminKeypair = Keypair.fromSecretKey(
            new Uint8Array(JSON.parse(fs.readFileSync(adminKeypairPath, 'utf8')))
        );

        // Load current metadata authority (Solana config wallet)
        const currentAuthorityKeypair = Keypair.fromSecretKey(
            new Uint8Array(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf8')))
        );

        // Create transaction
        const transaction = new Transaction();

        // Add instruction to update metadata authority
        transaction.add(
            createSetAuthorityInstruction(
                new PublicKey(tokenAddress), // token account
                currentAuthorityKeypair.publicKey, // current authority
                AuthorityType.MetadataPointer, // authority type for metadata
                adminKeypair.publicKey, // new authority
                [], // no additional signers needed
                TOKEN_2022_PROGRAM_ID
            )
        );

        // Send and confirm transaction
        console.log('Sending transaction to transfer metadata authority...');
        console.log('Current authority:', currentAuthorityKeypair.publicKey.toBase58());
        console.log('New authority:', adminKeypair.publicKey.toBase58());
        
        const signature = await connection.sendTransaction(
            transaction,
            [currentAuthorityKeypair], // current authority needs to sign
            {
                preflightCommitment: 'confirmed'
            }
        );
        await connection.confirmTransaction(signature);

        console.log('Successfully transferred metadata authority to admin wallet');
        console.log('Transaction signature:', signature);
        console.log('New metadata authority:', adminKeypair.publicKey.toBase58());

    } catch (error: any) {
        console.error('Error transferring metadata authority:', error?.message || error);
        process.exit(1);
    }
}

// Set up CLI command
const program = new Command();

program
    .name('transfer-authority')
    .description('Transfer token metadata authority to admin wallet')
    .argument('<token-address>', 'Token mint address')
    .action(async (tokenAddress) => {
        await transferMetadataAuthority(tokenAddress);
    });

program.parse(); 
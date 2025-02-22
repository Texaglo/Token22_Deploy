export const NETWORK_CONFIG = {
    RPC_URL: 'https://api.mainnet-beta.solana.com',
    COMMITMENT: 'confirmed' as const,
    TOKEN_PROGRAM_ID: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    BUNDLR_NODE: 'https://node1.bundlr.network',
    MIN_SOL_BALANCE: 0.05, // Minimum SOL needed for token operations on mainnet
    METADATA_UPLOAD_COST: 0.01, // Approximate cost for metadata upload
    SAFETY_CHECKS: {
        CONFIRM_MAINNET: true, // Require explicit confirmation for mainnet operations
        CHECK_BALANCE: true, // Check if wallet has sufficient balance
        VERIFY_AUTHORITIES: true, // Verify authority transfers
    }
};

// Network-specific warning messages
export const MAINNET_WARNINGS = {
    COST: 'Creating a token on mainnet requires real SOL. Please ensure you have sufficient funds.',
    IRREVERSIBLE: 'Token creation on mainnet is irreversible. Please verify all details before proceeding.',
    AUTHORITY: 'Authority transfers on mainnet are permanent. Double-check all addresses.',
};

// Validation thresholds
export const VALIDATION = {
    MIN_NAME_LENGTH: 3,
    MAX_NAME_LENGTH: 32,
    MIN_SYMBOL_LENGTH: 2,
    MAX_SYMBOL_LENGTH: 10,
    MAX_DESCRIPTION_LENGTH: 1000,
};

// Error messages
export const ERRORS = {
    INSUFFICIENT_BALANCE: 'Insufficient SOL balance for token creation on mainnet',
    INVALID_ADMIN: 'Admin wallet not properly configured',
    NETWORK_ERROR: 'Failed to connect to Solana mainnet',
    BUNDLR_ERROR: 'Failed to upload metadata to Arweave',
    AUTHORITY_ERROR: 'Failed to transfer token authorities',
}; 
# Token22 Vanity Token Creator

A powerful CLI tool for creating SPL Token-2022 tokens with vanity addresses and metadata.

## Features

- Create SPL Token-2022 tokens with vanity addresses
  - High-performance end pattern matching using Rust implementation
  - Start pattern matching (🚧 Coming Soon - Community Contribution Welcome!)
  - Case-sensitive and case-insensitive pattern matching
  - GPU acceleration for end pattern matching (on supported systems)
- Automatic metadata initialization
  - Support for custom metadata
  - Arweave storage for metadata
- Secure keypair management
- Multi-threaded CPU search
- Progress tracking and performance metrics
- Supports both Devnet and Mainnet
- Trading bot for supply management

## Trading Bot Configuration

The trading bot manages token supply through controlled expansion and contraction phases:

### Supply Management Parameters
- Maximum Supply: 100 million tokens
- Admin Buffer: 20% above community balance
- Expansion Trigger: When supply falls 10% below target
- Decimals: 6 (all amounts multiplied by 10^6)

### Phase Switching Logic
1. **Expansion → Contraction**
   - Triggers when total supply reaches 100M tokens
   - Aims to reduce supply while maintaining price stability

2. **Contraction → Expansion**
   - Triggers when supply falls below target threshold
   - Target = Community Balance + (Community Balance × 20%)
   - Expansion starts when supply < (Target × 0.9)

### Trading Amounts

#### Expansion Phase
- Mint Amount: Previous mint × 1.2 (20% increase)
- Burn Amount: 20% of minted amount
- Maximum Mint: 2M tokens per operation
- Net Expansion: ~16% per cycle

#### Contraction Phase
- Burn Amount: 15% of excess supply or admin balance (whichever is lower)
- Mint Amount: 80% of burned amount
- Net Contraction: ~3% per cycle

### Safety Features
- Minimum SOL balance checks
- Transaction retry logic
- Error handling and logging
- Automatic state recovery
- Dynamic target calculation based on community balance

## Prerequisites

1. Node.js and npm installed
2. Solana CLI tools installed
3. Rust toolchain installed (for GPU acceleration)
4. A funded Solana wallet (for transaction fees)

## Cost Considerations

### Devnet
- Token creation requires approximately 0.01 SOL per token
- SOL can be obtained from the devnet faucet

### Mainnet
- Token creation requires approximately 0.01 SOL per token
- Additional costs for Arweave metadata storage
- Ensure your wallet has sufficient SOL before creating tokens

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/token22
cd token22

# Install dependencies
npm install

# Build the project
npm run build

# Configure network (devnet by default)
solana config set --url devnet  # for testing
solana config set --url mainnet-beta  # for production
```

## Usage

### Creating a Token

```bash
# Create a token with address ending with "gems"
texaglo create --pattern gems --position end --name "Gems Token" --symbol "GEMS" --description "A token ending in gems" --mint 1000000

# Use GPU acceleration (if available)
texaglo create --pattern dao --position end --name "DAO Token" --symbol "DAO" --description "A DAO token" --gpu

# Case insensitive search
texaglo create --pattern COOL --position end --name "Cool Token" --symbol "COOL" --description "A cool token" --case-insensitive
```

### Managing Token Supply

```bash
# Start the trading bot
node src/trading-bot.js

# Monitor supply
texaglo supply <token-address>

# Manual operations if needed
texaglo mint <token-address> <amount>
texaglo burn <token-address> <amount>
```

### Updating Metadata

```bash
# Update token metadata
texaglo update <token-address> -n "New Name" -s "NEW" -d "New description" -i path/to/image.png

# Revoke update authority (makes token immutable)
texaglo revoke <token-address>
```

## Performance

The tool uses optimized Rust implementation for end pattern matching:
- Multi-threaded CPU search
- GPU acceleration on supported systems (Metal on macOS)
- Optimized batch processing

Typical Performance for End Patterns:
- 3-letter pattern: 1-3 seconds
- 4-letter pattern: 5-10 seconds
- 5-letter pattern: 15-30 seconds
- 6-letter pattern: 30-120 seconds

## Known Issues & Future Improvements

### Start Pattern Matching (🚧 Coming Soon)
The start pattern matching functionality is currently under development. This is a great opportunity for community contribution! The implementation would involve:
- Optimizing the Solana CLI's vanity address generation for token addresses
- Integrating with Token-2022 program requirements
- Maintaining the same performance standards as end pattern matching

If you'd like to contribute to this feature, please check the issues section or submit a pull request.

## Security

- Keypairs are stored securely in the `token_keys` directory
- Each token gets its own keypair file
- Metadata update authority can be revoked after creation
- No sensitive data is logged or exposed
- Admin wallet required for token management
- Automatic authority transfers to admin wallet

## Directory Structure

```
token22/
├── src/              # TypeScript source files
├── token_keys/       # Generated keypair files
├── admin/           # Admin wallet directory
├── target/          # Compiled Rust binaries
└── dist/            # Compiled TypeScript files
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

### Priority Areas for Contribution
1. Start Pattern Matching Implementation
2. Additional GPU Optimizations
3. Enhanced Error Handling
4. Testing Framework
5. Network Configuration Management

## Troubleshooting

### Common Issues
1. Insufficient SOL balance
   - Ensure admin wallet has at least 0.01 SOL for token creation
   - Use `solana balance` to check wallet balance
   - Request airdrop on devnet or fund wallet on mainnet

2. Authority Transfer Failures
   - Verify admin wallet configuration
   - Check SOL balance for transaction fees
   - Ensure proper network configuration

3. Metadata Storage Issues
   - Check Arweave connection
   - Verify metadata format
   - Ensure proper funding for storage

## Token Metadata Management

### Updating Token Metadata
To update the token's metadata:

1. Upload media to Arweave:
```bash
node upload.js
```

2. If you encounter errors:
- Ensure you're using the correct update authority wallet
- Check if metadata extension is initialized
- Verify Bundlr balance with `node check_balance.js`
- Note: Some block explorers may not display Token-2022 metadata immediately

### Troubleshooting Metadata Updates
- Error 0x35c2b5c0: Check update authority permissions
- Error 0x35c2b5bf: Metadata already initialized
- To verify metadata on-chain: `solana account <TOKEN_ADDRESS>`

## License

ISC License
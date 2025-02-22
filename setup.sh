#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print step headers
print_step() {
    echo -e "\n${BLUE}Step $1: $2${NC}"
    echo "----------------------------------------"
}

# Function to check command success
check_success() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Success${NC}"
    else
        echo -e "${RED}✗ Failed${NC}"
        exit 1
    fi
}

echo -e "${GREEN}Mac Vanity Token Generator Setup${NC}"
echo "=============================="
echo "This script will set up everything needed for the token generator."
echo "Please make sure you have an internet connection and Homebrew installed."
echo

# Check for Homebrew
if ! command -v brew &> /dev/null; then
    echo -e "${RED}Error: Homebrew is required${NC}"
    echo "Please install Homebrew first: https://brew.sh"
    echo "Run this command:"
    echo "/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    exit 1
fi

# Clean existing installations
print_step "1" "Cleaning existing installations"
rm -rf node_modules dist target ~/.cargo ~/.rustup ~/.local/share/solana ~/.solana 2>/dev/null
npm uninstall -g texaglo 2>/dev/null
check_success

# Install Rust
print_step "2" "Installing Rust"
echo -e "${YELLOW}Installing Rust toolchain...${NC}"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
check_success

# Install Node.js
print_step "3" "Installing Node.js"
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Installing Node.js...${NC}"
    brew install node
else
    echo -e "${GREEN}✓ Node.js is already installed${NC}"
fi
check_success

# Install Solana CLI
print_step "4" "Installing Solana CLI"
echo -e "${YELLOW}Installing Solana CLI...${NC}"
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Add Solana to path for both bash and zsh
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.zshrc
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
source ~/.zshrc 2>/dev/null || source ~/.bashrc
check_success

# Configure Solana for devnet
print_step "5" "Configuring Solana for devnet"
solana config set --url devnet
check_success

# Create directories and build
print_step "6" "Setting up project"
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p admin token_keys seeds
check_success

# Install npm dependencies and build
echo -e "${YELLOW}Installing npm dependencies...${NC}"
npm install
check_success

# Install CLI globally
print_step "7" "Installing CLI globally"
echo -e "${YELLOW}Installing Texaglo CLI globally...${NC}"
npm install -g .
check_success

# Create admin wallet
print_step "8" "Creating admin wallet"
echo -e "${YELLOW}Creating new admin wallet...${NC}"
solana-keygen new --no-bip39-passphrase --force -o admin/admin_keypair.json
ADMIN_ADDRESS=$(solana-keygen pubkey admin/admin_keypair.json)
echo -e "${GREEN}✓ Admin wallet created: ${ADMIN_ADDRESS}${NC}"
check_success

# Fund admin wallet
print_step "9" "Funding admin wallet"
echo -e "${YELLOW}Requesting airdrop...${NC}"
solana airdrop 1 "$ADMIN_ADDRESS" --url devnet
sleep 2
BALANCE=$(solana balance "$ADMIN_ADDRESS" --url devnet)
echo -e "${GREEN}✓ Wallet funded with ${BALANCE} SOL${NC}"
check_success

echo
echo -e "${GREEN}Setup complete! 🎉${NC}"
echo
echo -e "Your admin wallet address is: ${YELLOW}${ADMIN_ADDRESS}${NC}"
echo -e "Current balance: ${YELLOW}${BALANCE} SOL${NC}"
echo
echo "You can now create tokens using the global command:"
echo -e "${BLUE}texaglo create --pattern <pattern> --position <start|end> --name \"Token Name\" --symbol \"SYMBOL\" --description \"Description\"${NC}"
echo
echo "Example:"
echo -e "${YELLOW}texaglo create --pattern test --position end --name \"Test Token\" --symbol \"TEST\" --description \"My first vanity token\" --mint 1000000${NC}"
echo
echo -e "${GREEN}The CLI is now installed globally. You can use the 'texaglo' command from anywhere!${NC}" 
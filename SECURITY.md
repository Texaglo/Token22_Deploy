# Security Policy

## Supported Versions

Currently supported versions for security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security Considerations

This software handles token creation and management on the Solana blockchain. Please be aware of the following security considerations:

1. **Key Management**
   - Private keys are generated locally and stored in the `token_keys` directory
   - Never share or commit your private keys
   - Always backup your keys securely
   - The `token_keys` directory is git-ignored by default

2. **Network Security**
   - The software interacts with Solana's network
   - Always verify you're connecting to the correct network (mainnet/devnet)
   - Check transaction details before signing
   - Monitor your SOL balance for token operations

3. **Local Security**
   - Keep your system and dependencies up to date
   - Use secure and unique passwords for your Solana wallets
   - Enable firewall and maintain updated antivirus software
   - Be cautious when running scripts or commands from unknown sources

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security vulnerability within Token22 Vanity, please follow these steps:

1. **Do Not** disclose the vulnerability publicly
2. **Do Not** create a public GitHub issue
3. Send a detailed report to security@texaglo.com including:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will acknowledge receipt of your report within 48 hours and provide a detailed response within 72 hours, including:
- Confirmation of the vulnerability
- Our plans for addressing it
- Any potential workarounds

## Best Practices

1. **Before Running**
   - Verify the authenticity of the source code
   - Review the code and dependencies
   - Use a dedicated wallet for testing
   - Start with small amounts on devnet

2. **During Operation**
   - Monitor all transactions
   - Keep your seed phrases secure
   - Regularly check for updates
   - Follow security announcements

3. **After Usage**
   - Securely store or delete generated keys
   - Clear cached data if necessary
   - Monitor your wallet activity

## Updates and Patches

- Security updates will be released as soon as possible
- Updates will be signed and verified
- Release notes will detail security-relevant changes
- Follow our GitHub repository for security announcements

## Contact

For security-related inquiries, contact:
- Email: security@texaglo.com
- GitHub: Create a security advisory through the repository's Security tab

## Acknowledgments

We appreciate the security research community's efforts in responsibly disclosing vulnerabilities. Security researchers who report valid vulnerabilities will be acknowledged (with permission) in our security advisories. 
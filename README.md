# Fiftyten CLI Tools

[![Publish Status](https://github.com/5010-dev/fiftyten-cli-tools/workflows/Publish%20CLI%20Tools/badge.svg)](https://github.com/5010-dev/fiftyten-cli-tools/actions)
[![npm version](https://badge.fury.io/js/%40fiftyten%2Fdb-toolkit.svg)](https://badge.fury.io/js/%40fiftyten%2Fdb-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8.0.0-blue.svg)](https://pnpm.io/)

A collection of command-line tools for the Fiftyten platform, designed to improve developer experience and operational efficiency.

## 🚀 Tools Available

### [@fiftyten/db-toolkit](./packages/db-toolkit)
Complete database toolkit: connections, migration, and operations via AWS Session Manager.

**Quick Start:**
```bash
# 1. Install prerequisites (one-time setup)
brew install --cask session-manager-plugin
brew install postgresql awscli

# 2. Install globally (pnpm - team standard)
pnpm add -g @fiftyten/db-toolkit

# 3. Database connections
fiftyten-db psql dev -d indicator

# 4. DynamoDB operations (sensitive fields always hidden)
fiftyten-db dynamo list-tables
fiftyten-db dynamo scan trading_orders --limit 10

# 5. Database migration (full migration with AWS DMS)
fiftyten-db migrate deploy dev
fiftyten-db migrate start dev
```

## 📦 Installation

### Prerequisites

**Required dependencies:**
```bash
# 1. AWS Session Manager plugin (required for tunnel connections)
brew install --cask session-manager-plugin

# 2. PostgreSQL client (for database connections)
brew install postgresql

# 3. AWS CLI (if not already installed)
brew install awscli
```

### Global Installation (Recommended)

#### With pnpm (Team Standard)
```bash
pnpm add -g @fiftyten/db-toolkit
```

#### With npm
```bash
npm install -g @fiftyten/db-toolkit
```

### Quick Setup Verification
```bash
# Test that everything is installed correctly
fiftyten-db --version
session-manager-plugin
psql --version
aws --version
```

### One-time Usage (No Installation)

#### With pnpm
```bash
# Database connections
pnpm dlx @fiftyten/db-toolkit psql dev -d platform
pnpm dlx @fiftyten/db-toolkit tunnel dev -d platform

# DynamoDB operations
pnpm dlx @fiftyten/db-toolkit dynamo list-tables
pnpm dlx @fiftyten/db-toolkit dynamo scan trading_orders --limit 10
```

#### With npm
```bash
# Database connections
npx @fiftyten/db-toolkit psql dev -d platform
npx @fiftyten/db-toolkit tunnel dev -d platform

# DynamoDB operations
npx @fiftyten/db-toolkit dynamo list-tables
npx @fiftyten/db-toolkit dynamo scan trading_orders --limit 10
```

## 🏗️ Development

This is a monorepo using pnpm workspaces.

### Setup
```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Working with Packages
```bash
# Install dependencies for specific package
pnpm --filter db-toolkit install

# Build specific package
pnpm --filter db-toolkit build

# Run specific package
pnpm --filter db-toolkit dev
```

### Adding New Tools
```bash
# Create new package
mkdir packages/new-tool
cd packages/new-tool
npm init -y

# Add to workspace (automatic with pnpm)
```

## 📋 Tool Guidelines

### Package Structure
```
packages/your-tool/
├── package.json        # Package configuration
├── tsconfig.json       # TypeScript configuration
├── README.md          # Tool documentation
├── bin/               # Executable files
├── src/               # Source code
└── dist/              # Compiled output (gitignored)
```

### Naming Convention
- **Package name**: `@fiftyten/tool-name`
- **Binary name**: `fiftyten-tool` or descriptive name
- **Repository folder**: `tool-name`

### Requirements
- **TypeScript**: All tools must be written in TypeScript
- **Tests**: Include comprehensive tests
- **Documentation**: Clear README with examples
- **CLI Standards**: Follow common CLI patterns (help, version, etc.)

## 🔐 Security

- All tools must follow security best practices
- Use AWS SDK v3 for AWS integrations
- Never hardcode credentials or sensitive data
- Support AWS credential chain (IAM roles, profiles, etc.)

## 🚀 Publishing

Packages are automatically published to npm when:
- Changes are merged to `main` branch
- Package version is bumped
- GitHub Actions CI passes

### Manual Publishing
```bash
# Publish all changed packages
pnpm publish-packages

# Publish specific package
pnpm --filter package-name publish --access public
```

## 🎯 Usage Examples

### Database Connections

#### One-Command Connection (Recommended)
```bash
# Connect to indicator database with automatic password
fiftyten-db psql dev -d indicator

# Connect to copy trading database  
fiftyten-db psql dev -d copytrading

# Use different port if needed
fiftyten-db psql dev -d indicator -p 5433
```

#### Database Discovery
```bash
# See what databases are available
fiftyten-db databases dev
```

#### Manual Tunnel Commands (Advanced)
```bash
# Create tunnel to indicator database
fiftyten-db tunnel dev -d indicator

# Connect directly to copytrading database
fiftyten-db connect main -d copytrading

# SSH into bastion host
fiftyten-db ssh dev

# Show connection information
fiftyten-db info dev

# List all available environments
fiftyten-db list
```

### Database Migration

Complete database migration using AWS DMS with full-load + change data capture (CDC).

#### Migration Workflow
```bash
# 1. Deploy migration infrastructure (prompts for legacy DB details)
fiftyten-db migrate deploy dev

# 2. Start full migration (full-load + CDC)
fiftyten-db migrate start dev

# 3. Monitor progress
fiftyten-db migrate status dev

# 4. Validate migration data
fiftyten-db migrate validate dev

# 5. Stop migration when ready for cutover
fiftyten-db migrate stop dev

# 6. Cleanup resources after successful migration
fiftyten-db migrate cleanup dev
```

#### Migration Features
- **Full Load**: Migrates all existing data from legacy database
- **Change Data Capture (CDC)**: Real-time replication of ongoing changes
- **Progress Monitoring**: Table-by-table statistics and error tracking
- **Data Validation**: Comprehensive validation with recommendations
- **Security**: Legacy credentials never stored, uses Secrets Manager for target

### DynamoDB Operations

#### Table Discovery
```bash
# List all DynamoDB tables
fiftyten-db dynamo list-tables

# Describe table structure and keys
fiftyten-db dynamo describe fiftyten-exchange-credentials-dev
```

#### Data Operations (Sensitive Fields Always Hidden)
```bash
# Scan recent trading orders
fiftyten-db dynamo scan trading_orders --limit 10

# Query all credentials for tenant 5010
fiftyten-db dynamo query fiftyten-exchange-credentials-dev "tenant_id = 5010"

# Get specific item (composite key)
fiftyten-db dynamo get-item fiftyten-exchange-credentials-dev \
  '{"tenant_id":"5010","credential_sk":"USER#john_doe_123#PRODUCT#COPY_TRADING#EXCHANGE#gateio"}'

# Get trading order details
fiftyten-db dynamo get-item trading_orders "id:trd_5f8a2b3c4d5e6f7g8h9i"
```

### Team Workflow
```bash
# 1. Install once globally with pnpm
pnpm add -g @fiftyten/db-toolkit

# 2. One command for complete database access (recommended)
fiftyten-db psql dev -d indicator

# Alternative: Manual tunnel approach
# 2a. Create tunnel (will prompt for MFA if required)
fiftyten-db tunnel dev -d indicator
# 2b. In another terminal, use psql
psql -h localhost -p 5433 -d indicator_db -U fiftyten
```

### MFA Authentication

The CLI tool automatically handles MFA authentication when required:

#### Auto-Discovery (New in v1.2.0!)
```bash
# When MFA is required, the tool auto-discovers your MFA device:
🔐 MFA authentication required
✅ Auto-detected MFA device: arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra
? Enter MFA token code: 123456

✅ MFA authentication successful!
Session expires: 12/31/2023, 2:00:00 PM
```

#### Multiple Devices
```bash
# If you have multiple MFA devices:
🔐 MFA authentication required
Multiple MFA devices found. Please select one:

? Select MFA Device: 
❯ ED_GalaxyS24_Ultra (arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra)
  backup-device (arn:aws:iam::ACCOUNT:mfa/backup-device)
```

#### Manual Entry (Fallback)
```bash
# If auto-discovery fails:
🔐 MFA authentication required
Could not auto-discover MFA devices, using fallback detection
? MFA Device Serial Number: arn:aws:iam::ACCOUNT:mfa/device-name
? Enter MFA token code: 123456
```

**Key Features:**
- 🚀 **One-Command Connection**: `fiftyten-db psql dev -d indicator` - tunnel + password + psql automatically
- 🔍 **Multi-Database Support**: Connect to indicator, copytrading, or any configured database
- 📦 **Database Migration**: Full migration with AWS DMS (full-load + CDC)
- 🗂️ **DynamoDB Operations**: List, scan, query, and get items with built-in security
- 🔒 **Security-First Design**: Sensitive fields (API keys, secrets) always hidden
- 🔍 **Database Discovery**: `fiftyten-db databases dev` to see what's available
- 🔐 **Smart MFA Handling**: Auto-discovers MFA devices with single prompt
- 🎯 **Single Device Auto-Selection** for seamless experience  
- 📋 **Multiple Device Selection** with friendly device names when needed
- 🔒 **Secure Session Token** handling (no role assumption needed)
- ⏰ **Session Management** with automatic expiration
- 🔄 **Automatic Password Retrieval** from AWS Secrets Manager
- 🛡️ **Enterprise Security**: Session Manager + MFA + Secrets Manager integration

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Workflow
1. **Issues First**: Create an issue before starting work
2. **Small PRs**: Keep pull requests focused and small
3. **Tests Required**: All new features must include tests
4. **Documentation**: Update documentation for user-facing changes

## 📊 Available Tools

| Tool | Description | Status | Version |
|------|-------------|--------|---------|
| [db-toolkit](./packages/db-toolkit) | Complete database toolkit: connections, migration, operations | ✅ Active | 1.9.0 |
| monitoring-cli | Infrastructure monitoring tools | 🚧 Planned | - |
| deployment-helper | Deployment utilities | 🚧 Planned | - |

## 🆘 Support

### Common Issues & Solutions

**"Error starting tunnel: No such file or directory"**
```bash
# Install Session Manager plugin
brew install --cask session-manager-plugin
```

**"psql: command not found"**
```bash
# Install PostgreSQL client
brew install postgresql
```

**"Port 5432 is already in use"**
```bash
# The CLI will automatically suggest solutions, or use a different port
fiftyten-db psql dev -d indicator -p 5433
```

**"MFA authentication required"**
- This is normal! The CLI will guide you through MFA setup
- Make sure your AWS credentials are configured: `aws configure`

**"Access denied" errors**
- Check that you have the required IAM permissions (see infrastructure documentation)
- Ensure MFA device is properly configured

### Getting Help

- **Documentation**: Check individual tool READMEs
- **Issues**: [GitHub Issues](https://github.com/5010-dev/fiftyten-cli-tools/issues)
- **Discussions**: [GitHub Discussions](https://github.com/5010-dev/fiftyten-cli-tools/discussions)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Related Projects

- [5010-indicator](https://github.com/5010-dev/5010-indicator) - Main platform
- [5010-indicator-storage-infra](https://github.com/5010-dev/5010-indicator-storage-infra) - Storage infrastructure
- [indicator-ecs-infra](https://github.com/5010-dev/indicator-ecs-infra) - ECS infrastructure
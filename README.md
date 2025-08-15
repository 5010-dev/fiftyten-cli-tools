# Fiftyten CLI Tools

[![Publish Status](https://github.com/5010-dev/fiftyten-cli-tools/workflows/Publish%20CLI%20Tools/badge.svg)](https://github.com/5010-dev/fiftyten-cli-tools/actions)
[![npm version](https://img.shields.io/npm/v/@fiftyten/db-toolkit.svg)](https://www.npmjs.com/package/@fiftyten/db-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D8.0.0-blue.svg)](https://pnpm.io/)

A comprehensive command-line toolkit for the Fiftyten platform ecosystem, providing secure database connectivity, AWS DMS migrations, DynamoDB operations, and infrastructure management through integrated AWS services.

## 🚀 Tools Available

### [@fiftyten/db-toolkit](./packages/db-toolkit)
Complete database toolkit with standalone AWS DMS migrations, secure database connectivity via Session Manager, DynamoDB operations, and infrastructure management. Current version: **v2.3.0**

**Core Capabilities:**
- **Database Connectivity**: Secure connections via AWS Session Manager with automatic MFA and password management
- **AWS DMS Migrations**: Complete database migration system with embedded CloudFormation templates
- **DynamoDB Operations**: Table management and data operations with built-in security filtering
- **Infrastructure Management**: VPC/subnet auto-discovery, security group configuration, and CloudFormation deployment
- **Security & Compliance**: MFA authentication, credential management, and audit trail support

**Quick Start:**
```bash
# 1. Install prerequisites (one-time setup)
brew install --cask session-manager-plugin
brew install postgresql awscli

# 2. Install globally 
pnpm add -g @fiftyten/db-toolkit

# 3. Apply IAM permissions (one-time)
# Attach DMSMigrationDeploymentAccess policy to your AWS user/group

# 4. Database connections
fiftyten-db psql dev -d indicator

# 5. DynamoDB operations (sensitive fields auto-filtered)
fiftyten-db dynamo list-tables
fiftyten-db dynamo scan trading_orders --limit 10

# 6. Database migration options
# PostgreSQL migration (recommended for PostgreSQL-to-PostgreSQL)
fiftyten-db migrate pg-test dev              # Test connections
fiftyten-db migrate pg-dump dev --source-db legacy --data-only  # Migrate data
fiftyten-db migrate pg-stats dev --source-db legacy             # Verify migration

# AWS DMS migration (for complex scenarios or cross-database)
fiftyten-db migrate deploy dev               # Deploy DMS infrastructure
fiftyten-db migrate start dev                # Start migration
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

### PostgreSQL Database Migration (Recommended)

Simple and reliable PostgreSQL-to-PostgreSQL migration using native pg_dump/psql tools with automatic tunneling and credential management.

**Native PostgreSQL Tools**: Uses pg_dump and psql for maximum compatibility and reliability.

#### Quick Migration Examples
```bash
# Test connections before migration
fiftyten-db migrate pg-test dev

# Basic migration (data-only, preserves existing schema)
fiftyten-db migrate pg-dump dev --source-db legacy --data-only

# Full migration with schema (overwrites target schema)
fiftyten-db migrate pg-dump dev --source-db legacy

# Verify migration success with table-by-table comparison
fiftyten-db migrate pg-stats dev --source-db legacy
```

#### Migration from External Database
```bash
# Migrate from external PostgreSQL database
fiftyten-db migrate pg-dump dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123" \
  --data-only

# Advanced: Skip problematic tables
fiftyten-db migrate pg-dump dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123" \
  --skip-tables "migrations,typeorm_metadata" \
  --data-only
```

#### Key Advantages Over DMS
✅ **PostgreSQL-Native**: Uses pg_dump/psql for perfect PostgreSQL compatibility  
✅ **No Infrastructure Setup**: Ready to use immediately  
✅ **Better Error Handling**: Clear PostgreSQL error messages  
✅ **Table Filtering**: Include/exclude specific tables during migration  
✅ **Data-Only Mode**: Preserve existing schema, migrate data only  
✅ **Sequential Tunneling**: Eliminates Session Manager resource conflicts  
✅ **Automatic Verification**: Built-in table-by-table comparison  

### AWS DMS Migration (Enterprise/Cross-Database)

Complete AWS Database Migration Service with embedded CloudFormation templates for complex migration scenarios.

**Best for**: Cross-database migrations, large-scale enterprise migrations, ongoing CDC replication.

```bash
# Deploy migration infrastructure
fiftyten-db migrate deploy dev --type full-load-and-cdc

# Start migration
fiftyten-db migrate start dev

# Monitor progress
fiftyten-db migrate status dev

# Validate and cleanup
fiftyten-db migrate validate dev
fiftyten-db migrate cleanup dev
```

**When to Use DMS vs pg-dump:**
- **Use pg-dump**: PostgreSQL → PostgreSQL (simpler, faster, more reliable)
- **Use DMS**: Cross-database migrations, large enterprise migrations, ongoing CDC replication

### DynamoDB Operations

#### Table Discovery
```bash
# List all DynamoDB tables
fiftyten-db dynamo list-tables

# Describe table structure and keys
fiftyten-db dynamo describe fiftyten-exchange-credentials-dev
```

#### Data Operations (Built-in Security Filtering)
```bash
# Scan recent trading orders (sensitive fields automatically filtered)
fiftyten-db dynamo scan trading_orders --limit 10

# Query credentials for tenant (API keys/secrets never displayed)
fiftyten-db dynamo query fiftyten-exchange-credentials-dev "tenant_id = 5010"

# Get specific item with composite key
fiftyten-db dynamo get-item fiftyten-exchange-credentials-dev \
  '{"tenant_id":"5010","credential_sk":"USER#john_doe_123#PRODUCT#COPY_TRADING#EXCHANGE#gateio"}'

# Get trading order with automatic field filtering
fiftyten-db dynamo get-item trading_orders "id:trd_5f8a2b3c4d5e6f7g8h9i"
```

#### Security Features
- **Automatic Field Filtering**: Sensitive fields (API keys, secrets, credentials) are automatically hidden
- **Safe Data Operations**: Built-in protection against accidental credential exposure
- **Audit Trail**: All DynamoDB operations are logged for security compliance

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

### MFA Authentication & Security

The toolkit provides enterprise-grade security with intelligent MFA handling:

#### Automatic MFA Device Discovery
```bash
# Single device auto-selection (seamless experience)
🔐 MFA authentication required
✅ Auto-detected MFA device: arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra
? Enter MFA token code: 123456
✅ MFA authentication successful!
Session expires: 12/31/2023, 2:00:00 PM
```

#### Multiple Device Support
```bash
# Interactive device selection for multiple MFA devices
🔐 MFA authentication required
Multiple MFA devices found. Please select one:

? Select MFA Device: 
❯ ED_GalaxyS24_Ultra (arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra)
  backup-device (arn:aws:iam::ACCOUNT:mfa/backup-device)
```

#### Security Features
- **Session Token Management**: Secure temporary credential handling
- **Automatic Expiration**: Sessions automatically expire for security
- **Retry Prevention**: Smart retry logic prevents MFA loops
- **Credential Chain Support**: Full AWS credential provider chain compatibility

## 🎯 Key Features

### Database Connectivity
- **One-Command Connection**: `fiftyten-db psql dev -d indicator` - complete tunnel + credentials + psql launch
- **Multi-Database Support**: indicator, copytrading, platform, or any configured database
- **Database Discovery**: `fiftyten-db databases dev` to see available databases
- **Automatic Password Retrieval**: Seamless integration with AWS Secrets Manager
- **Session Manager Integration**: Secure connections without SSH keys or bastion access

### Migration System
- **AWS DMS Integration**: Enterprise-grade database migration service
- **Migration Type Selection**: Full-load or full-load-and-cdc based on requirements
- **Embedded Infrastructure**: CloudFormation templates built into CLI (no external dependencies)
- **Auto-Discovery**: Automatic VPC, subnet, and security group detection
- **Progress Monitoring**: Real-time table-by-table migration statistics
- **Data Validation**: Comprehensive row count and integrity validation

### DynamoDB Operations
- **Table Management**: List, describe, and manage DynamoDB tables
- **Safe Data Operations**: Scan, query, and get items with built-in security filtering
- **Automatic Security Filtering**: Sensitive fields (API keys, secrets) never displayed
- **Audit Trail**: All operations logged for security compliance

### Security & Compliance
- **Intelligent MFA Handling**: Auto-discovery with single device selection
- **Session Token Management**: Secure temporary credential handling with automatic expiration
- **Credential Chain Support**: Full AWS credential provider compatibility
- **Security Group Management**: Automated bidirectional rule configuration
- **Secrets Manager Integration**: Never store or display sensitive credentials

### Infrastructure Management
- **CloudFormation Deployment**: Complete infrastructure as code
- **VPC Auto-Discovery**: Automatic network configuration detection
- **Security Group Automation**: Intelligent rule management for database access
- **CloudWatch Integration**: Automated monitoring and alerting setup

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
| [db-toolkit](./packages/db-toolkit) | Complete database toolkit with AWS DMS migrations, secure connectivity, and DynamoDB operations | ✅ Active | 2.3.0 |

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
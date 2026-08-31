# @fiftyten/db-toolkit

[![npm version](https://img.shields.io/npm/v/@fiftyten/db-toolkit.svg)](https://www.npmjs.com/package/@fiftyten/db-toolkit)
[![Downloads](https://img.shields.io/npm/dm/@fiftyten/db-toolkit.svg)](https://npmjs.org/package/@fiftyten/db-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-232F3E?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/)

Complete database toolkit providing secure database connectivity, Valkey cache access, DynamoDB operations, and infrastructure management through integrated AWS services.

## Architecture

**Standalone Design**: Complete functionality with embedded CloudFormation templates and AWS service integrations.

### Core Components
- **Database Connectivity**: AWS Session Manager-based secure connections
- **Valkey Cache Access**: Guarded read/write to the shared ElastiCache (Valkey) via the bastion tunnel
- **DynamoDB Operations**: Table management with built-in security filtering
- **Infrastructure Management**: VPC/subnet auto-discovery and security group automation
- **Security Integration**: MFA authentication, credential management, and audit trail

## Features

### Database Connectivity
✅ **One-Command Connection** - `fiftyten-db psql main -d indicator` - complete tunnel + credentials + psql launch  
✅ **Multi-Database Support** - indicator, quant, or any configured database  
✅ **Automatic Password Retrieval** - Seamless AWS Secrets Manager integration  
✅ **Session Manager Security** - No SSH keys required, enterprise-grade security  
✅ **Database Discovery** - `fiftyten-db databases main` to see available databases  
✅ **Valkey Cache Access** - `fiftyten-db valkey main --bot <name>` - guarded read/write to the shared ElastiCache

### DynamoDB Operations
✅ **Table Management** - List, describe, and manage DynamoDB tables  
✅ **Safe Data Operations** - Scan, query, get items with built-in security filtering  
✅ **Automatic Security Filtering** - Sensitive fields never displayed  
✅ **Audit Trail** - All operations logged for security compliance

### Security & Infrastructure
✅ **Intelligent MFA Handling** - Auto-discovery with single device selection  
✅ **Port Conflict Detection** - Auto-suggests available ports  
✅ **Security Group Automation** - Bidirectional rule configuration  
✅ **CloudFormation Deployment** - Complete infrastructure as code

## Installation

### Global Installation (Recommended)

```bash
# With pnpm (team standard)
pnpm add -g @fiftyten/db-toolkit

# With npm
npm install -g @fiftyten/db-toolkit
```

### One-time Usage

```bash
# With pnpm
pnpm dlx @fiftyten/db-toolkit psql main -d indicator

# With npm
npx @fiftyten/db-toolkit psql main -d indicator
```

## Prerequisites

### System Requirements

1. **AWS CLI** configured with appropriate credentials
2. **Session Manager Plugin** for AWS CLI:
   ```bash
   # macOS
   brew install --cask session-manager-plugin
   
   # Linux
   curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm" -o "session-manager-plugin.rpm"
   sudo yum install -y session-manager-plugin.rpm
   ```
3. **PostgreSQL Client** (for database connections):
   ```bash
   # macOS
   brew install postgresql
   
   # Ubuntu/Debian
   sudo apt-get install postgresql-client
   ```
4. **Valkey CLI** (for the `valkey` cache command; `redis-cli` also works):
   ```bash
   # macOS
   brew install valkey
   ```

### IAM Permissions

Database connectivity, the `valkey` cache command, and DynamoDB operations are all covered by the **`BastionHostSessionManagerAccess`** policy (hand-attached to your AWS user or group). It grants:

- **SSM**: `StartSession` on the bastion, plus read of `/indicator/bastion/*/connection-info`, `/indicator/*/{env}/database-environment-variables`, and `/indicator/quant/*/bots/*/valkey-db-index`
- **CloudFormation**: `ListExports` (Valkey endpoint discovery)
- **EC2**: `DescribeInstances` (bastion discovery)
- **Secrets Manager**: `GetSecretValue` for the shared database secret

DynamoDB operations additionally need read access to the relevant tables.

## Usage

### Quick Start

```bash
# One command for complete database access (recommended)
fiftyten-db psql main -d indicator

# DynamoDB operations (sensitive fields auto-filtered)
fiftyten-db dynamo list-tables
fiftyten-db dynamo scan trading_orders --limit 10

# Valkey cache (read + guarded write)
fiftyten-db valkey main --bot <name> -- DBSIZE

# Alternative: Manual tunnel approach
fiftyten-db tunnel main -d indicator
# In another terminal:
psql -h localhost -p 5433 -d indicator_db -U fiftyten
```

### Commands

#### `psql` - One-Command Database Connection (Recommended)
```bash
fiftyten-db psql <environment> [options]

# Examples
fiftyten-db psql main -d indicator      # Connect to indicator database
fiftyten-db psql main -d quant         # Connect to quant cold-storage database
fiftyten-db psql main -d indicator -p 5434  # Use different port
```

#### `tunnel` - Create Database Tunnel
```bash
fiftyten-db tunnel <environment> [options]

# Examples
fiftyten-db tunnel main -d indicator    # Tunnel to indicator database on port 5433
fiftyten-db tunnel main -d quant -p 5434  # Tunnel to quant cold-storage database
```

#### `databases` - Discover Available Databases
```bash
fiftyten-db databases <environment>

# Examples
fiftyten-db databases main             # See what databases are available
```

**Common Options:**
- `-p, --port <port>` - Local port for tunnel (default: 5433)
- `-d, --database <database>` - Database name (indicator, quant, etc.)
- `--region <region>` - AWS region (default: us-west-1)

#### `connect` - Direct Database Connection
```bash
fiftyten-db connect <environment> [options]

# Examples
fiftyten-db connect main -d indicator   # Connect to indicator database
fiftyten-db connect main -d quant        # Connect to quant cold-storage database
```

#### `ssh` - SSH into Bastion Host
```bash
fiftyten-db ssh <environment>

# Examples
fiftyten-db ssh main                  # SSH into production bastion host
```

#### `info` - Show Connection Information
```bash
fiftyten-db info <environment>

# Examples
fiftyten-db info main                 # Show production environment info
```

#### `list` - List Available Environments
```bash
fiftyten-db list                      # Show all available environments
```

### Cache (Valkey) Commands

#### `valkey` - Inspect & Guarded-Modify the Shared Valkey Cache
Run Valkey/ElastiCache commands through the bastion tunnel. Reads run freely; writes are gated. Aliased as `redis`. Requires `valkey-cli` (`brew install valkey`; `redis-cli` also works).

Endpoint discovery uses the storage stack's `{environment}-redis-v2-endpoint`
and `{environment}-redis-v2-port` exports. The v2 replication group accepts
the existing non-TLS client during its `preferred` transition mode; TLS client
configuration is intentionally deferred to the separate TLS migration.

```bash
fiftyten-db valkey <environment> [command...] [options]

# Interactive session for a quant bot's hot state (write-capable)
fiftyten-db valkey main --bot sam --write

# One-shot read (no --write needed)
fiftyten-db valkey main --bot sam -- KEYS 'state:*'

# One-shot write (requires --write)
fiftyten-db valkey main --bot sam --write -- SET foo bar

# Raw DB index instead of a bot
fiftyten-db valkey main -n 0 -- INFO keyspace
```

**Options:**
- `--bot <name>` - Resolve the Valkey logical DB index for a quant bot (via SSM)
- `-n, --db <index>` - Raw logical DB index (0-15)
- `-w, --write` - Allow mutating commands (required for interactive sessions and one-shot writes)
- `-y, --yes` - Skip confirmation prompts
- `-p, --port <port>` - Local tunnel port (default: 6379)

**Write guard:** reads run without flags; mutations require `--write`; destructive commands (`FLUSHALL`/`FLUSHDB`/`DEL`/…) also prompt for confirmation. ⚠️ The hot cache is authoritative live-trading state — writes take effect immediately.

### DynamoDB Commands

#### `dynamo list-tables` - List DynamoDB Tables
```bash
fiftyten-db dynamo list-tables

# Examples
fiftyten-db dynamo list-tables        # List all tables in the region
```

#### `dynamo describe` - Describe Table Structure
```bash
fiftyten-db dynamo describe <table-name>

# Examples
fiftyten-db dynamo describe fiftyten-exchange-credentials-dev
fiftyten-db dynamo describe trading_orders
```

#### `dynamo scan` - Scan Table Data (Security Filtered)
```bash
fiftyten-db dynamo scan <table-name> [options]

# Options:
# --limit <number>    Limit number of items returned
# --start-key <json>  Start scan from specific key

# Examples
fiftyten-db dynamo scan trading_orders --limit 10
fiftyten-db dynamo scan user_profiles --limit 5
```

#### `dynamo query` - Query Table Data
```bash
fiftyten-db dynamo query <table-name> "<condition>"

# Examples
fiftyten-db dynamo query fiftyten-exchange-credentials-dev "tenant_id = 5010"
fiftyten-db dynamo query trading_orders "user_id = 12345"
```

#### `dynamo get-item` - Get Specific Item
```bash
fiftyten-db dynamo get-item <table-name> "<key>"

# For simple keys:
fiftyten-db dynamo get-item trading_orders "id:trd_5f8a2b3c4d5e6f7g8h9i"

# For composite keys (JSON format):
fiftyten-db dynamo get-item fiftyten-exchange-credentials-dev \
  '{"tenant_id":"5010","credential_sk":"USER#john_doe_123#PRODUCT#COPY_TRADING#EXCHANGE#gateio"}'
```

**DynamoDB Security Features:**
- **Automatic Field Filtering**: Sensitive fields (API keys, secrets, credentials) are automatically hidden
- **Safe Operations**: Built-in protection against accidental credential exposure
- **Audit Trail**: All operations are logged for security compliance

## Workflows

### Database Administration

```bash
# Recommended: One command approach
fiftyten-db psql main -d indicator

# Alternative: Manual tunnel for GUI tools
fiftyten-db tunnel main -d indicator
# Then connect with your favorite tool:
psql -h localhost -p 5433 -d indicator_db -U fiftyten
# OR
pgadmin (connect to localhost:5433)
# OR
dbeaver (connect to localhost:5433)
```

### Quick Query

```bash
# One command for quick queries (recommended)
fiftyten-db psql main -d indicator

# Alternative: Direct connection approach
fiftyten-db connect main -d indicator
# Then run: psql -h DATABASE_HOST -p 5432 -d indicator_db -U fiftyten
```

### Manual Operations

```bash
# SSH into bastion for manual operations
fiftyten-db ssh main
# Then you have full shell access with pre-installed tools
```

## Troubleshooting

### "No bastion host found"
- Check that the bastion host is deployed in the specified environment
- Verify your AWS credentials have access to EC2 and SSM

### "Connection info not found"
- The bastion host may not be fully deployed
- Check SSM Parameter Store for `/indicator/bastion/{env}/connection-info`

### "AWS CLI not found"
- Install AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
- Configure credentials: `aws configure`

### "Session Manager plugin not found"
- Install Session Manager plugin (see Prerequisites above)
- Restart your terminal after installation

### "Port 5433 is already in use"
- The CLI will automatically suggest available ports
- Use a different port: `fiftyten-db psql main -d indicator -p 5434`
- Find what's using the port: `lsof -i :5433`
- Stop local PostgreSQL if running: `brew services stop postgresql`

### "Could not load credentials from any providers"
- Configure AWS credentials: `aws configure`
- Or use IAM roles if running on EC2
- Ensure MFA device is properly configured

### "Database connection refused"
- Check that the database is running
- Verify security group rules allow bastion host access
- Confirm database endpoint is correct

## Development

```bash
# Clone the repository
git clone <repository-url>
cd fiftyten-cli-tools

# Install dependencies
npm install

# Build
npm run build

# Test locally
node packages/db-toolkit/bin/fiftyten-db.js tunnel main
```

## Security

- Uses AWS Session Manager (no SSH keys required)
- Database credentials stored in AWS Secrets Manager
- All connections are encrypted and logged
- Access controlled via AWS IAM permissions

## Support

For issues and questions, please check:
1. Infrastructure repository CLAUDE.md
2. AWS Session Manager documentation
3. Create an issue in the repository

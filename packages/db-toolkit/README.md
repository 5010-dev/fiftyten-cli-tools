# @fiftyten/db-toolkit

[![npm version](https://badge.fury.io/js/%40fiftyten%2Fdb-toolkit.svg)](https://www.npmjs.com/package/@fiftyten/db-toolkit)
[![Downloads](https://img.shields.io/npm/dm/@fiftyten/db-toolkit.svg)](https://npmjs.org/package/@fiftyten/db-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-232F3E?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/)

Simple CLI tool for connecting to Fiftyten databases via AWS Session Manager.

## Features

✅ **One-Command Connection** - `fiftyten-db psql dev -d indicator` - tunnel + password + psql automatically  
✅ **Multi-Database Support** - Connect to indicator, copytrading, or any configured database  
✅ **Database Migration** - Full migration with AWS DMS (full-load + CDC)  
✅ **Automatic Password Retrieval** - No manual password lookup required  
✅ **Intelligent Port Conflict Detection** - Auto-suggests available ports  
✅ **Smart MFA Handling** - Auto-discovers MFA devices with single prompt  
✅ **No SSH Keys Required** - Uses AWS Session Manager for secure connections  
✅ **Database Discovery** - `fiftyten-db databases dev` to see what's available

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
pnpm dlx @fiftyten/db-toolkit psql dev -d indicator

# With npm
npx @fiftyten/db-toolkit psql dev -d indicator
```

## Prerequisites

1. **AWS CLI** configured with appropriate permissions
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

## Usage

### Quick Start

```bash
# One command for complete database access (recommended)
fiftyten-db psql dev -d indicator

# Alternative: Manual tunnel approach
fiftyten-db tunnel dev -d indicator
# In another terminal:
psql -h localhost -p 5433 -d indicator_db -U fiftyten
```

### Commands

#### `psql` - One-Command Database Connection (Recommended)
```bash
fiftyten-db psql <environment> [options]

# Examples
fiftyten-db psql dev -d indicator      # Connect to indicator database
fiftyten-db psql dev -d copytrading    # Connect to copytrading database
fiftyten-db psql main -d platform -p 5434  # Use different port
```

#### `tunnel` - Create Database Tunnel
```bash
fiftyten-db tunnel <environment> [options]

# Examples
fiftyten-db tunnel dev -d indicator    # Tunnel to platform database on port 5433
fiftyten-db tunnel main -d copytrading -p 5434  # Tunnel to copytrading database
```

#### `databases` - Discover Available Databases
```bash
fiftyten-db databases <environment>

# Examples
fiftyten-db databases dev             # See what databases are available in dev
```

**Common Options:**
- `-p, --port <port>` - Local port for tunnel (default: 5433)
- `-d, --database <database>` - Database name (platform, copytrading, etc.)
- `--region <region>` - AWS region (default: us-west-1)

#### `connect` - Direct Database Connection
```bash
fiftyten-db connect <environment> [options]

# Examples
fiftyten-db connect dev -d platform   # Connect to indicator database
fiftyten-db connect main -d copytrading  # Connect to copytrading database
```

#### `ssh` - SSH into Bastion Host
```bash
fiftyten-db ssh <environment>

# Examples
fiftyten-db ssh dev                   # SSH into dev bastion host
fiftyten-db ssh main                  # SSH into production bastion host
```

#### `info` - Show Connection Information
```bash
fiftyten-db info <environment>

# Examples
fiftyten-db info dev                  # Show dev environment info
fiftyten-db info main                 # Show production environment info
```

#### `list` - List Available Environments
```bash
fiftyten-db list                      # Show all available environments
```

### Migration Commands

#### `migrate deploy` - Deploy Migration Infrastructure
```bash
fiftyten-db migrate deploy <environment>

# Interactive prompts for:
# • Legacy database endpoint and credentials
# • Target database selection (auto-discovered from infrastructure)
# • Notification emails (optional)

# Examples
fiftyten-db migrate deploy dev        # Deploy migration for dev environment
```

#### `migrate targets` - List Available Target Databases
```bash
fiftyten-db migrate targets <environment>

# Shows available target databases discovered from storage infrastructure

# Examples
fiftyten-db migrate targets dev       # List target databases in dev environment
```

#### `migrate start` - Start Migration Task
```bash
fiftyten-db migrate start <environment>

# Examples
fiftyten-db migrate start dev         # Start full migration (full-load + CDC)
```

#### `migrate status` - Monitor Migration Progress
```bash
fiftyten-db migrate status <environment>

# Examples
fiftyten-db migrate status dev        # Show detailed migration progress
```

#### `migrate validate` - Validate Migration Data
```bash
fiftyten-db migrate validate <environment>

# Examples
fiftyten-db migrate validate dev      # Comprehensive data validation
```

#### `migrate stop` - Stop Migration Task
```bash
fiftyten-db migrate stop <environment>

# Examples
fiftyten-db migrate stop dev          # Stop migration (use before cutover)
```

#### `migrate cleanup` - Cleanup Migration Resources
```bash
fiftyten-db migrate cleanup <environment>

# Examples
fiftyten-db migrate cleanup dev       # Destroy migration infrastructure
```

## Workflows

### Database Migration

Complete workflow for migrating from legacy database to new CDK-managed database:

```bash
# 0. List available target databases (optional)
fiftyten-db migrate targets dev

# 1. Deploy migration infrastructure (interactive setup)  
fiftyten-db migrate deploy dev
# Auto-discovers target databases, prompts for legacy DB details

# 2. Start full migration (full-load + CDC)
fiftyten-db migrate start dev

# 3. Monitor progress (run periodically)
fiftyten-db migrate status dev

# 4. Validate data integrity
fiftyten-db migrate validate dev

# 5. When migration is complete and validated:
# Stop the migration task (prepare for cutover)
fiftyten-db migrate stop dev

# 6. Update application to use new database
# (Point your app to the new database endpoint)

# 7. Cleanup migration resources
fiftyten-db migrate cleanup dev
```

#### Migration Features
- **Migration Type**: `full-load-and-cdc` (complete migration + ongoing replication)
- **Auto-Discovery**: Automatically finds target databases from your infrastructure
- **Security**: Legacy credentials never stored in version control
- **Monitoring**: Real-time progress with table-by-table statistics
- **Validation**: Comprehensive data validation with recommendations
- **AWS Integration**: Uses DMS, CloudWatch, and SNS for professional-grade migration

### Database Administration

```bash
# Recommended: One command approach
fiftyten-db psql dev -d indicator

# Alternative: Manual tunnel for GUI tools
fiftyten-db tunnel dev -d indicator
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
fiftyten-db psql dev -d indicator

# Alternative: Direct connection approach
fiftyten-db connect dev -d platform
# Then run: psql -h DATABASE_HOST -p 5432 -d platform -U fiftyten
```

### Manual Operations

```bash
# SSH into bastion for manual operations
fiftyten-db ssh dev
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
- Use a different port: `fiftyten-db psql dev -d indicator -p 5434`
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
cd cli-tool

# Install dependencies
npm install

# Build
npm run build

# Test locally
node dist/index.js tunnel dev
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
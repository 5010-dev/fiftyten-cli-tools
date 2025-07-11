# @fiftyten/db-connect

[![npm version](https://badge.fury.io/js/%40fiftyten%2Fdb-connect.svg)](https://www.npmjs.com/package/@fiftyten/db-connect)
[![Downloads](https://img.shields.io/npm/dm/@fiftyten/db-connect.svg)](https://npmjs.org/package/@fiftyten/db-connect)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-232F3E?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/)

Simple CLI tool for connecting to Fiftyten databases via AWS Session Manager.

## Features

✅ **One-Command Connection** - `fiftyten-db psql dev -d platform` - tunnel + password + psql automatically  
✅ **Multi-Database Support** - Connect to platform, copytrading, or any configured database  
✅ **Automatic Password Retrieval** - No manual password lookup required  
✅ **Intelligent Port Conflict Detection** - Auto-suggests available ports  
✅ **Smart MFA Handling** - Auto-discovers MFA devices with single prompt  
✅ **No SSH Keys Required** - Uses AWS Session Manager for secure connections  
✅ **Database Discovery** - `fiftyten-db databases dev` to see what's available

## Installation

### Global Installation (Recommended)

```bash
# With pnpm (team standard)
pnpm add -g @fiftyten/db-connect

# With npm
npm install -g @fiftyten/db-connect
```

### One-time Usage

```bash
# With pnpm
pnpm dlx @fiftyten/db-connect psql dev -d platform

# With npm
npx @fiftyten/db-connect psql dev -d platform
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
fiftyten-db psql dev -d platform

# Alternative: Manual tunnel approach
fiftyten-db tunnel dev -d platform
# In another terminal:
psql -h localhost -p 5433 -d platform -U fiftyten
```

### Commands

#### `psql` - One-Command Database Connection (Recommended)
```bash
fiftyten-db psql <environment> [options]

# Examples
fiftyten-db psql dev -d platform      # Connect to platform database
fiftyten-db psql dev -d copytrading    # Connect to copytrading database
fiftyten-db psql main -d platform -p 5434  # Use different port
```

#### `tunnel` - Create Database Tunnel
```bash
fiftyten-db tunnel <environment> [options]

# Examples
fiftyten-db tunnel dev -d platform    # Tunnel to platform database on port 5433
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
fiftyten-db connect dev -d platform   # Connect to platform database
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

## Workflows

### Database Administration

```bash
# Recommended: One command approach
fiftyten-db psql dev -d platform

# Alternative: Manual tunnel for GUI tools
fiftyten-db tunnel dev -d platform
# Then connect with your favorite tool:
psql -h localhost -p 5433 -d platform -U fiftyten
# OR
pgadmin (connect to localhost:5433)
# OR
dbeaver (connect to localhost:5433)
```

### Quick Query

```bash
# One command for quick queries (recommended)
fiftyten-db psql dev -d platform

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
- Use a different port: `fiftyten-db psql dev -d platform -p 5434`
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
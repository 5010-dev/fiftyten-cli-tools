# @5010-indicator/db-connect

Simple CLI tool for connecting to 5010 Indicator databases via AWS Session Manager.

## Features

✅ **No SSH Keys Required** - Uses AWS Session Manager for secure connections  
✅ **Auto-Discovery** - Automatically finds bastion hosts and database endpoints  
✅ **Multiple Environments** - Supports dev and production environments  
✅ **Simple Commands** - Easy-to-remember CLI interface  
✅ **Port Forwarding** - Create local database tunnels  
✅ **Direct Connection** - SSH into bastion host for manual operations

## Installation

### Global Installation (Recommended)

```bash
npm install -g @5010-indicator/db-connect
```

### One-time Usage

```bash
npx @5010-indicator/db-connect tunnel dev
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
# Create tunnel to dev database
5010-db tunnel dev

# In another terminal, connect to database
psql -h localhost -p 5432 -d platform -U fiftyten
```

### Commands

#### `tunnel` - Create Database Tunnel
```bash
5010-db tunnel <environment> [options]

# Examples
5010-db tunnel dev                    # Tunnel to dev database on port 5432
5010-db tunnel main --port 5433       # Tunnel to main database on port 5433
5010-db tunnel dev --service copytrading  # Tunnel to copy-trading database
```

**Options:**
- `-p, --port <port>` - Local port for tunnel (default: 5432)
- `-s, --service <service>` - Database service (default: platform)
- `--region <region>` - AWS region (default: us-west-1)

#### `connect` - Direct Database Connection
```bash
5010-db connect <environment> [options]

# Examples
5010-db connect dev                   # Connect to dev database
5010-db connect main --service copytrading  # Connect to copy-trading database
```

#### `ssh` - SSH into Bastion Host
```bash
5010-db ssh <environment>

# Examples
5010-db ssh dev                       # SSH into dev bastion host
5010-db ssh main                      # SSH into production bastion host
```

#### `info` - Show Connection Information
```bash
5010-db info <environment>

# Examples
5010-db info dev                      # Show dev environment info
5010-db info main                     # Show production environment info
```

#### `list` - List Available Environments
```bash
5010-db list                          # Show all available environments
```

## Workflows

### Database Administration

```bash
# 1. Create tunnel
5010-db tunnel dev

# 2. Connect with your favorite tool
psql -h localhost -p 5432 -d platform -U fiftyten
# OR
pgadmin (connect to localhost:5432)
# OR
dbeaver (connect to localhost:5432)
```

### Quick Query

```bash
# Direct connection for quick queries
5010-db connect dev
# Then run: psql -h DATABASE_HOST -p 5432 -d platform -U fiftyten
```

### Manual Operations

```bash
# SSH into bastion for manual operations
5010-db ssh dev
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
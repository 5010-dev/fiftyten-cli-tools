# @fiftyten/db-toolkit

[![npm version](https://img.shields.io/npm/v/@fiftyten/db-toolkit.svg)](https://www.npmjs.com/package/@fiftyten/db-toolkit)
[![Downloads](https://img.shields.io/npm/dm/@fiftyten/db-toolkit.svg)](https://npmjs.org/package/@fiftyten/db-toolkit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![AWS](https://img.shields.io/badge/AWS-232F3E?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/)

Complete database toolkit providing secure database connectivity, AWS DMS migrations, DynamoDB operations, and infrastructure management through integrated AWS services.

## Architecture

**Standalone Design**: Complete functionality with embedded CloudFormation templates and AWS service integrations.

### Core Components
- **Database Connectivity**: AWS Session Manager-based secure connections
- **Migration System**: AWS DMS with embedded infrastructure templates
- **DynamoDB Operations**: Table management with built-in security filtering
- **Infrastructure Management**: VPC/subnet auto-discovery and security group automation
- **Security Integration**: MFA authentication, credential management, and audit trail

## Features

### Database Connectivity
✅ **One-Command Connection** - `fiftyten-db psql dev -d indicator` - complete tunnel + credentials + psql launch  
✅ **Multi-Database Support** - indicator, copytrading, platform, or any configured database  
✅ **Automatic Password Retrieval** - Seamless AWS Secrets Manager integration  
✅ **Session Manager Security** - No SSH keys required, enterprise-grade security  
✅ **Database Discovery** - `fiftyten-db databases dev` to see available databases

### Migration System
✅ **PostgreSQL Native Migration** - pg_dump/psql tools with automatic tunneling (recommended)  
✅ **AWS DMS Integration** - Enterprise-grade database migration service for complex scenarios  
✅ **Migration Verification** - Table-by-table row count comparison and validation  
✅ **Auto-Discovery** - CDK-first bastion discovery with fallback patterns  
✅ **Sequential Tunneling** - Eliminates Session Manager resource conflicts

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
pnpm dlx @fiftyten/db-toolkit psql dev -d indicator

# With npm
npx @fiftyten/db-toolkit psql dev -d indicator
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

### IAM Permissions

#### Required Policies
1. **Database Connectivity**: `BastionHostSessionManagerAccess` (for Session Manager connections)
2. **Migration Features**: `DMSMigrationDeploymentAccess` (for DMS operations and CloudFormation deployment)
3. **DynamoDB Operations**: Included in migration policy or separate DynamoDB read access

#### Key Permissions Included
- **CloudFormation**: Create/update/delete migration stacks
- **DMS**: Manage replication instances, endpoints, and tasks  
- **EC2**: VPC and subnet discovery, security group management
- **IAM**: Create DMS service roles
- **CloudWatch/SNS**: Monitoring and notifications
- **DynamoDB**: Table operations and data access
- **Secrets Manager**: Database credential access

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationMigrationAccess",
      "Effect": "Allow", 
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks"
      ],
      "Resource": [
        "arn:aws:cloudformation:*:*:stack/indicator-migration-stack-*/*"
      ]
    }
    // ... additional statements (see full policy in documentation)
  ]
}
```

**Policy Name**: `DMSMigrationDeploymentAccess`

#### Minimal Permissions
For database connections only (without migration or DynamoDB features), the `BastionHostSessionManagerAccess` policy is sufficient.

## Usage

### Quick Start

```bash
# One command for complete database access (recommended)
fiftyten-db psql dev -d indicator

# DynamoDB operations (sensitive fields auto-filtered)
fiftyten-db dynamo list-tables
fiftyten-db dynamo scan trading_orders --limit 10

# PostgreSQL migration (recommended)
fiftyten-db migrate pg-test dev --source-db legacy        # Test connections
fiftyten-db migrate pg-dump dev --source-db legacy --data-only  # Migrate data
fiftyten-db migrate pg-stats dev --source-db legacy       # Verify migration

# AWS DMS migration (for complex scenarios)
fiftyten-db migrate deploy dev
fiftyten-db migrate start dev

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

### Migration Commands

Complete AWS DMS migration system with embedded infrastructure:

#### `migrate deploy` - Deploy Migration Infrastructure
```bash
fiftyten-db migrate deploy <environment> [options]

# Options:
# --type <migration-type>   Migration type: full-load or full-load-and-cdc (default: full-load)

# Features:
# • Embedded CloudFormation templates (no external dependencies)
# • Auto-discovers VPC and subnet configuration
# • Interactive prompts for legacy database credentials
# • Target database auto-discovery from existing infrastructure

# Examples
fiftyten-db migrate deploy dev                    # Deploy with full-load migration
fiftyten-db migrate deploy dev --type full-load-and-cdc  # Deploy with CDC
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
fiftyten-db migrate start dev         # Start migration (type determined by deployment)
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

#### PostgreSQL Migration Commands (Recommended)

Native PostgreSQL migration using pg_dump/psql with automatic tunneling:

#### `migrate pg-test` - Test Database Connections
```bash
fiftyten-db migrate pg-test <environment> [options]

# Test with built-in legacy database configuration
fiftyten-db migrate pg-test dev
fiftyten-db migrate pg-test main

# Test with external source database
fiftyten-db migrate pg-test dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123"
```

#### `migrate pg-dump` - PostgreSQL Migration
```bash
fiftyten-db migrate pg-dump <environment> [options]

# Basic data-only migration (recommended)
fiftyten-db migrate pg-dump dev --source-db legacy --data-only
fiftyten-db migrate pg-dump main --source-db legacy --data-only

# Full migration with schema
fiftyten-db migrate pg-dump dev --source-db legacy

# External database migration
fiftyten-db migrate pg-dump dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123" \
  --data-only

# Advanced: Table filtering
fiftyten-db migrate pg-dump dev --source-db legacy \
  --data-only \
  --skip-tables "migrations,typeorm_metadata"

fiftyten-db migrate pg-dump dev --source-db legacy \
  --data-only \
  --include-tables "users,products,orders"
```

**Options:**
- `--source-db <database>` - Use built-in legacy database configuration
- `--target-db <database>` - Target database name (default: indicator)
- `--source-endpoint <endpoint>` - External source database endpoint
- `--source-username <username>` - External source database username
- `--source-password <password>` - External source database password
- `--data-only` - Dump data only, preserve existing schema
- `--skip-tables <tables>` - Comma-separated list of tables to skip
- `--include-tables <tables>` - Include only these tables (comma-separated)

#### `migrate pg-stats` - Migration Verification
```bash
fiftyten-db migrate pg-stats <environment> [options]

# Compare with built-in legacy database
fiftyten-db migrate pg-stats dev --source-db legacy
fiftyten-db migrate pg-stats main --source-db legacy

# Compare with external database
fiftyten-db migrate pg-stats dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123"
```

**PostgreSQL Migration Features:**
- **Native Tools**: Uses pg_dump and psql for maximum PostgreSQL compatibility
- **Sequential Tunneling**: Creates source tunnel → dump → close → target tunnel → restore → close
- **Automatic Verification**: Table-by-table row count comparison
- **CDK-First Discovery**: Modern bastion discovery with fallback patterns
- **Security Integration**: Automatic password retrieval from AWS Secrets Manager
- **Error Handling**: Clear PostgreSQL error messages with context
- **Table Filtering**: Advanced include/exclude table options
- **Schema Flexibility**: Data-only mode preserves existing target schema

## Workflows

### PostgreSQL Migration Workflow (Recommended)

Simple and reliable PostgreSQL-to-PostgreSQL migration workflow:

```bash
# 1. Test connections to both source and target databases
fiftyten-db migrate pg-test dev --source-db legacy

# 2. Perform data-only migration (preserves existing schema)
fiftyten-db migrate pg-dump dev --source-db legacy --data-only

# 3. Verify migration success with table-by-table comparison
fiftyten-db migrate pg-stats dev --source-db legacy

# 4. (Optional) Advanced migration with table filtering
fiftyten-db migrate pg-dump dev --source-db legacy \
  --data-only \
  --skip-tables "migrations,typeorm_metadata"
```

#### Key Advantages
- **No Infrastructure Setup**: Works immediately without CloudFormation deployment
- **PostgreSQL Native**: Perfect compatibility using pg_dump/psql
- **Automatic Tunneling**: Handles Session Manager tunnels automatically
- **Built-in Verification**: Table-by-table row count validation
- **Error Recovery**: Clear error messages and automatic cleanup

#### Migration from External Database
```bash
# Test external database connection
fiftyten-db migrate pg-test dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123"

# Migrate data from external database
fiftyten-db migrate pg-dump dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123" \
  --data-only

# Verify migration
fiftyten-db migrate pg-stats dev \
  --source-endpoint external-db.example.com \
  --source-username postgres \
  --source-password "password123"
```

### AWS DMS Migration Workflow

Complete AWS DMS migration workflow with embedded infrastructure:

#### Migration Advantages
- **Standalone Operation**: All infrastructure templates embedded in CLI
- **Auto-discovery**: VPC, subnets, and target databases discovered automatically  
- **Migration Type Selection**: Choose between full-load or full-load-and-cdc
- **Portable**: Works on any developer machine with AWS credentials

```bash
# 1. Ensure you have the required IAM permissions
# Apply DMSMigrationDeploymentAccess policy (one-time setup)

# 2. Optional: List available target databases
fiftyten-db migrate targets dev

# 3. Deploy migration infrastructure (standalone - no local repos required)
fiftyten-db migrate deploy dev --type full-load
# Auto-discovers target databases, prompts for legacy DB details

# 4. Start migration
fiftyten-db migrate start dev

# 5. Monitor progress (run periodically)
fiftyten-db migrate status dev

# 6. Validate data integrity
fiftyten-db migrate validate dev

# 7. When migration is complete and validated:
# Stop the migration task (prepare for cutover)
fiftyten-db migrate stop dev

# 8. Update application to use new database
# (Point your app to the new database endpoint)

# 9. Cleanup migration resources
fiftyten-db migrate cleanup dev
```

#### Migration Features
- **Embedded CloudFormation Templates**: No external repository dependencies
- **Auto-Discovery**: VPC, subnets, and target databases discovered automatically
- **Migration Type Selection**: Full-load or full-load-and-cdc based on requirements
- **Security Integration**: Legacy credentials never stored, uses AWS Secrets Manager
- **Progress Monitoring**: Real-time table-by-table statistics and error tracking
- **Data Validation**: Comprehensive row count and integrity validation
- **CloudWatch Integration**: Automated monitoring and alerting
- **Infrastructure as Code**: Complete DMS setup via CloudFormation

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
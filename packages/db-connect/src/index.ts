#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { DatabaseConnector } from './database-connector';
import { DynamoDBConnector } from './dynamodb-connector';
import { version } from '../package.json';

const program = new Command();

program
  .name('fiftyten-db')
  .description('CLI tool for connecting to Fiftyten databases via AWS Session Manager')
  .version(version);

// Tunnel command - creates port forwarding to database
program
  .command('tunnel')
  .description('Create SSH tunnel to database via Session Manager')
  .argument('<environment>', 'Environment (dev/main)')
  .option('-p, --port <port>', 'Local port for tunnel', '5433')
  .option('-d, --database <app>', 'Application database (platform, copytrading, etc.)', 'platform')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.createTunnel(environment, options.database, parseInt(options.port));
    } catch (error) {
      console.error(chalk.red('Error creating tunnel:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Connect command - direct connection to database
program
  .command('connect')
  .description('Connect directly to database via Session Manager')
  .argument('<environment>', 'Environment (dev/main)')
  .option('-d, --database <app>', 'Application database (platform, copytrading, etc.)', 'platform')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.connectDatabase(environment, options.database);
    } catch (error) {
      console.error(chalk.red('Error connecting to database:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// SSH command - SSH into bastion host
program
  .command('ssh')
  .description('SSH into bastion host via Session Manager')
  .argument('<environment>', 'Environment (dev/main)')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.sshBastion(environment);
    } catch (error) {
      console.error(chalk.red('Error connecting to bastion:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Info command - show connection information
program
  .command('info')
  .description('Show connection information for environment')
  .argument('<environment>', 'Environment (dev/main)')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.showInfo(environment);
    } catch (error) {
      console.error(chalk.red('Error fetching info:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// List command - show available environments
program
  .command('list')
  .description('List available environments and services')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.listEnvironments();
    } catch (error) {
      console.error(chalk.red('Error listing environments:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Psql command - complete database connection with password
program
  .command('psql')
  .description('Connect to database with automatic tunnel and password retrieval')
  .argument('<environment>', 'Environment (dev/main)')
  .option('-p, --port <port>', 'Local port for tunnel', '5433')
  .option('-d, --database <app>', 'Application database (platform, copytrading, etc.)', 'platform')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.connectWithPassword(environment, options.database, parseInt(options.port));
    } catch (error) {
      console.error(chalk.red('Error connecting to database:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Databases command - discover available databases
program
  .command('databases')
  .description('Discover available databases for an environment')
  .argument('<environment>', 'Environment (dev/main)')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      await connector.discoverDatabases(environment);
    } catch (error) {
      console.error(chalk.red('Error discovering databases:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Password command - get database password for manual configuration
program
  .command('password')
  .description('Get database password for manual configuration')
  .argument('<environment>', 'Environment (dev/main)')
  .option('-d, --database <app>', 'Application database (platform, copytrading, etc.)', 'platform')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (environment, options) => {
    try {
      const connector = new DatabaseConnector(options.region);
      const password = await connector.getDatabasePassword(environment, options.database);
      console.log(chalk.green('✅ Database password retrieved:'));
      console.log(chalk.yellow(password));
      console.log('');
      console.log(chalk.gray('💡 DATABASE_URL for manual configuration:'));
      console.log(chalk.cyan(`DATABASE_URL=postgres://fiftyten:${password}@localhost:5433/${options.database === 'platform' ? 'platform' : options.database}`));
    } catch (error) {
      console.error(chalk.red('Error retrieving password:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// DynamoDB commands
const dynamoCommand = program
  .command('dynamo')
  .description('DynamoDB operations (all commands hide sensitive fields for security)');

// List DynamoDB tables
dynamoCommand
  .command('list-tables')
  .description('List all DynamoDB tables')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .action(async (options) => {
    try {
      const connector = new DynamoDBConnector(options.region);
      await connector.listTables();
    } catch (error) {
      console.error(chalk.red('Error listing tables:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Describe a specific table
dynamoCommand
  .command('describe')
  .description('Describe a DynamoDB table structure and keys')
  .argument('<tableName>', 'Name of the table to describe')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .addHelpText('after', `
Example:
  ${chalk.cyan('fiftyten-db dynamo describe fiftyten-exchange-credentials-dev')}
  
Shows key structure needed for queries:
  • tenant_id (Hash key) + credential_sk (Range key)  
  • GSI indexes for efficient lookups
  • Example credential_sk: "USER#john123#PRODUCT#COPY_TRADING#EXCHANGE#gateio"`)
  .action(async (tableName, options) => {
    try {
      const connector = new DynamoDBConnector(options.region);
      await connector.describeTable(tableName);
    } catch (error) {
      console.error(chalk.red('Error describing table:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Scan a table
dynamoCommand
  .command('scan')
  .description('Scan a DynamoDB table (sensitive fields always hidden)')
  .argument('<tableName>', 'Name of the table to scan')
  .option('-l, --limit <limit>', 'Maximum number of items to return', '20')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .addHelpText('after', `
Examples:
  ${chalk.gray('# Check recent trading orders')}
  ${chalk.cyan('fiftyten-db dynamo scan trading_orders --limit 10')}
  
  ${chalk.gray('# Sample customer credentials to see data format')}
  ${chalk.cyan('fiftyten-db dynamo scan fiftyten-exchange-credentials-dev --limit 3')}
  
  ${chalk.gray('# Find all active customers')}
  ${chalk.cyan('fiftyten-db dynamo scan fiftyten-exchange-credentials-dev --limit 50')}

⚠️  Scan reads entire table sequentially - expensive! Use query for targeted lookups.`)
  .action(async (tableName, options) => {
    try {
      const connector = new DynamoDBConnector(options.region);
      await connector.scanTable(tableName, parseInt(options.limit));
    } catch (error) {
      console.error(chalk.red('Error scanning table:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Query a table
dynamoCommand
  .command('query')
  .description('Query a DynamoDB table (sensitive fields always hidden)')
  .argument('<tableName>', 'Name of the table to query')
  .argument('<keyCondition>', 'Key condition (e.g., "id = value")')
  .option('-l, --limit <limit>', 'Maximum number of items to return', '20')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .addHelpText('after', `
Examples:
  ${chalk.gray('# Find all credentials for tenant 5010')}
  ${chalk.cyan('fiftyten-db dynamo query fiftyten-exchange-credentials-dev "tenant_id = 5010"')}
  
  ${chalk.gray('# Check trading orders for specific customer')}
  ${chalk.cyan('fiftyten-db dynamo query trading_orders "customer_id = john_doe_123"')}
  
  ${chalk.gray('# Find recent positions')}
  ${chalk.cyan('fiftyten-db dynamo query trading_positions "customer_id = john_doe_123" --limit 5')}

💡 Query is efficient - uses partition key index. For GSI queries, use AWS CLI directly.`)
  .action(async (tableName, keyCondition, options) => {
    try {
      const connector = new DynamoDBConnector(options.region);
      await connector.queryTable(tableName, keyCondition, parseInt(options.limit));
    } catch (error) {
      console.error(chalk.red('Error querying table:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Get a specific item
dynamoCommand
  .command('get-item')
  .description('Get a specific item from DynamoDB table (sensitive fields always hidden)')
  .argument('<tableName>', 'Name of the table')
  .argument('<key>', 'Key of the item (format: "keyName:value" or JSON)')
  .option('--region <region>', 'AWS region', 'us-west-1')
  .addHelpText('after', `
Examples:
  ${chalk.gray('# Get specific trading order details')}
  ${chalk.cyan('fiftyten-db dynamo get-item trading_orders "id:trd_5f8a2b3c4d5e6f7g8h9i"')}
  
  ${chalk.gray('# Get customer credentials (composite key)')}
  ${chalk.cyan('fiftyten-db dynamo get-item fiftyten-exchange-credentials-dev \\\\')}
  ${chalk.cyan('  \'{"tenant_id":"5010","credential_sk":"USER#john_doe_123#PRODUCT#COPY_TRADING#EXCHANGE#gateio"}\'')}
  
  ${chalk.gray('# Check specific position status')}
  ${chalk.cyan('fiftyten-db dynamo get-item trading_positions "id:pos_abc123def456"')}

💡 Use query first to find the exact keys, then get-item for full details.`)
  .action(async (tableName, key, options) => {
    try {
      const connector = new DynamoDBConnector(options.region);
      await connector.getItem(tableName, key);
    } catch (error) {
      console.error(chalk.red('Error getting item:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
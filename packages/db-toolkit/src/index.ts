#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { DatabaseConnector } from './database-connector';
import { DynamoDBConnector } from './dynamodb-connector';
import { MigrationManager, MigrationConfig } from './migration-manager';
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
	.option('-d, --database <app>', 'Application database (indicator, copytrading, etc.)', 'indicator')
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
	.option('-d, --database <app>', 'Application database (indicator, copytrading, etc.)', 'indicator')
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
	.option('-d, --database <app>', 'Application database (indicator, copytrading, etc.)', 'indicator')
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
	.option('-d, --database <app>', 'Application database (indicator, copytrading, etc.)', 'indicator')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.action(async (environment, options) => {
		try {
			const connector = new DatabaseConnector(options.region);
			const password = await connector.getDatabasePassword(environment, options.database);
			console.log(chalk.green('✅ Database password retrieved:'));
			console.log(chalk.yellow(password));
			console.log('');
			console.log(chalk.gray('💡 DATABASE_URL for manual configuration:'));
			console.log(chalk.cyan(`DATABASE_URL=postgres://fiftyten:${password}@localhost:5433/indicator_db`));
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

// Migration commands
const migrateCommand = program
	.command('migrate')
	.description('Database migration operations using AWS DMS (full migration: full-load + CDC)');

// Deploy migration infrastructure
migrateCommand
	.command('deploy')
	.description('Deploy DMS migration infrastructure for full database migration')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.option('--type <type>', 'Migration type: full-load or full-load-and-cdc', 'full-load-and-cdc')
	.addHelpText('after', `
Migration Types:
  ${chalk.yellow('full-load')}         - One-time copy (requires source database to be stopped)
  ${chalk.yellow('full-load-and-cdc')} - Complete migration + ongoing replication (requires logical replication)

This command will prompt you for:
  • Legacy database endpoint and credentials
  • Target database secret ARN
  • Notification email addresses (optional)

Examples:
  ${chalk.cyan('fiftyten-db migrate deploy dev --type full-load')}
  ${chalk.cyan('fiftyten-db migrate deploy dev --type full-load-and-cdc')}`)
	.action(async (environment, options) => {
		try {
			// Validate migration type
			const validTypes = ['full-load', 'full-load-and-cdc'];
			if (!validTypes.includes(options.type)) {
				console.error(chalk.red(`❌ Invalid migration type: ${options.type}`));
				console.error(chalk.gray(`   Valid types: ${validTypes.join(', ')}`));
				process.exit(1);
			}

			const manager = new MigrationManager(options.region);

			console.log(chalk.blue('🔧 Database Migration Setup'));
			console.log('');
			console.log(chalk.green('This will deploy AWS DMS infrastructure for database migration:'));
			console.log(chalk.gray('  • Full load of all existing data'));
			if (options.type === 'full-load-and-cdc') {
				console.log(chalk.gray('  • Change Data Capture (CDC) for ongoing replication'));
			}
			console.log(chalk.gray('  • CloudWatch monitoring and SNS alerts'));
			console.log('');

			// Discover available target databases
			const targetDatabases = await manager.discoverTargetDatabases(environment);

			// Prepare target database selection
			const targetChoices = targetDatabases.map(db => ({
				name: `${db.friendlyName} (${db.name})`,
				value: db.secretArn,
				short: db.friendlyName
			}));

			// Add manual entry option
			targetChoices.push({
				name: 'Enter target database ARN manually',
				value: 'manual',
				short: 'Manual Entry'
			});

			// Use hardcoded legacy database configuration for now
			console.log(chalk.yellow('Using legacy database configuration:'));
			console.log('  Endpoint: develop.cxw4cwcyepf1.us-west-1.rds.amazonaws.com');
			console.log('  Database: indicator');
			console.log('  Username: ogongilgong');

			const config: MigrationConfig = {
				environment,
				legacyEndpoint: 'develop.cxw4cwcyepf1.us-west-1.rds.amazonaws.com',
				legacyDatabase: 'indicator',
				legacyUsername: 'ogongilgong',
				legacyPassword: 'F5olld4QvJ2Yx8aJMA9R',
				targetSecretArn: targetChoices.length > 0 ? targetChoices[0].value : '',
				migrationType: options.type,
				notificationEmails: undefined,
			};

			await manager.deployMigration(config);
		} catch (error) {
			console.error(chalk.red('Error deploying migration:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Start migration task
migrateCommand
	.command('start')
	.description('Start the database migration task (full-load + CDC)')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
Starts full database migration:
  1. ${chalk.yellow('Full Load')}: Migrates all existing data
  2. ${chalk.yellow('CDC')}: Captures ongoing changes for real-time replication

Example:
  ${chalk.cyan('fiftyten-db migrate start dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			await manager.startMigration(environment);
		} catch (error) {
			console.error(chalk.red('Error starting migration:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Stop migration task
migrateCommand
	.command('stop')
	.description('Stop the database migration task')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
Stops the migration task and halts all data replication.
Use this when ready to cutover to the new database.

Example:
  ${chalk.cyan('fiftyten-db migrate stop dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			await manager.stopMigration(environment);
		} catch (error) {
			console.error(chalk.red('Error stopping migration:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Show migration status
migrateCommand
	.command('status')
	.description('Show migration task status and progress')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
Shows detailed migration progress including:
  • Task status (running, stopped, failed)
  • Overall progress percentage
  • Table-by-table statistics
  • Row counts and error counts

Example:
  ${chalk.cyan('fiftyten-db migrate status dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			await manager.showMigrationStatus(environment);
		} catch (error) {
			console.error(chalk.red('Error getting migration status:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Validate migration
migrateCommand
	.command('validate')
	.description('Validate migration data and provide recommendations')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
Provides comprehensive migration validation:
  • Data completion rates
  • Error analysis
  • Table-by-table status
  • Recommendations for next steps

Example:
  ${chalk.cyan('fiftyten-db migrate validate dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			await manager.validateMigration(environment);
		} catch (error) {
			console.error(chalk.red('Error validating migration:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// List available target databases
migrateCommand
	.command('targets')
	.description('List available target databases for migration')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
Shows available target databases discovered from storage infrastructure:
  • Database name and friendly name
  • Secret ARN for migration setup
  • Endpoint and port information

Example:
  ${chalk.cyan('fiftyten-db migrate targets dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			const targetDatabases = await manager.discoverTargetDatabases(environment);

			if (targetDatabases.length === 0) {
				console.log(chalk.yellow('No target databases found.'));
				console.log(chalk.gray('Deploy storage infrastructure first with databases enabled.'));
				return;
			}

			console.log(chalk.blue(`📋 Available Target Databases - ${environment.toUpperCase()}`));
			console.log('');

			targetDatabases.forEach(db => {
				console.log(chalk.green(`🗄️  ${db.friendlyName}`));
				console.log(`   Name: ${chalk.yellow(db.name)}`);
				console.log(`   Secret ARN: ${chalk.gray(db.secretArn)}`);
				if (db.endpoint) {
					console.log(`   Endpoint: ${chalk.cyan(db.endpoint + ':' + db.port)}`);
				}
				console.log('');
			});

		} catch (error) {
			console.error(chalk.red('Error listing target databases:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Cleanup migration infrastructure
migrateCommand
	.command('cleanup')
	.description('Destroy migration infrastructure after successful migration')
	.argument('<environment>', 'Environment (dev/main)')
	.option('--region <region>', 'AWS region', 'us-west-1')
	.addHelpText('after', `
⚠️  This destroys all DMS migration resources:
  • DMS replication instance
  • Migration tasks and endpoints
  • CloudWatch logs and alarms

Only run this after successful migration and application cutover.

Example:
  ${chalk.cyan('fiftyten-db migrate cleanup dev')}`)
	.action(async (environment, options) => {
		try {
			const manager = new MigrationManager(options.region);
			await manager.cleanupMigration(environment);
		} catch (error) {
			console.error(chalk.red('Error cleaning up migration:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
	program.outputHelp();
}

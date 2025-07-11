#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { DatabaseConnector } from './database-connector';
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
  .option('-d, --database <database>', 'Database name (platform, copytrading, etc.)', 'platform')
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
  .option('-d, --database <database>', 'Database name (platform, copytrading, etc.)', 'platform')
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
  .option('-d, --database <database>', 'Database name (platform, copytrading, etc.)', 'platform')
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

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
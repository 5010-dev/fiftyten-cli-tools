import chalk from 'chalk';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import { EC2Client, DescribeInstancesCommand, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFormationManager } from './cloudformation-manager';
import { MigrationManager } from './migration-manager';
import { DatabaseConnector } from './database-connector';
import { MfaAuthenticator } from './mfa-auth';

// Helper function to prompt for confirmation
function promptConfirmation(message: string): Promise<boolean> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	return new Promise((resolve) => {
		rl.question(`${message} (y/N): `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
		});
	});
}

export interface PgMigrationConfig {
	environment: string;
	sourceDatabase: string;
	targetDatabase: string;
	sourceEndpoint?: string;
	sourceUsername?: string;
	sourcePassword?: string;
	dataOnly?: boolean;
	skipTables?: string[];
	includeTables?: string[];
}

export interface DatabaseConnection {
	endpoint: string;
	port: number;
	database: string;
	username: string;
	password: string;
	type: 'rds' | 'external' | 'tunnel';
	securityGroupIds?: string[];
}

export interface TunnelInfo extends DatabaseConnection {
	tunnelProcess: ChildProcess;
	localPort: number;
	bastionInstanceId: string;
}

export class PgMigrationManager {
	private dbConnector: DatabaseConnector;
	private cfnManager: CloudFormationManager;
	private migrationManager: MigrationManager;
	private mfaAuth: MfaAuthenticator;
	private ec2Client: EC2Client;
	private ssmClient: SSMClient;
	private region: string;
	private mfaAuthenticated: boolean = false;
	private activeTunnels: TunnelInfo[] = [];
	private addedSecurityGroupRules: Array<{ groupId: string, rule: any }> = [];

	constructor(region: string = 'us-west-1') {
		this.region = region;
		this.dbConnector = new DatabaseConnector(region);
		this.cfnManager = new CloudFormationManager(region);
		this.migrationManager = new MigrationManager(region);
		this.mfaAuth = new MfaAuthenticator(region);
		this.ec2Client = new EC2Client({ region });
		this.ssmClient = new SSMClient({ region });
	}

	/**
	 * Handle AWS API calls with automatic MFA authentication
	 */
	private async callWithMfaRetry<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (this.mfaAuth.isMfaRequired(error) && !this.mfaAuthenticated) {
				console.log(chalk.yellow('⚠️  MFA authentication required for AWS access'));

				const credentials = await this.mfaAuth.authenticateWithMfa();
				this.mfaAuth.applyCredentials(credentials);

				const clientConfig = {
					region: this.region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
						sessionToken: credentials.sessionToken
					}
				};

				this.ec2Client = new EC2Client(clientConfig);
				this.ssmClient = new SSMClient(clientConfig);
				this.mfaAuthenticated = true;
				return await operation();
			}
			throw error;
		}
	}

	/**
	 * Discover database connection info using existing proven patterns
	 */
	async discoverDatabase(config: {
		type: 'aws-managed' | 'external';
		environment?: string;
		database?: string;
		endpoint?: string;
		username?: string;
		password?: string;
	}): Promise<DatabaseConnection> {
		console.log(chalk.blue(`🔍 Discovering ${config.type} database connection...`));

		if (config.type === 'aws-managed') {
			// Try to discover from SSM parameter first
			const dbInfo = await this.discoverFromSSMParameter(config.environment!, config.database!);
			
			if (dbInfo) {
				// Found in SSM - could be legacy (direct password) or CDK (secret ARN)
				return dbInfo;
			}

			// Fallback: Use existing target database discovery (for databases only in CloudFormation outputs)
			const targetDatabases = await this.migrationManager.discoverTargetDatabases(config.environment!);
			const targetDb = targetDatabases.find(db => db.name === config.database);

			if (!targetDb) {
				throw new Error(`Database ${config.database} not found in environment ${config.environment}. Available databases: ${targetDatabases.map(db => db.name).join(', ')}`);
			}

			// Get password from secret
			const password = await this.dbConnector.getDatabasePassword(config.environment!, config.database!);

			// Use existing security group discovery
			const securityGroups = await this.cfnManager.discoverDatabaseSecurityGroups(
				targetDb.endpoint!,
				targetDb.endpoint!
			);

			return {
				endpoint: targetDb.endpoint!,
				port: parseInt(targetDb.port!),
				database: config.database === 'indicator' ? 'indicator_db' : `${config.database}_db`,
				username: 'fiftyten',
				password,
				type: 'rds',
				securityGroupIds: securityGroups.targetSecurityGroupIds
			};

		} else {
			// External database - discover security groups if it's RDS
			let securityGroupIds: string[] | undefined;

			if (config.endpoint?.includes('.rds.amazonaws.com')) {
				try {
					const securityGroups = await this.cfnManager.discoverDatabaseSecurityGroups(
						config.endpoint,
						config.endpoint
					);
					securityGroupIds = securityGroups.legacySecurityGroupIds;
				} catch (error) {
					console.log(chalk.gray('   Could not discover security groups - treating as external database'));
				}
			}

			return {
				endpoint: config.endpoint!,
				port: 5432,
				database: config.database || 'postgres',
				username: config.username || 'postgres',
				password: config.password || '',
				type: securityGroupIds ? 'rds' : 'external',
				securityGroupIds
			};
		}
	}

	/**
	 * Discover database from SSM parameter (handles both legacy and CDK patterns)
	 */
	private async discoverFromSSMParameter(environment: string, database: string): Promise<DatabaseConnection | null> {
		// Try multiple SSM parameter patterns
		const patterns = [
			`/indicator/indicator-api/${environment}/${database}-database-environment-variables`, // legacy-database-environment-variables
			`/indicator/indicator-api/${environment}/database-environment-variables`, // Standard pattern
			`/indicator/${database}-api/${environment}/database-environment-variables` // Other app pattern
		];

		for (const parameterName of patterns) {
			try {
				console.log(chalk.gray(`   Trying SSM parameter: ${parameterName}`));
				
				const response = await this.callWithMfaRetry(async () => {
					return await this.ssmClient.send(new GetParameterCommand({ Name: parameterName }));
				});

				if (!response.Parameter?.Value) {
					continue;
				}

				const dbInfo = JSON.parse(response.Parameter.Value);
				console.log(chalk.green(`✅ Found database in SSM: ${parameterName}`));

				// Determine if this uses direct password or secret ARN
				let password: string;
				if (dbInfo.DATABASE_PASSWORD) {
					// Legacy pattern - direct password
					console.log(chalk.blue('   Using direct password from SSM'));
					password = dbInfo.DATABASE_PASSWORD;
				} else if (dbInfo.DATABASE_SECRET_ARN) {
					// CDK pattern - secret ARN
					console.log(chalk.blue('   Getting password from Secrets Manager'));
					password = await this.getSecretPassword(dbInfo.DATABASE_SECRET_ARN);
				} else {
					console.log(chalk.yellow('   No password or secret ARN found in parameter'));
					continue;
				}

				// Use existing security group discovery
				const securityGroups = await this.cfnManager.discoverDatabaseSecurityGroups(
					dbInfo.DATABASE_HOST,
					dbInfo.DATABASE_HOST
				);

				return {
					endpoint: dbInfo.DATABASE_HOST,
					port: parseInt(dbInfo.DATABASE_PORT),
					database: dbInfo.DATABASE_NAME,
					username: dbInfo.DATABASE_USER,
					password,
					type: 'rds',
					securityGroupIds: securityGroups.legacySecurityGroupIds || securityGroups.targetSecurityGroupIds
				};

			} catch (error) {
				// Parameter not found, try next pattern
				continue;
			}
		}

		// No SSM parameter found
		return null;
	}

	/**
	 * Get password from AWS Secrets Manager
	 */
	private async getSecretPassword(secretArn: string): Promise<string> {
		// Use the existing method from DatabaseConnector
		const secretsClient = new (await import('@aws-sdk/client-secrets-manager')).SecretsManagerClient({ region: this.region });
		
		const response = await this.callWithMfaRetry(async () => {
			const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
			return await secretsClient.send(new GetSecretValueCommand({
				SecretId: secretArn
			}));
		});

		if (!response.SecretString) {
			throw new Error(`Secret value not found: ${secretArn}`);
		}

		const secretValue = JSON.parse(response.SecretString);
		return secretValue.password || secretValue.Password || secretValue.SECRET || '';
	}

	/**
	 * Setup tunnel with automatic security group configuration
	 */
	async setupTunnel(database: DatabaseConnection, localPort: number, environment: string): Promise<TunnelInfo> {
		if (database.type === 'external') {
			throw new Error('Tunnels not needed for external databases - connect directly');
		}

		console.log(chalk.blue(`🔗 Setting up tunnel for ${database.endpoint}...`));

		// Find bastion instance using existing pattern
		const bastionInstanceId = await this.getBastionInstanceId(environment);

		// Configure security groups if needed
		if (database.securityGroupIds?.length) {
			await this.configureTunnelAccess(database, bastionInstanceId);
		}

		// Create tunnel process
		const tunnelProcess = await this.createTunnelProcess(
			bastionInstanceId,
			database.endpoint,
			database.port,
			localPort
		);

		// Wait for tunnel to be ready and verify it's actually working
		console.log(chalk.gray(`   Waiting for tunnel on port ${localPort}...`));
		
		// Wait up to 30 seconds for the tunnel to establish
		const maxRetries = 30;
		let retries = 0;
		let tunnelReady = false;
		
		while (retries < maxRetries && !tunnelReady) {
			await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
			
			try {
				// Check if port is actually listening
				const net = await import('net');
				const testSocket = new net.Socket();
				
				await new Promise<void>((resolve, reject) => {
					testSocket.setTimeout(1000);
					testSocket.on('connect', () => {
						testSocket.destroy();
						tunnelReady = true;
						resolve();
					});
					testSocket.on('timeout', () => {
						testSocket.destroy();
						reject(new Error('timeout'));
					});
					testSocket.on('error', () => {
						testSocket.destroy();
						reject(new Error('connection failed'));
					});
					testSocket.connect(localPort, 'localhost');
				});
				
			} catch (error) {
				// Port not ready yet, continue waiting
				retries++;
			}
		}

		if (!tunnelReady) {
			// Kill the tunnel process since it failed
			if (tunnelProcess && !tunnelProcess.killed) {
				tunnelProcess.kill('SIGTERM');
			}
			throw new Error(`Tunnel failed to establish after ${maxRetries} seconds. Check SSM Agent connectivity on bastion host.`);
		}

		const tunnelInfo: TunnelInfo = {
			...database,
			tunnelProcess,
			localPort,
			bastionInstanceId,
			endpoint: 'localhost',
			port: localPort
		};

		this.activeTunnels.push(tunnelInfo);
		console.log(chalk.green(`✅ Tunnel ready: localhost:${localPort}`));

		return tunnelInfo;
	}

	/**
	 * Configure security groups for tunnel access using existing patterns
	 */
	private async configureTunnelAccess(database: DatabaseConnection, bastionInstanceId: string): Promise<void> {
		console.log(chalk.blue('🔧 Configuring security groups for tunnel access...'));

		// Get bastion security group
		const bastionSecurityGroupId = await this.getBastionSecurityGroup(bastionInstanceId);

		// Add temporary rules to database security groups
		for (const dbSecurityGroupId of database.securityGroupIds!) {
			try {
				const rule = {
					IpProtocol: 'tcp',
					FromPort: database.port,
					ToPort: database.port,
					UserIdGroupPairs: [{
						GroupId: bastionSecurityGroupId,
						Description: `Temporary tunnel access from bastion ${bastionInstanceId}`
					}]
				};

				await this.callWithMfaRetry(async () => {
					return await this.ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
						GroupId: dbSecurityGroupId,
						IpPermissions: [rule]
					}));
				});

				this.addedSecurityGroupRules.push({ groupId: dbSecurityGroupId, rule });
				console.log(chalk.green(`   ✅ Added ingress rule to ${dbSecurityGroupId}`));

			} catch (error) {
				if (error instanceof Error && error.message.includes('already exists')) {
					console.log(chalk.gray(`   ℹ️  Rule already exists in ${dbSecurityGroupId}`));
				} else {
					console.log(chalk.yellow(`   ⚠️  Could not add rule to ${dbSecurityGroupId}: ${error instanceof Error ? error.message : String(error)}`));
				}
			}
		}
	}

	/**
	 * Get bastion instance ID for the given environment using CDK-first discovery
	 * 
	 * Discovery Strategy:
	 * 1. Primary: CDK bastion pattern (indicator-bastion-{env}-host)
	 * 2. Fallback: Multiple naming patterns for compatibility
	 * 3. All bastions use Session Manager for secure access
	 */
	private async getBastionInstanceId(environment: string): Promise<string> {
		console.log(chalk.gray(`   Searching for CDK bastion: indicator-bastion-${environment}-host`));
		
		// Primary: Try CDK bastion pattern
		try {
			const response = await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(new DescribeInstancesCommand({
					Filters: [
						{
							Name: 'tag:Name',
							Values: [`indicator-bastion-${environment}-host`]
						},
						{
							Name: 'instance-state-name',
							Values: ['running']
						}
					]
				}));
			});

			const instances = response.Reservations?.flatMap(r => r.Instances || []) || [];
			if (instances.length > 0) {
				const instance = instances[0];
				if (instance.InstanceId) {
					const bastionName = instance.Tags?.find(t => t.Key === 'Name')?.Value || 'unknown';
					console.log(chalk.green(`✅ Found CDK bastion: ${instance.InstanceId} (${bastionName})`));
					return instance.InstanceId;
				}
			}
		} catch (error) {
			console.log(chalk.yellow(`   CDK bastion discovery failed, trying fallback patterns...`));
		}

		// Fallback: Try alternative naming patterns for compatibility
		const fallbackPatterns = [
			`bastion-${environment}`,
			`${environment}-bastion`,
			`indicator-${environment}-bastion`
		];

		for (const pattern of fallbackPatterns) {
			try {
				console.log(chalk.gray(`   Trying pattern: ${pattern}`));
				
				const response = await this.callWithMfaRetry(async () => {
					return await this.ec2Client.send(new DescribeInstancesCommand({
						Filters: [
							{
								Name: 'tag:Name',
								Values: [pattern]
							},
							{
								Name: 'instance-state-name',
								Values: ['running']
							}
						]
					}));
				});

				const instances = response.Reservations?.flatMap(r => r.Instances || []) || [];
				if (instances.length > 0) {
					const instance = instances[0];
					if (instance.InstanceId) {
						const bastionName = instance.Tags?.find(t => t.Key === 'Name')?.Value || 'unknown';
						console.log(chalk.green(`✅ Found bastion: ${instance.InstanceId} (${bastionName})`));
						return instance.InstanceId;
					}
				}
			} catch (error) {
				console.log(chalk.gray(`   Pattern ${pattern} not found, continuing...`));
			}
		}

		throw new Error(`No running bastion instance found for environment: ${environment}. Tried CDK pattern (indicator-bastion-${environment}-host) and fallback patterns: ${fallbackPatterns.join(', ')}.`);
	}

	/**
	 * Get bastion security group
	 */
	private async getBastionSecurityGroup(instanceId: string): Promise<string> {
		const response = await this.callWithMfaRetry(async () => {
			return await this.ec2Client.send(new DescribeInstancesCommand({
				InstanceIds: [instanceId]
			}));
		});

		const instance = response.Reservations?.[0]?.Instances?.[0];
		const securityGroups = instance?.SecurityGroups || [];

		if (securityGroups.length === 0) {
			throw new Error(`No security groups found for bastion instance: ${instanceId}`);
		}

		return securityGroups[0].GroupId!;
	}

	/**
	 * Create tunnel process
	 */
	private async createTunnelProcess(bastionInstanceId: string, targetHost: string, targetPort: number, localPort: number): Promise<ChildProcess> {
		const sessionCommand = [
			'ssm', 'start-session',
			'--target', bastionInstanceId,
			'--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
			'--parameters', JSON.stringify({
				host: [targetHost],
				portNumber: [targetPort.toString()],
				localPortNumber: [localPort.toString()]
			}),
			'--region', this.region
		];

		console.log(chalk.gray(`   Starting tunnel: aws ${sessionCommand.join(' ')}`));

		const tunnelProcess = spawn('aws', sessionCommand, {
			stdio: ['inherit', 'pipe', 'pipe']
		});

		// Handle tunnel output
		tunnelProcess.stdout?.on('data', (data) => {
			const message = data.toString();
			console.log(chalk.blue(`   Tunnel stdout: ${message.trim()}`));
			if (message.includes('Port forwarding session started')) {
				console.log(chalk.green('   ✅ Port forwarding session started'));
			}
		});

		tunnelProcess.stderr?.on('data', (data) => {
			const message = data.toString();
			console.log(chalk.yellow(`   Tunnel stderr: ${message.trim()}`));
		});

		return tunnelProcess;
	}

	/**
	 * Perform PostgreSQL dump and restore migration using universal approach
	 */
	async performPgMigration(config: PgMigrationConfig): Promise<void> {
		console.log(chalk.blue('🚀 Starting PostgreSQL dump/restore migration...'));
		console.log('');
		console.log(chalk.green('📋 Migration Configuration:'));
		console.log(`   Environment: ${chalk.yellow(config.environment)}`);
		console.log(`   Source Database: ${chalk.yellow(config.sourceDatabase)}`);
		console.log(`   Target Database: ${chalk.yellow(config.targetDatabase)}`);
		console.log(`   Data Only: ${chalk.yellow(config.dataOnly ? 'Yes' : 'No')}`);
		if (config.skipTables?.length) {
			console.log(`   Skip Tables: ${chalk.yellow(config.skipTables.join(', '))}`);
		}
		if (config.includeTables?.length) {
			console.log(`   Include Tables: ${chalk.yellow(config.includeTables.join(', '))}`);
		}
		console.log('');

		// Confirm migration
		const confirm = await promptConfirmation('Start PostgreSQL migration with these settings?');
		if (!confirm) {
			console.log(chalk.yellow('Migration cancelled.'));
			return;
		}

		try {
			// Discover source database
			let sourceDb: DatabaseConnection;
			if (config.sourceEndpoint && config.sourceUsername && config.sourcePassword) {
				// External database
				sourceDb = await this.discoverDatabase({
					type: 'external',
					endpoint: config.sourceEndpoint,
					username: config.sourceUsername,
					password: config.sourcePassword,
					database: config.sourceDatabase
				});
				console.log(chalk.green(`✅ External source database: ${sourceDb.endpoint}`));
			} else {
				// AWS managed database
				sourceDb = await this.discoverDatabase({
					type: 'aws-managed',
					environment: config.environment,
					database: config.sourceDatabase
				});
			}

			// Discover target database (always AWS managed)
			const targetDb = await this.discoverDatabase({
				type: 'aws-managed',
				environment: config.environment,
				database: config.targetDatabase
			});

			// Execute sequential migration to avoid concurrent tunnel issues
			await this.executeSequentialMigration(sourceDb, targetDb, config);

			console.log(chalk.green('✅ PostgreSQL migration completed successfully!'));

		} catch (error) {
			console.error(chalk.red('❌ Migration failed:'), error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			// Cleanup any remaining resources
			await this.cleanup();
		}
	}

	/**
	 * Execute sequential migration to avoid concurrent tunnel conflicts
	 */
	private async executeSequentialMigration(sourceDb: DatabaseConnection, targetDb: DatabaseConnection, config: PgMigrationConfig): Promise<void> {
		const fs = await import('fs');
		const path = await import('path');
		const os = await import('os');
		
		// Create temporary file for dump
		const tempDir = os.tmpdir();
		const dumpFile = path.join(tempDir, `pg-migration-${Date.now()}.sql`);
		
		console.log(chalk.blue('📤 Phase 1: Dumping source database...'));
		
		let sourceConnection: DatabaseConnection | TunnelInfo | undefined;
		
		try {
			// Phase 1: Setup source connection and dump
			if (sourceDb.type === 'external') {
				sourceConnection = sourceDb;
				console.log(chalk.green(`✅ Using external source: ${sourceDb.endpoint}`));
			} else {
				sourceConnection = await this.setupTunnel(sourceDb, 5434, config.environment);
			}
			
			// Dump to file
			await this.dumpToFile(sourceConnection, config, dumpFile);
			
		} finally {
			// Close source tunnel if it was created
			if (sourceConnection && 'tunnelProcess' in sourceConnection) {
				console.log(chalk.gray('   Closing source tunnel...'));
				if (sourceConnection.tunnelProcess && !sourceConnection.tunnelProcess.killed) {
					sourceConnection.tunnelProcess.kill('SIGTERM');
				}
				// Remove source tunnel from active tunnels list
				this.activeTunnels = this.activeTunnels.filter(t => t.localPort !== (sourceConnection as TunnelInfo).localPort);
			}
		}
		
		console.log(chalk.blue('📥 Phase 2: Restoring to target database...'));
		
		let targetConnection: DatabaseConnection | TunnelInfo | undefined;
		
		try {
			// Phase 2: Setup target connection and restore
			targetConnection = await this.setupTunnel(targetDb, 5433, config.environment);
			
			// Restore from file
			await this.restoreFromFile(targetConnection, dumpFile);
			
		} finally {
			// Close target tunnel
			if (targetConnection && 'tunnelProcess' in targetConnection) {
				console.log(chalk.gray('   Closing target tunnel...'));
				if (targetConnection.tunnelProcess && !targetConnection.tunnelProcess.killed) {
					targetConnection.tunnelProcess.kill('SIGTERM');
				}
				// Remove target tunnel from active tunnels list
				this.activeTunnels = this.activeTunnels.filter(t => t.localPort !== (targetConnection as TunnelInfo).localPort);
			}
			
			// Clean up temporary file
			try {
				if (fs.existsSync(dumpFile)) {
					fs.unlinkSync(dumpFile);
					console.log(chalk.gray('   Cleaned up temporary dump file'));
				}
			} catch (error) {
				console.log(chalk.yellow(`   Warning: Could not clean up temporary file ${dumpFile}`));
			}
		}
	}

	/**
	 * Execute pg_dump and psql restore using sequential approach to avoid concurrent tunnel issues
	 */
	private async executePgDumpRestore(source: DatabaseConnection | TunnelInfo, target: DatabaseConnection | TunnelInfo, config: PgMigrationConfig): Promise<void> {
		const fs = await import('fs');
		const path = await import('path');
		const os = await import('os');
		
		// Create temporary file for dump
		const tempDir = os.tmpdir();
		const dumpFile = path.join(tempDir, `pg-migration-${Date.now()}.sql`);
		
		console.log(chalk.blue('📤 Phase 1: Dumping source database to temporary file...'));
		console.log(chalk.gray(`   Temp file: ${dumpFile}`));

		try {
			// Phase 1: Dump source database to file
			await this.dumpToFile(source, config, dumpFile);
			
			console.log(chalk.blue('📥 Phase 2: Restoring from temporary file to target database...'));
			
			// Phase 2: Restore from file to target database  
			await this.restoreFromFile(target, dumpFile);
			
			console.log(chalk.green('✅ Migration completed successfully!'));
			
		} finally {
			// Clean up temporary file
			try {
				if (fs.existsSync(dumpFile)) {
					fs.unlinkSync(dumpFile);
					console.log(chalk.gray('   Cleaned up temporary dump file'));
				}
			} catch (error) {
				console.log(chalk.yellow(`   Warning: Could not clean up temporary file ${dumpFile}`));
			}
		}
	}

	/**
	 * Dump source database to a temporary file
	 */
	private async dumpToFile(source: DatabaseConnection | TunnelInfo, config: PgMigrationConfig, outputFile: string): Promise<void> {
		const fs = await import('fs');
		
		// Build pg_dump command
		const dumpArgs = [
			'--host', source.endpoint,
			'--port', source.port.toString(),
			'--username', source.username,
			'--dbname', source.database,
			'--verbose',
			'--no-password',
			'--file', outputFile
		];

		// Add data-only flag if specified
		if (config.dataOnly) {
			dumpArgs.push('--data-only');
		}

		// Add table filtering
		if (config.skipTables?.length) {
			config.skipTables.forEach(table => {
				dumpArgs.push('--exclude-table', table);
			});
		}

		if (config.includeTables?.length) {
			config.includeTables.forEach(table => {
				dumpArgs.push('--table', table);
			});
		}

		// Set environment variables for source connection
		const sourceEnv = {
			...process.env,
			PGPASSWORD: source.password
		};

		console.log(chalk.gray(`   Running: pg_dump ${dumpArgs.join(' ')}`));
		
		return new Promise<void>((resolve, reject) => {
			const dumpProcess = spawn('pg_dump', dumpArgs, {
				env: sourceEnv,
				stdio: ['inherit', 'inherit', 'pipe']
			});

			let dumpError = '';

			dumpProcess.stderr.on('data', (data) => {
				const message = data.toString();
				// Filter out pg_dump info messages and only show real errors
				if (!message.includes('reading') && !message.includes('dumping') && message.includes('ERROR')) {
					console.error(chalk.red('   Dump error:'), message);
					dumpError += message;
				} else {
					// Show progress info in gray
					console.log(chalk.gray(`   ${message.trim()}`));
				}
			});

			dumpProcess.on('close', (code) => {
				if (code === 0) {
					// Verify file was created and has content
					if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
						const fileSize = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(2);
						console.log(chalk.green(`   ✅ Dump completed successfully (${fileSize} MB)`));
						resolve();
					} else {
						reject(new Error('Dump file was not created or is empty'));
					}
				} else {
					reject(new Error(`pg_dump failed with code ${code}${dumpError ? ': ' + dumpError : ''}`));
				}
			});

			dumpProcess.on('error', (error) => {
				reject(new Error(`Failed to start pg_dump: ${error.message}`));
			});
		});
	}

	/**
	 * Restore from temporary file to target database
	 */
	private async restoreFromFile(target: DatabaseConnection | TunnelInfo, inputFile: string): Promise<void> {
		const fs = await import('fs');
		
		if (!fs.existsSync(inputFile)) {
			throw new Error(`Dump file not found: ${inputFile}`);
		}

		// Build psql restore command
		const restoreArgs = [
			'--host', target.endpoint,
			'--port', target.port.toString(),
			'--username', target.username,
			'--dbname', target.database,
			'--no-password',
			'--file', inputFile
		];

		// Set environment variables for target connection
		const targetEnv = {
			...process.env,
			PGPASSWORD: target.password
		};

		console.log(chalk.gray(`   Running: psql ${restoreArgs.join(' ')}`));
		
		return new Promise<void>((resolve, reject) => {
			const restoreProcess = spawn('psql', restoreArgs, {
				env: targetEnv,
				stdio: ['inherit', 'inherit', 'pipe']
			});

			let restoreError = '';

			restoreProcess.stderr.on('data', (data) => {
				const message = data.toString();
				// Filter out psql info messages and only show real errors
				if (message.includes('ERROR')) {
					console.error(chalk.red('   Restore error:'), message);
					restoreError += message;
				} else {
					// Show progress info in gray
					console.log(chalk.gray(`   ${message.trim()}`));
				}
			});

			restoreProcess.on('close', (code) => {
				if (code === 0) {
					console.log(chalk.green('   ✅ Restore completed successfully'));
					resolve();
				} else {
					reject(new Error(`psql restore failed with code ${code}${restoreError ? ': ' + restoreError : ''}`));
				}
			});

			restoreProcess.on('error', (error) => {
				reject(new Error(`Failed to start psql: ${error.message}`));
			});
		});
	}

	/**
	 * Test connection to both databases using universal approach
	 */
	async testConnections(config: PgMigrationConfig): Promise<void> {
		console.log(chalk.blue('🔍 Testing database connections...'));

		let sourceConnection: DatabaseConnection | TunnelInfo;
		let targetConnection: DatabaseConnection | TunnelInfo;

		try {
			// Setup source connection
			if (config.sourceEndpoint && config.sourceUsername && config.sourcePassword) {
				sourceConnection = await this.discoverDatabase({
					type: 'external',
					endpoint: config.sourceEndpoint,
					username: config.sourceUsername,
					password: config.sourcePassword,
					database: config.sourceDatabase
				});
			} else {
				const sourceDb = await this.discoverDatabase({
					type: 'aws-managed',
					environment: config.environment,
					database: config.sourceDatabase
				});
				sourceConnection = await this.setupTunnel(sourceDb, 5434, config.environment);
			}

			// Setup target connection
			const targetDb = await this.discoverDatabase({
				type: 'aws-managed',
				environment: config.environment,
				database: config.targetDatabase
			});
			targetConnection = await this.setupTunnel(targetDb, 5433, config.environment);

			// Test connections
			console.log(chalk.blue('   Testing source database connection...'));
			await this.testConnection(sourceConnection, 'Source');

			console.log(chalk.blue('   Testing target database connection...'));
			await this.testConnection(targetConnection, 'Target');

			console.log(chalk.green('✅ All database connections successful!'));

		} catch (error) {
			console.error(chalk.red('❌ Connection test failed:'), error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			await this.cleanup();
		}
	}

	/**
	 * Test a single database connection
	 */
	private async testConnection(connection: DatabaseConnection | TunnelInfo, label: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const testArgs = [
				'--host', connection.endpoint,
				'--port', connection.port.toString(),
				'--username', connection.username,
				'--dbname', connection.database,
				'--command', 'SELECT version();',
				'--no-password'
			];

			const testEnv = {
				...process.env,
				PGPASSWORD: connection.password
			};

			const testProcess = spawn('psql', testArgs, {
				env: testEnv,
				stdio: ['inherit', 'pipe', 'pipe']
			});

			let output = '';
			let error = '';

			testProcess.stdout.on('data', (data) => {
				output += data.toString();
			});

			testProcess.stderr.on('data', (data) => {
				error += data.toString();
			});

			testProcess.on('close', (code) => {
				if (code === 0) {
					console.log(chalk.green(`      ✅ ${label} connection successful`));
					if (output.includes('PostgreSQL')) {
						const version = output.match(/PostgreSQL [\d.]+/)?.[0];
						if (version) {
							console.log(chalk.gray(`         ${version}`));
						}
					}
					resolve();
				} else {
					reject(new Error(`${label} connection failed: ${error || 'Unknown error'}`));
				}
			});
		});
	}

	/**
	 * Cleanup all tunnels and security group rules using existing patterns
	 */
	async cleanup(): Promise<void> {
		console.log(chalk.blue('🧹 Cleaning up tunnels and security group rules...'));

		// Close tunnels
		for (const tunnel of this.activeTunnels) {
			if (tunnel.tunnelProcess && !tunnel.tunnelProcess.killed) {
				tunnel.tunnelProcess.kill('SIGTERM');
				console.log(chalk.gray(`   Closed tunnel on port ${tunnel.localPort}`));
			}
		}

		this.activeTunnels = [];

		// Remove security group rules using existing pattern
		for (const rule of this.addedSecurityGroupRules) {
			try {
				await this.callWithMfaRetry(async () => {
					return await this.ec2Client.send(new RevokeSecurityGroupIngressCommand({
						GroupId: rule.groupId,
						IpPermissions: [rule.rule]
					}));
				});
				console.log(chalk.green(`   ✅ Removed rule from ${rule.groupId}`));
			} catch (error) {
				console.log(chalk.yellow(`   ⚠️  Could not remove rule from ${rule.groupId}: ${error instanceof Error ? error.message : String(error)}`));
			}
		}

		this.addedSecurityGroupRules = [];

		// Give processes time to clean up
		await new Promise(resolve => setTimeout(resolve, 1000));
		console.log(chalk.green('✅ Cleanup completed'));
	}

	/**
	 * Get migration statistics by comparing row counts
	 */
	async getMigrationStats(config: PgMigrationConfig): Promise<void> {
		console.log(chalk.blue('📊 Getting migration statistics...'));

		let sourceConnection: DatabaseConnection | TunnelInfo;
		let targetConnection: DatabaseConnection | TunnelInfo;

		try {
			// Setup connections
			if (config.sourceEndpoint && config.sourceUsername && config.sourcePassword) {
				sourceConnection = await this.discoverDatabase({
					type: 'external',
					endpoint: config.sourceEndpoint,
					username: config.sourceUsername,
					password: config.sourcePassword,
					database: config.sourceDatabase
				});
			} else {
				const sourceDb = await this.discoverDatabase({
					type: 'aws-managed',
					environment: config.environment,
					database: config.sourceDatabase
				});
				sourceConnection = await this.setupTunnel(sourceDb, 5434, config.environment);
			}

			const targetDb = await this.discoverDatabase({
				type: 'aws-managed',
				environment: config.environment,
				database: config.targetDatabase
			});
			targetConnection = await this.setupTunnel(targetDb, 5433, config.environment);

			// Get table list from source
			const sourceTables = await this.getTableList(sourceConnection);
			const targetTables = await this.getTableList(targetConnection);

			console.log(chalk.green('📋 Migration Statistics:'));
			console.log('');
			console.log(chalk.gray('   Table Name'.padEnd(30) + 'Source Rows'.padEnd(15) + 'Target Rows'.padEnd(15) + 'Status'));
			console.log(chalk.gray('   ' + '-'.repeat(70)));

			for (const table of sourceTables) {
				const sourceCount = await this.getTableRowCount(sourceConnection, table);
				const targetCount = targetTables.includes(table) ? await this.getTableRowCount(targetConnection, table) : 0;

				const status = sourceCount === targetCount ?
					chalk.green('✅ Match') :
					chalk.yellow(`⚠️  Diff (${targetCount - sourceCount})`);

				console.log(`   ${table.padEnd(30)}${sourceCount.toString().padEnd(15)}${targetCount.toString().padEnd(15)}${status}`);
			}

			console.log('');
			console.log(chalk.green('✅ Statistics generated successfully'));

		} catch (error) {
			console.error(chalk.red('❌ Failed to get statistics:'), error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			await this.cleanup();
		}
	}

	/**
	 * Get list of tables from database
	 */
	private async getTableList(connection: DatabaseConnection | TunnelInfo): Promise<string[]> {
		return new Promise<string[]>((resolve, reject) => {
			const queryArgs = [
				'--host', connection.endpoint,
				'--port', connection.port.toString(),
				'--username', connection.username,
				'--dbname', connection.database,
				'--tuples-only',
				'--no-align',
				'--command', "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
				'--no-password'
			];

			const queryEnv = {
				...process.env,
				PGPASSWORD: connection.password
			};

			const queryProcess = spawn('psql', queryArgs, {
				env: queryEnv,
				stdio: ['inherit', 'pipe', 'pipe']
			});

			let output = '';
			let error = '';

			queryProcess.stdout.on('data', (data) => {
				output += data.toString();
			});

			queryProcess.stderr.on('data', (data) => {
				error += data.toString();
			});

			queryProcess.on('close', (code) => {
				if (code === 0) {
					const tables = output.trim().split('\n').filter(line => line.trim().length > 0);
					resolve(tables);
				} else {
					reject(new Error(`Failed to get table list: ${error}`));
				}
			});
		});
	}

	/**
	 * Get row count for a specific table
	 */
	private async getTableRowCount(connection: DatabaseConnection | TunnelInfo, tableName: string): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const queryArgs = [
				'--host', connection.endpoint,
				'--port', connection.port.toString(),
				'--username', connection.username,
				'--dbname', connection.database,
				'--tuples-only',
				'--no-align',
				'--command', `SELECT COUNT(*) FROM "${tableName}";`,
				'--no-password'
			];

			const queryEnv = {
				...process.env,
				PGPASSWORD: connection.password
			};

			const queryProcess = spawn('psql', queryArgs, {
				env: queryEnv,
				stdio: ['inherit', 'pipe', 'pipe']
			});

			let output = '';
			let error = '';

			queryProcess.stdout.on('data', (data) => {
				output += data.toString();
			});

			queryProcess.stderr.on('data', (data) => {
				error += data.toString();
			});

			queryProcess.on('close', (code) => {
				if (code === 0) {
					const count = parseInt(output.trim()) || 0;
					resolve(count);
				} else {
					reject(new Error(`Failed to get row count for ${tableName}: ${error}`));
				}
			});
		});
	}
}

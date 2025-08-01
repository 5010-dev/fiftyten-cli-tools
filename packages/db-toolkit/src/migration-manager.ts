import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DatabaseMigrationServiceClient, DescribeReplicationTasksCommand, StartReplicationTaskCommand, StopReplicationTaskCommand, DescribeTableStatisticsCommand, TestConnectionCommand, DescribeConnectionsCommand } from '@aws-sdk/client-database-migration-service';
import chalk from 'chalk';
import * as readline from 'readline';
import { MfaAuthenticator } from './mfa-auth';
import { CloudFormationManager } from './cloudformation-manager';

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

export interface MigrationConfig {
	environment: string;
	legacyEndpoint: string;
	legacyDatabase: string;
	legacyUsername: string;
	legacyPassword: string;
	targetSecretArn: string;
	migrationType?: 'full-load' | 'full-load-and-cdc';
	notificationEmails?: string[];
}

export interface TargetDatabase {
	name: string;
	friendlyName: string;
	secretArn: string;
	endpoint?: string;
	port?: string;
}

export interface MigrationStatus {
	taskArn: string;
	taskId: string;
	status: string;
	progress: number;
	fullLoadProgressPercent?: number;
	cdcStartDate?: Date;
	stopReason?: string;
	replicationTaskCreationDate?: Date;
	replicationTaskStartDate?: Date;
}

export interface TableStatistics {
	tableName: string;
	fullLoadRows: number;
	fullLoadCondtnlChkFailedRows: number;
	fullLoadErrorRows: number;
	fullLoadStartTime?: Date;
	fullLoadEndTime?: Date;
	lastUpdateTime?: Date;
	tableState: string;
}

export class MigrationManager {
	private cfnClient: CloudFormationClient;
	private dmsClient: DatabaseMigrationServiceClient;
	private cfnManager: CloudFormationManager;
	private mfaAuth: MfaAuthenticator;
	private region: string;
	private mfaAuthenticated: boolean = false;

	constructor(region: string = 'us-west-1') {
		this.region = region;
		this.cfnClient = new CloudFormationClient({ region });
		this.dmsClient = new DatabaseMigrationServiceClient({ region });
		this.cfnManager = new CloudFormationManager(region);
		this.mfaAuth = new MfaAuthenticator(region);
	}

	/**
	 * Handle AWS API calls with automatic MFA authentication
	 */
	private async callWithMfaRetry<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			// Check if this is an MFA-related error and we haven't already authenticated
			if (this.mfaAuth.isMfaRequired(error) && !this.mfaAuthenticated) {
				console.log(chalk.yellow('⚠️  MFA authentication required for AWS access'));

				// Attempt MFA authentication
				const credentials = await this.mfaAuth.authenticateWithMfa();
				this.mfaAuth.applyCredentials(credentials);

				// Recreate clients with new credentials
				const clientConfig = {
					region: this.region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
						sessionToken: credentials.sessionToken
					}
				};
				this.cfnClient = new CloudFormationClient(clientConfig);
				this.dmsClient = new DatabaseMigrationServiceClient(clientConfig);

				// Mark as authenticated to prevent re-prompting
				this.mfaAuthenticated = true;

				// Retry the operation
				return await operation();
			}

			// Re-throw if not MFA-related or already authenticated
			throw error;
		}
	}

	/**
	 * Discover available target databases from CloudFormation stacks
	 */
	async discoverTargetDatabases(environment: string): Promise<TargetDatabase[]> {
		console.log(chalk.blue('🔍 Discovering available target databases...'));

		const targetDatabases: TargetDatabase[] = [];
		const stackName = `indicator-storage-infra-${environment}`;

		try {
			const stack = await this.callWithMfaRetry(async () => {
				const command = new DescribeStacksCommand({ StackName: stackName });
				return await this.cfnClient.send(command);
			});

			const stackInfo = stack.Stacks?.[0];
			if (!stackInfo) {
				console.log(chalk.yellow(`⚠️  Storage infrastructure stack not found: ${stackName}`));
				return targetDatabases;
			}

			const outputs = stackInfo.Outputs || [];

			// Look for indicator database
			const indicatorSecretArn = outputs.find(output =>
				output.OutputKey === 'IndicatorDatabaseSecretArn'
			)?.OutputValue;

			const indicatorEndpoint = outputs.find(output =>
				output.OutputKey === 'IndicatorDatabaseEndpoint'
			)?.OutputValue;

			const indicatorPort = outputs.find(output =>
				output.OutputKey === 'IndicatorDatabasePort'
			)?.OutputValue;

			if (indicatorSecretArn) {
				targetDatabases.push({
					name: 'indicator',
					friendlyName: 'Indicator Database',
					secretArn: indicatorSecretArn,
					endpoint: indicatorEndpoint,
					port: indicatorPort,
				});
			}

			// Look for copytrading database (if it exists)
			const copytradingSecretArn = outputs.find(output =>
				output.OutputKey === 'CopytradingDatabaseSecretArn'
			)?.OutputValue;

			if (copytradingSecretArn) {
				const copytradingEndpoint = outputs.find(output =>
					output.OutputKey === 'CopytradingDatabaseEndpoint'
				)?.OutputValue;

				const copytradingPort = outputs.find(output =>
					output.OutputKey === 'CopytradingDatabasePort'
				)?.OutputValue;

				targetDatabases.push({
					name: 'copytrading',
					friendlyName: 'Copy Trading Database',
					secretArn: copytradingSecretArn,
					endpoint: copytradingEndpoint,
					port: copytradingPort,
				});
			}

			// Look for any other database patterns
			const otherSecretOutputs = outputs.filter(output =>
				output.OutputKey?.endsWith('DatabaseSecretArn') &&
				!['IndicatorDatabaseSecretArn', 'CopytradingDatabaseSecretArn'].includes(output.OutputKey)
			);

			for (const secretOutput of otherSecretOutputs) {
				const baseName = secretOutput.OutputKey!.replace('DatabaseSecretArn', '');
				const endpointKey = `${baseName}DatabaseEndpoint`;
				const portKey = `${baseName}DatabasePort`;

				const endpoint = outputs.find(output => output.OutputKey === endpointKey)?.OutputValue;
				const port = outputs.find(output => output.OutputKey === portKey)?.OutputValue;

				targetDatabases.push({
					name: baseName.toLowerCase(),
					friendlyName: `${baseName} Database`,
					secretArn: secretOutput.OutputValue!,
					endpoint,
					port,
				});
			}

			if (targetDatabases.length > 0) {
				console.log(chalk.green(`✅ Found ${targetDatabases.length} target database(s):`));
				targetDatabases.forEach(db => {
					console.log(`   ${chalk.yellow(db.friendlyName)} (${db.name})`);
					if (db.endpoint) {
						console.log(chalk.gray(`      ${db.endpoint}:${db.port}`));
					}
				});
				console.log('');
			} else {
				console.log(chalk.yellow('⚠️  No target databases found in storage infrastructure'));
				console.log(chalk.gray('   Make sure the storage infrastructure is deployed first'));
				console.log('');
			}

		} catch (error) {
			console.log(chalk.yellow(`⚠️  Could not access storage infrastructure stack: ${stackName}`));
			console.log(chalk.gray('   Stack may not be deployed or you may not have access'));
			console.log('');
		}

		return targetDatabases;
	}

	/**
	 * Deploy migration infrastructure using CloudFormation
	 */
	async deployMigration(config: MigrationConfig): Promise<void> {
		console.log(chalk.blue('🚀 Deploying database migration infrastructure...'));
		console.log('');
		console.log(chalk.green('📋 Migration Configuration:'));
		console.log(`   Environment: ${chalk.yellow(config.environment)}`);
		console.log(`   Source Database: ${chalk.yellow(config.legacyEndpoint + '/' + config.legacyDatabase)}`);
		console.log(`   Target Secret: ${chalk.yellow(config.targetSecretArn)}`);
		console.log(`   Migration Type: ${chalk.yellow(config.migrationType || 'full-load-and-cdc')}`);
		console.log('');

		// Confirm deployment
		const confirm = await promptConfirmation('Deploy migration infrastructure with these settings?');

		if (!confirm) {
			console.log(chalk.yellow('Migration deployment cancelled.'));
			return;
		}

		// Deploy using CloudFormation API directly
		const stackName = `indicator-migration-stack-${config.environment}`;

		await this.cfnManager.deployStack({
			stackName,
			region: this.region,
			parameters: {
				environmentName: config.environment,
				vpcId: '', // Will be auto-discovered
				subnetIds: [], // Will be auto-discovered
				legacyEndpoint: config.legacyEndpoint,
				legacyDatabase: config.legacyDatabase,
				legacyUsername: config.legacyUsername,
				legacyPassword: config.legacyPassword,
				targetSecretArn: config.targetSecretArn,
				migrationType: config.migrationType,
				notificationEmails: config.notificationEmails
			}
		});
	}


	/**
	 * Validate that both source and target endpoint connections are successful
	 */
	private async validateEndpointConnections(environment: string): Promise<void> {
		console.log(chalk.blue('🔍 Validating endpoint connections...'));

		const stackName = `indicator-migration-stack-${environment}`;
		const outputs = await this.cfnManager.getStackOutputs(stackName);

		const sourceEndpointArn = outputs['SourceEndpointArn'];
		const targetEndpointArn = outputs['TargetEndpointArn'];
		const replicationInstanceArn = outputs['ReplicationInstanceArn'];

		if (!sourceEndpointArn || !targetEndpointArn || !replicationInstanceArn) {
			throw new Error('Missing endpoint or replication instance ARNs in stack outputs');
		}

		console.log(chalk.gray(`   Source ARN: ${sourceEndpointArn}`));
		console.log(chalk.gray(`   Target ARN: ${targetEndpointArn}`));
		console.log(chalk.gray(`   Replication Instance ARN: ${replicationInstanceArn}`));
		console.log('');

		// Test source endpoint connection
		console.log(chalk.blue('   Testing source endpoint connection...'));
		await this.testAndWaitForConnection(replicationInstanceArn, sourceEndpointArn, 'source');

		// Test target endpoint connection  
		console.log(chalk.blue('   Testing target endpoint connection...'));
		await this.testAndWaitForConnection(replicationInstanceArn, targetEndpointArn, 'target');

		console.log(chalk.green('✅ All endpoint connections validated successfully!'));
		console.log('');
	}

	/**
	 * Test connection and wait for successful result with simplified retry logic
	 */
	private async testAndWaitForConnection(replicationInstanceArn: string, endpointArn: string, endpointType: string): Promise<void> {
		const maxRetries = 2; // Reduce retries to avoid MFA issues
		let retryCount = 0;

		while (retryCount < maxRetries) {
			try {
				if (retryCount > 0) {
					console.log(chalk.yellow(`      🔄 Retrying ${endpointType} endpoint connection (attempt ${retryCount + 1}/${maxRetries})...`));
					await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds before retry
				}

				// Start connection test
				console.log(chalk.blue(`      🧪 Starting ${endpointType} endpoint connection test...`));
				const testCommand = new TestConnectionCommand({
					ReplicationInstanceArn: replicationInstanceArn,
					EndpointArn: endpointArn
				});
				await this.dmsClient.send(testCommand);

				// Wait for connection test to complete with reduced polling
				let attempts = 0;
				const maxAttempts = 18; // 3 minutes max wait per attempt (18 * 10s)

				while (attempts < maxAttempts) {
					await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

					try {
						// Use direct client call to avoid MFA retry loops during polling
						const describeCommand = new DescribeConnectionsCommand({
							Filters: [
								{ Name: 'replication-instance-arn', Values: [replicationInstanceArn] },
								{ Name: 'endpoint-arn', Values: [endpointArn] }
							]
						});
						const connections = await this.dmsClient.send(describeCommand);

						const connection = connections.Connections?.[0];
						console.log(chalk.gray(`      📊 Connection status: ${connection?.Status || 'unknown'}`));

						if (connection?.Status === 'successful') {
							console.log(chalk.green(`      ✅ ${endpointType} endpoint connection successful`));
							return; // Success! Exit the retry loop
						} else if (connection?.Status === 'failed') {
							const error = connection.LastFailureMessage || 'Connection test failed';
							console.log(chalk.red(`      ❌ ${endpointType} endpoint connection failed:`));
							console.log(chalk.red(`         ${error}`));

							// If this is the last retry, throw the error
							if (retryCount === maxRetries - 1) {
								throw new Error(`${endpointType} endpoint connection failed after ${maxRetries} attempts: ${error}`);
							}

							// Otherwise, break out of the wait loop to retry
							break;
						}

						// Still testing, continue waiting
						process.stdout.write(`\r      ⏳ Testing ${endpointType} endpoint connection... (${attempts + 1}/${maxAttempts})`);

					} catch (apiError) {
						// Handle session token errors gracefully - don't fail the entire test
						if (apiError instanceof Error && apiError.message.includes('Cannot call GetSessionToken with session credentials')) {
							console.log(chalk.yellow(`      ⚠️  Session token limitation - continuing with existing credentials`));
							// Continue the loop, don't break or fail
						} else {
							console.log(chalk.yellow(`      ⚠️  API error while checking connection status: ${apiError instanceof Error ? apiError.message : String(apiError)}`));
						}
						// Continue waiting in both cases
					}

					attempts++;
				}

				// If we get here, the test timed out
				if (retryCount === maxRetries - 1) {
					throw new Error(`${endpointType} endpoint connection test timed out after ${maxRetries} attempts (3 minutes each)`);
				}

				console.log(chalk.yellow(`      ⏱️  ${endpointType} endpoint connection test timed out, retrying...`));

			} catch (error) {
				console.log(chalk.red(`      ❌ Error during ${endpointType} endpoint test: ${error instanceof Error ? error.message : String(error)}`));

				if (retryCount === maxRetries - 1) {
					// Final attempt failed, re-throw the error
					throw error;
				}
			}

			retryCount++;
		}
	}

	/**
	 * Get migration task ARN from stack outputs
	 */
	private async getMigrationTaskArn(environment: string): Promise<string> {
		const stackName = `indicator-migration-stack-${environment}`;
		const outputs = await this.cfnManager.getStackOutputs(stackName);

		const taskArn = outputs['MigrationTaskArn'];
		if (!taskArn) {
			throw new Error(`Migration task ARN not found in stack outputs for environment: ${environment}`);
		}

		return taskArn;
	}

	/**
	 * Start migration task
	 */
	async startMigration(environment: string): Promise<void> {
		console.log(chalk.blue('🚀 Starting database migration...'));

		try {
			const taskArn = await this.getMigrationTaskArn(environment);
			console.log(`   Task ARN: ${chalk.gray(taskArn)}`);
			console.log('');

			// Validate endpoint connections before starting
			await this.validateEndpointConnections(environment);

			// Confirm start
			const confirm = await promptConfirmation('Start full database migration (full-load + CDC)?');

			if (!confirm) {
				console.log(chalk.yellow('Migration start cancelled.'));
				return;
			}

			await this.callWithMfaRetry(async () => {
				const command = new StartReplicationTaskCommand({
					ReplicationTaskArn: taskArn,
					StartReplicationTaskType: 'start-replication'
				});
				return await this.dmsClient.send(command);
			});

			console.log(chalk.green('✅ Migration task started successfully!'));
			console.log('');
			console.log(chalk.blue('📊 Monitor progress with:'));
			console.log(`   ${chalk.cyan(`fiftyten-db migrate status ${environment}`)}`);
			console.log('');
			console.log(chalk.gray('💡 The migration will:'));
			console.log(chalk.gray('   1. Perform full load of all data'));
			console.log(chalk.gray('   2. Start change data capture (CDC) for ongoing replication'));
			console.log(chalk.gray('   3. Continue until manually stopped'));

		} catch (error) {
			console.error(chalk.red('❌ Failed to start migration:'), error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Stop migration task
	 */
	async stopMigration(environment: string): Promise<void> {
		console.log(chalk.blue('🛑 Stopping database migration...'));

		try {
			const taskArn = await this.getMigrationTaskArn(environment);

			// Confirm stop
			const confirm = await promptConfirmation('Stop the migration task? This will halt all data replication.');

			if (!confirm) {
				console.log(chalk.yellow('Migration stop cancelled.'));
				return;
			}

			await this.callWithMfaRetry(async () => {
				const command = new StopReplicationTaskCommand({
					ReplicationTaskArn: taskArn
				});
				return await this.dmsClient.send(command);
			});

			console.log(chalk.green('✅ Migration task stopped successfully!'));

		} catch (error) {
			console.error(chalk.red('❌ Failed to stop migration:'), error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Get migration status
	 */
	async getMigrationStatus(environment: string): Promise<MigrationStatus> {
		const taskArn = await this.getMigrationTaskArn(environment);

		const response = await this.callWithMfaRetry(async () => {
			const command = new DescribeReplicationTasksCommand({
				Filters: [
					{
						Name: 'replication-task-arn',
						Values: [taskArn]
					}
				]
			});
			return await this.dmsClient.send(command);
		});

		const task = response.ReplicationTasks?.[0];
		if (!task) {
			throw new Error(`Migration task not found: ${taskArn}`);
		}

		return {
			taskArn: task.ReplicationTaskArn!,
			taskId: task.ReplicationTaskIdentifier!,
			status: task.Status!,
			progress: task.ReplicationTaskStats?.FullLoadProgressPercent || 0,
			fullLoadProgressPercent: task.ReplicationTaskStats?.FullLoadProgressPercent,
			cdcStartDate: task.ReplicationTaskStats?.StartDate,
			stopReason: task.StopReason,
			replicationTaskCreationDate: task.ReplicationTaskCreationDate,
			replicationTaskStartDate: task.ReplicationTaskStartDate,
		};
	}

	/**
	 * Show migration status
	 */
	async showMigrationStatus(environment: string): Promise<void> {
		console.log(chalk.blue(`📊 Migration Status - ${environment.toUpperCase()}`));
		console.log('');

		try {
			const status = await this.getMigrationStatus(environment);

			// Status overview
			console.log(chalk.green('🔄 Task Information:'));
			console.log(`   Task ID: ${chalk.yellow(status.taskId)}`);
			console.log(`   Status: ${this.getStatusColor(status.status)}`);
			console.log(`   Progress: ${chalk.yellow(status.progress + '%')}`);

			if (status.replicationTaskCreationDate) {
				console.log(`   Created: ${chalk.gray(status.replicationTaskCreationDate.toLocaleString())}`);
			}

			if (status.replicationTaskStartDate) {
				console.log(`   Started: ${chalk.gray(status.replicationTaskStartDate.toLocaleString())}`);
			}

			if (status.cdcStartDate) {
				console.log(`   CDC Started: ${chalk.gray(status.cdcStartDate.toLocaleString())}`);
			}

			if (status.stopReason) {
				console.log(`   Stop Reason: ${chalk.red(status.stopReason)}`);
			}

			console.log('');

			// Get table statistics if task is running
			if (status.status === 'running' || status.status === 'stopped') {
				await this.showTableStatistics(status.taskArn);
			}

			// Show available commands
			console.log(chalk.blue('🔧 Available Commands:'));
			if (status.status === 'ready' || status.status === 'stopped') {
				console.log(`   Start: ${chalk.cyan(`fiftyten-db migrate start ${environment}`)}`);
			}
			if (status.status === 'running') {
				console.log(`   Stop: ${chalk.cyan(`fiftyten-db migrate stop ${environment}`)}`);
			}
			console.log(`   Validate: ${chalk.cyan(`fiftyten-db migrate validate ${environment}`)}`);
			console.log(`   Cleanup: ${chalk.cyan(`fiftyten-db migrate cleanup ${environment}`)}`);

		} catch (error) {
			console.error(chalk.red('❌ Failed to get migration status:'), error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Show table migration statistics
	 */
	private async showTableStatistics(taskArn: string): Promise<void> {
		try {
			const response = await this.callWithMfaRetry(async () => {
				const command = new DescribeTableStatisticsCommand({
					ReplicationTaskArn: taskArn
				});
				return await this.dmsClient.send(command);
			});

			const stats = response.TableStatistics;
			if (!stats || stats.length === 0) {
				console.log(chalk.gray('   No table statistics available yet'));
				return;
			}

			console.log(chalk.green('📋 Table Statistics:'));
			console.log('');

			// Header
			console.log(chalk.gray('   Table Name'.padEnd(30) + 'State'.padEnd(15) + 'Rows'.padEnd(10) + 'Errors'));
			console.log(chalk.gray('   ' + '-'.repeat(70)));

			// Table rows
			stats.forEach(stat => {
				const tableName = (stat.TableName || '').padEnd(30);
				const state = this.getTableStateColor(stat.TableState || '').padEnd(15);
				const rows = (stat.FullLoadRows?.toString() || '0').padEnd(10);
				const errors = stat.FullLoadErrorRows?.toString() || '0';

				console.log(`   ${tableName}${state}${rows}${errors}`);
			});

			console.log('');

			// Summary
			const totalRows = stats.reduce((sum, stat) => sum + (stat.FullLoadRows || 0), 0);
			const totalErrors = stats.reduce((sum, stat) => sum + (stat.FullLoadErrorRows || 0), 0);

			console.log(chalk.green('📈 Summary:'));
			console.log(`   Total Tables: ${chalk.yellow(stats.length)}`);
			console.log(`   Total Rows: ${chalk.yellow(totalRows.toLocaleString())}`);
			console.log(`   Total Errors: ${totalErrors > 0 ? chalk.red(totalErrors) : chalk.green(totalErrors)}`);
			console.log('');

		} catch (error) {
			console.log(chalk.yellow('⚠️  Could not retrieve table statistics'));
		}
	}

	/**
	 * Validate migration data
	 */
	async validateMigration(environment: string): Promise<void> {
		console.log(chalk.blue('🔍 Validating migration data...'));
		console.log('');

		try {
			const status = await this.getMigrationStatus(environment);

			if (status.status !== 'running' && status.status !== 'stopped') {
				console.log(chalk.yellow('⚠️  Migration task must be running or stopped to validate data'));
				return;
			}

			// Get detailed table statistics
			const response = await this.callWithMfaRetry(async () => {
				const command = new DescribeTableStatisticsCommand({
					ReplicationTaskArn: status.taskArn
				});
				return await this.dmsClient.send(command);
			});

			const stats = response.TableStatistics || [];

			console.log(chalk.green('📊 Migration Validation Report:'));
			console.log('');

			let totalTables = 0;
			let completedTables = 0;
			let tablesWithErrors = 0;
			let totalRows = 0;
			let totalErrors = 0;

			stats.forEach(stat => {
				totalTables++;
				totalRows += stat.FullLoadRows || 0;
				totalErrors += stat.FullLoadErrorRows || 0;

				if (stat.TableState === 'Table completed') {
					completedTables++;
				}

				if ((stat.FullLoadErrorRows || 0) > 0) {
					tablesWithErrors++;
				}
			});

			// Overall status
			const completionRate = totalTables > 0 ? (completedTables / totalTables) * 100 : 0;
			const errorRate = totalRows > 0 ? (totalErrors / totalRows) * 100 : 0;

			console.log(chalk.green('✅ Overall Status:'));
			console.log(`   Completion Rate: ${completionRate >= 100 ? chalk.green(completionRate.toFixed(1) + '%') : chalk.yellow(completionRate.toFixed(1) + '%')}`);
			console.log(`   Error Rate: ${errorRate === 0 ? chalk.green(errorRate.toFixed(2) + '%') : chalk.red(errorRate.toFixed(2) + '%')}`);
			console.log(`   Tables Completed: ${chalk.yellow(completedTables)} / ${chalk.yellow(totalTables)}`);
			console.log(`   Total Rows Migrated: ${chalk.yellow(totalRows.toLocaleString())}`);
			console.log(`   Total Errors: ${totalErrors === 0 ? chalk.green(totalErrors) : chalk.red(totalErrors)}`);
			console.log('');

			// Tables with errors
			if (tablesWithErrors > 0) {
				console.log(chalk.red('⚠️  Tables with Errors:'));
				stats.forEach(stat => {
					if ((stat.FullLoadErrorRows || 0) > 0) {
						console.log(`   ${chalk.yellow(stat.TableName)}: ${chalk.red(stat.FullLoadErrorRows)} errors`);
					}
				});
				console.log('');
			}

			// Recommendations
			console.log(chalk.blue('💡 Recommendations:'));
			if (completionRate < 100) {
				console.log(chalk.yellow('   • Migration still in progress - wait for completion before cutover'));
			}
			if (totalErrors > 0) {
				console.log(chalk.yellow('   • Review error logs in CloudWatch: /aws/dms/task/migration-task-' + environment));
				console.log(chalk.yellow('   • Consider manual data fixes for errored records'));
			}
			if (completionRate === 100 && totalErrors === 0) {
				console.log(chalk.green('   • Migration completed successfully - ready for application cutover'));
				console.log(chalk.green('   • Consider stopping CDC when ready: fiftyten-db migrate stop ' + environment));
			}

		} catch (error) {
			console.error(chalk.red('❌ Failed to validate migration:'), error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Cleanup migration infrastructure
	 */
	async cleanupMigration(environment: string): Promise<void> {
		console.log(chalk.blue('🧹 Cleaning up migration infrastructure...'));
		console.log('');

		try {
			// Check if migration is still running
			const status = await this.getMigrationStatus(environment);

			if (status.status === 'running') {
				console.log(chalk.red('❌ Cannot cleanup - migration task is still running'));
				console.log(`   Stop the migration first: ${chalk.cyan(`fiftyten-db migrate stop ${environment}`)}`);
				return;
			}

			// Confirm cleanup
			const confirm = await promptConfirmation('This will destroy all migration infrastructure. Are you sure?');

			if (!confirm) {
				console.log(chalk.yellow('Cleanup cancelled.'));
				return;
			}

			const stackName = `indicator-migration-stack-${environment}`;

			// Step 1: Remove security group rules that were added to external security groups
			try {
				console.log(chalk.blue('🔧 Step 1: Cleaning up security group rules...'));

				// Get DMS security group ID from stack outputs
				const stackInfo = await this.callWithMfaRetry(async () => {
					const command = new DescribeStacksCommand({ StackName: stackName });
					return await this.cfnClient.send(command);
				});

				const stack = stackInfo.Stacks?.[0];
				const dmsSecurityGroupId = stack?.Outputs?.find(output =>
					output.OutputKey === 'DMSSecurityGroupId'
				)?.OutputValue;

				if (dmsSecurityGroupId) {
					// Get endpoints from stack outputs
					try {
						const legacyEndpointOutput = stack?.Outputs?.find(output =>
							output.OutputKey === 'LegacyEndpoint'
						)?.OutputValue;

						const targetEndpointOutput = stack?.Outputs?.find(output =>
							output.OutputKey === 'TargetEndpoint'
						)?.OutputValue;

						if (legacyEndpointOutput && targetEndpointOutput) {
							const discoveryResult = await this.cfnManager.discoverDatabaseSecurityGroups(
								legacyEndpointOutput,
								targetEndpointOutput
							);

							await this.cfnManager.cleanupSecurityGroupRules(
								dmsSecurityGroupId,
								discoveryResult.legacySecurityGroupIds,
								discoveryResult.targetSecurityGroupIds
							);
						} else {
							console.log(chalk.yellow('⚠️  Could not find endpoint information in stack outputs - skipping rule cleanup'));
							console.log(chalk.gray(`   Legacy: ${legacyEndpointOutput}, Target: ${targetEndpointOutput}`));
						}
					} catch (error) {
						console.log(chalk.yellow('⚠️  Could not discover database security groups for cleanup'));
						console.log(chalk.gray(`   ${error instanceof Error ? error.message : String(error)}`));
					}
				} else {
					console.log(chalk.yellow('⚠️  Could not find DMS security group ID - skipping rule cleanup'));
				}
			} catch (error) {
				console.log(chalk.yellow('⚠️  Could not cleanup security group rules - proceeding with stack deletion'));
				console.log(chalk.gray(`   ${error instanceof Error ? error.message : String(error)}`));
			}

			// Step 2: Delete CloudFormation stack
			console.log(chalk.blue('🔧 Step 2: Deleting CloudFormation stack...'));
			await this.cfnManager.deleteStack(stackName);

		} catch (error) {
			if (error instanceof Error && error.message.includes('not found')) {
				console.log(chalk.yellow('⚠️  Migration stack not found - may already be cleaned up'));
				return;
			}
			console.error(chalk.red('❌ Failed to cleanup migration:'), error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Get colored status text
	 */
	private getStatusColor(status: string): string {
		switch (status.toLowerCase()) {
			case 'running':
				return chalk.green(status);
			case 'stopped':
				return chalk.yellow(status);
			case 'ready':
				return chalk.blue(status);
			case 'failed':
			case 'failed-move':
				return chalk.red(status);
			default:
				return chalk.gray(status);
		}
	}

	/**
	 * Get colored table state text
	 */
	private getTableStateColor(state: string): string {
		switch (state.toLowerCase()) {
			case 'table completed':
				return chalk.green(state);
			case 'table loading':
				return chalk.yellow(state);
			case 'table error':
				return chalk.red(state);
			default:
				return chalk.gray(state);
		}
	}
}

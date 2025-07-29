import { CloudFormationClient, DescribeStacksCommand, Stack } from '@aws-sdk/client-cloudformation';
import { DatabaseMigrationServiceClient, DescribeReplicationTasksCommand, StartReplicationTaskCommand, StopReplicationTaskCommand, DescribeTableStatisticsCommand } from '@aws-sdk/client-database-migration-service';
import { spawn } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { MfaAuthenticator } from './mfa-auth';

export interface MigrationConfig {
  environment: string;
  legacyEndpoint: string;
  legacyDatabase: string;
  legacyUsername: string;
  legacyPassword: string;
  targetSecretArn: string;
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
  private mfaAuth: MfaAuthenticator;
  private region: string;
  private mfaAuthenticated: boolean = false;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.cfnClient = new CloudFormationClient({ region });
    this.dmsClient = new DatabaseMigrationServiceClient({ region });
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
   * Deploy migration infrastructure using CDK
   */
  async deployMigration(config: MigrationConfig): Promise<void> {
    console.log(chalk.blue('🚀 Deploying database migration infrastructure...'));
    console.log('');
    console.log(chalk.green('📋 Migration Configuration:'));
    console.log(`   Environment: ${chalk.yellow(config.environment)}`);
    console.log(`   Source Database: ${chalk.yellow(config.legacyEndpoint + '/' + config.legacyDatabase)}`);
    console.log(`   Target Secret: ${chalk.yellow(config.targetSecretArn)}`);
    console.log(`   Migration Type: ${chalk.yellow('full-load-and-cdc')}`);
    console.log('');

    // Confirm deployment
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Deploy migration infrastructure with these settings?',
        default: false,
      }
    ]);

    if (!confirm) {
      console.log(chalk.yellow('Migration deployment cancelled.'));
      return;
    }

    // Set environment variables for CDK deployment
    const env = {
      ...process.env,
      BRANCH_NAME: config.environment,
      LEGACY_RDS_ENDPOINT: config.legacyEndpoint,
      LEGACY_RDS_DATABASE: config.legacyDatabase,
      LEGACY_RDS_USERNAME: config.legacyUsername,
      LEGACY_RDS_PASSWORD: config.legacyPassword,
      TARGET_RDS_SECRET_ARN: config.targetSecretArn,
      NOTIFICATION_EMAILS: config.notificationEmails?.join(',') || '',
    };

    console.log(chalk.blue('🔧 Running CDK deployment...'));
    console.log(chalk.gray('   This may take 10-15 minutes to create DMS resources'));
    console.log('');

    // Run CDK deploy command
    const stackName = `indicator-migration-stack-${config.environment}`;
    const args = [
      'cdk', 'deploy', stackName,
      '--app', 'npx ts-node bin/migration.ts',
      '--require-approval', 'never'
    ];

    const child = spawn('pnpm', args, {
      stdio: 'inherit',
      env,
      cwd: '../../5010-indicator-storage-infra' // Adjust path as needed
    });

    return new Promise((resolve, reject) => {
      child.on('error', (error) => {
        console.error(chalk.red('❌ CDK deployment failed:'), error.message);
        reject(error);
      });

      child.on('exit', (code) => {
        if (code === 0) {
          console.log('');
          console.log(chalk.green('✅ Migration infrastructure deployed successfully!'));
          console.log('');
          console.log(chalk.blue('🔄 Next steps:'));
          console.log(`   1. Start migration: ${chalk.cyan(`fiftyten-db migrate start ${config.environment}`)}`);
          console.log(`   2. Monitor progress: ${chalk.cyan(`fiftyten-db migrate status ${config.environment}`)}`);
          console.log(`   3. Validate data: ${chalk.cyan(`fiftyten-db migrate validate ${config.environment}`)}`);
          resolve();
        } else {
          console.log(chalk.red(`❌ CDK deployment failed with exit code ${code}`));
          reject(new Error(`CDK deployment failed with exit code ${code}`));
        }
      });
    });
  }

  /**
   * Get migration stack information
   */
  private async getMigrationStack(environment: string): Promise<Stack | null> {
    try {
      const stackName = `indicator-migration-stack-${environment}`;
      const response = await this.callWithMfaRetry(async () => {
        const command = new DescribeStacksCommand({ StackName: stackName });
        return await this.cfnClient.send(command);
      });

      return response.Stacks?.[0] || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get migration task ARN from stack outputs
   */
  private async getMigrationTaskArn(environment: string): Promise<string> {
    const stack = await this.getMigrationStack(environment);
    if (!stack) {
      throw new Error(`Migration stack not found for environment: ${environment}`);
    }

    const taskArnOutput = stack.Outputs?.find(output => 
      output.OutputKey === 'MigrationTaskArn'
    );

    if (!taskArnOutput?.OutputValue) {
      throw new Error(`Migration task ARN not found in stack outputs for environment: ${environment}`);
    }

    return taskArnOutput.OutputValue;
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

      // Confirm start
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Start full database migration (full-load + CDC)?',
          default: false,
        }
      ]);

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
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Stop the migration task? This will halt all data replication.',
          default: false,
        }
      ]);

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
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'This will destroy all migration infrastructure. Are you sure?',
          default: false,
        }
      ]);

      if (!confirm) {
        console.log(chalk.yellow('Cleanup cancelled.'));
        return;
      }

      console.log(chalk.blue('🔧 Running CDK destroy...'));
      console.log(chalk.gray('   This will remove all DMS resources'));
      console.log('');

      // Run CDK destroy command
      const stackName = `indicator-migration-stack-${environment}`;
      const args = [
        'cdk', 'destroy', stackName,
        '--app', 'npx ts-node bin/migration.ts',
        '--force'
      ];

      const child = spawn('pnpm', args, {
        stdio: 'inherit',
        cwd: '../../5010-indicator-storage-infra' // Adjust path as needed
      });

      return new Promise((resolve, reject) => {
        child.on('error', (error) => {
          console.error(chalk.red('❌ CDK destroy failed:'), error.message);
          reject(error);
        });

        child.on('exit', (code) => {
          if (code === 0) {
            console.log('');
            console.log(chalk.green('✅ Migration infrastructure cleaned up successfully!'));
            console.log(chalk.gray('   All DMS resources have been removed'));
          } else {
            console.log(chalk.red(`❌ CDK destroy failed with exit code ${code}`));
            reject(new Error(`CDK destroy failed with exit code ${code}`));
          }
          resolve();
        });
      });

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
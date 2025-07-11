import { EC2Client, DescribeInstancesCommand, Instance } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { spawn } from 'child_process';
import chalk from 'chalk';

export interface ConnectionInfo {
  instanceId: string;
  sessionManagerEnabled: boolean;
  accessMethod: string;
  region: string;
  securityGroupId: string;
  sessionCommand: string;
  portForwardCommand: string;
  cliToolCommand: string;
  sshEnabled?: boolean;
  note?: string;
}

export interface DatabaseInfo {
  DATABASE_HOST: string;
  DATABASE_PORT: string;
  DATABASE_NAME: string;
  DATABASE_USER: string;
  DATABASE_SECRET_ARN: string;
}

export class DatabaseConnector {
  private ec2Client: EC2Client;
  private ssmClient: SSMClient;
  private region: string;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.ec2Client = new EC2Client({ region });
    this.ssmClient = new SSMClient({ region });
  }

  /**
   * Get bastion host instance ID by environment
   */
  private async getBastionInstanceId(environment: string): Promise<string> {
    try {
      // First try to get from SSM parameter
      const connectionInfo = await this.getConnectionInfo(environment);
      if (connectionInfo.instanceId) {
        return connectionInfo.instanceId;
      }
    } catch (error) {
      console.log(chalk.yellow('Could not get instance ID from SSM, searching EC2...'));
    }

    // Fallback: search EC2 instances by tag
    const command = new DescribeInstancesCommand({
      Filters: [
        {
          Name: 'tag:Name',
          Values: [`indicator-bastion-${environment}-host`]
        },
        {
          Name: 'instance-state-name',
          Values: ['running', 'stopped']
        }
      ]
    });

    const response = await this.ec2Client.send(command);
    
    if (!response.Reservations || response.Reservations.length === 0) {
      throw new Error(`No bastion host found for environment: ${environment}`);
    }

    const instance = response.Reservations[0].Instances?.[0];
    if (!instance || !instance.InstanceId) {
      throw new Error(`Invalid bastion host instance for environment: ${environment}`);
    }

    return instance.InstanceId;
  }

  /**
   * Get connection information from SSM
   */
  private async getConnectionInfo(environment: string): Promise<ConnectionInfo> {
    const command = new GetParameterCommand({
      Name: `/indicator/bastion/${environment}/connection-info`
    });

    const response = await this.ssmClient.send(command);
    
    if (!response.Parameter || !response.Parameter.Value) {
      throw new Error(`Connection info not found for environment: ${environment}`);
    }

    return JSON.parse(response.Parameter.Value);
  }

  /**
   * Get database information from SSM
   */
  private async getDatabaseInfo(environment: string, service: string = 'platform'): Promise<DatabaseInfo> {
    const parameterName = service === 'platform' 
      ? `/indicator/platform-api/${environment}/database-environment-variables`
      : `/indicator/${service}-api/${environment}/database-environment-variables`;

    const command = new GetParameterCommand({
      Name: parameterName
    });

    const response = await this.ssmClient.send(command);
    
    if (!response.Parameter || !response.Parameter.Value) {
      throw new Error(`Database info not found for ${service} in environment: ${environment}`);
    }

    return JSON.parse(response.Parameter.Value);
  }

  /**
   * Create SSH tunnel to database via Session Manager
   */
  async createTunnel(environment: string, service: string = 'platform', localPort: number = 5432): Promise<void> {
    console.log(chalk.blue('🔗 Creating database tunnel via Session Manager...'));
    
    const instanceId = await this.getBastionInstanceId(environment);
    const dbInfo = await this.getDatabaseInfo(environment, service);

    console.log(chalk.green('✅ Connection details:'));
    console.log(`   Environment: ${chalk.yellow(environment)}`);
    console.log(`   Service: ${chalk.yellow(service)}`);
    console.log(`   Local port: ${chalk.yellow(localPort)}`);
    console.log(`   Remote database: ${chalk.yellow(dbInfo.DATABASE_HOST + ':' + dbInfo.DATABASE_PORT)}`);
    console.log(`   Database: ${chalk.yellow(dbInfo.DATABASE_NAME)}`);
    console.log('');

    console.log(chalk.green('🚀 Starting tunnel...'));
    console.log(chalk.gray('   Once tunnel is established, connect with:'));
    console.log(chalk.cyan(`   psql -h localhost -p ${localPort} -d ${dbInfo.DATABASE_NAME} -U ${dbInfo.DATABASE_USER}`));
    console.log('');
    console.log(chalk.gray('   Press Ctrl+C to close the tunnel'));
    console.log('');

    // Start Session Manager port forwarding
    const args = [
      'ssm', 'start-session',
      '--target', instanceId,
      '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters', `host=${dbInfo.DATABASE_HOST},portNumber=${dbInfo.DATABASE_PORT},localPortNumber=${localPort}`
    ];

    const child = spawn('aws', args, {
      stdio: 'inherit'
    });

    child.on('error', (error) => {
      console.error(chalk.red('Error starting tunnel:'), error.message);
      console.log(chalk.yellow('Make sure AWS CLI and Session Manager plugin are installed'));
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        console.log(chalk.red(`Tunnel exited with code ${code}`));
      } else {
        console.log(chalk.green('Tunnel closed'));
      }
    });
  }

  /**
   * Connect directly to database via Session Manager
   */
  async connectDatabase(environment: string, service: string = 'platform'): Promise<void> {
    console.log(chalk.blue('🔗 Connecting to database via Session Manager...'));
    
    const instanceId = await this.getBastionInstanceId(environment);
    const dbInfo = await this.getDatabaseInfo(environment, service);

    console.log(chalk.green('✅ Connection details:'));
    console.log(`   Environment: ${chalk.yellow(environment)}`);
    console.log(`   Service: ${chalk.yellow(service)}`);
    console.log(`   Database: ${chalk.yellow(dbInfo.DATABASE_HOST + ':' + dbInfo.DATABASE_PORT + '/' + dbInfo.DATABASE_NAME)}`);
    console.log(`   Username: ${chalk.yellow(dbInfo.DATABASE_USER)}`);
    console.log('');

    // Start Session Manager session with database connection
    const args = [
      'ssm', 'start-session',
      '--target', instanceId
    ];

    console.log(chalk.green('🚀 Starting Session Manager connection...'));
    console.log(chalk.gray('   Once connected, run:'));
    console.log(chalk.cyan(`   psql -h ${dbInfo.DATABASE_HOST} -p ${dbInfo.DATABASE_PORT} -d ${dbInfo.DATABASE_NAME} -U ${dbInfo.DATABASE_USER}`));
    console.log('');

    const child = spawn('aws', args, {
      stdio: 'inherit'
    });

    child.on('error', (error) => {
      console.error(chalk.red('Error connecting:'), error.message);
      console.log(chalk.yellow('Make sure AWS CLI and Session Manager plugin are installed'));
    });
  }

  /**
   * SSH into bastion host via Session Manager
   */
  async sshBastion(environment: string): Promise<void> {
    console.log(chalk.blue('🔗 Connecting to bastion host via Session Manager...'));
    
    const instanceId = await this.getBastionInstanceId(environment);

    console.log(chalk.green('✅ Connection details:'));
    console.log(`   Environment: ${chalk.yellow(environment)}`);
    console.log(`   Instance ID: ${chalk.yellow(instanceId)}`);
    console.log('');

    // Start Session Manager session
    const args = [
      'ssm', 'start-session',
      '--target', instanceId
    ];

    console.log(chalk.green('🚀 Starting Session Manager connection...'));
    console.log(chalk.gray('   No SSH keys required!'));
    console.log('');

    const child = spawn('aws', args, {
      stdio: 'inherit'
    });

    child.on('error', (error) => {
      console.error(chalk.red('Error connecting:'), error.message);
      console.log(chalk.yellow('Make sure AWS CLI and Session Manager plugin are installed'));
    });
  }

  /**
   * Show connection information
   */
  async showInfo(environment: string): Promise<void> {
    console.log(chalk.blue(`📋 Connection Information - ${environment.toUpperCase()}`));
    console.log('');

    try {
      const connectionInfo = await this.getConnectionInfo(environment);
      
      console.log(chalk.green('🖥️  Bastion Host:'));
      console.log(`   Instance ID: ${chalk.yellow(connectionInfo.instanceId)}`);
      console.log(`   Access Method: ${chalk.yellow(connectionInfo.accessMethod)}`);
      console.log(`   Region: ${chalk.yellow(connectionInfo.region)}`);
      console.log('');

      console.log(chalk.green('🔧 Session Manager Commands:'));
      console.log(`   Connect: ${chalk.cyan(connectionInfo.sessionCommand)}`);
      console.log(`   Port Forward: ${chalk.cyan(connectionInfo.portForwardCommand.replace('DATABASE_ENDPOINT', '<DATABASE_ENDPOINT>'))}`);
      console.log('');

      console.log(chalk.green('⚡ CLI Tool Commands:'));
      console.log(`   Tunnel: ${chalk.cyan(`5010-db tunnel ${environment}`)}`);
      console.log(`   Connect: ${chalk.cyan(`5010-db connect ${environment}`)}`);
      console.log(`   SSH: ${chalk.cyan(`5010-db ssh ${environment}`)}`);
      console.log('');

      if (connectionInfo.sshEnabled) {
        console.log(chalk.yellow('⚠️  SSH access is enabled (legacy mode)'));
        console.log(`   Key Name: ${connectionInfo.keyName || 'N/A'}`);
      } else {
        console.log(chalk.green('✅ Session Manager only (no SSH keys required)'));
      }

      if (connectionInfo.note) {
        console.log(chalk.gray(`   Note: ${connectionInfo.note}`));
      }

    } catch (error) {
      console.error(chalk.red('Error fetching connection info:'), error.message);
      
      // Try to get basic instance info
      try {
        const instanceId = await this.getBastionInstanceId(environment);
        console.log(chalk.yellow('⚠️  Basic connection info:'));
        console.log(`   Instance ID: ${chalk.yellow(instanceId)}`);
        console.log(`   Manual command: ${chalk.cyan(`aws ssm start-session --target ${instanceId}`)}`);
      } catch (fallbackError) {
        console.error(chalk.red('Could not find bastion host for environment:'), environment);
      }
    }
  }

  /**
   * List available environments
   */
  async listEnvironments(): Promise<void> {
    console.log(chalk.blue('📋 Available Environments'));
    console.log('');

    const environments = ['dev', 'main'];
    
    for (const env of environments) {
      try {
        const instanceId = await this.getBastionInstanceId(env);
        console.log(chalk.green(`✅ ${env.toUpperCase()}`));
        console.log(`   Instance: ${chalk.yellow(instanceId)}`);
        
        // Check if we can get connection info
        try {
          const connectionInfo = await this.getConnectionInfo(env);
          console.log(`   Access: ${chalk.cyan(connectionInfo.accessMethod)}`);
        } catch {
          console.log(`   Access: ${chalk.cyan('Session Manager')}`);
        }
        
        console.log(`   Commands: ${chalk.gray(`5010-db tunnel ${env}, 5010-db connect ${env}`)}`);
        console.log('');
      } catch (error) {
        console.log(chalk.red(`❌ ${env.toUpperCase()}`));
        console.log(`   Status: ${chalk.red('Not available')}`);
        console.log(`   Error: ${chalk.gray(error.message)}`);
        console.log('');
      }
    }

    console.log(chalk.gray('Usage examples:'));
    console.log(chalk.cyan('  5010-db tunnel dev     # Create tunnel to dev database'));
    console.log(chalk.cyan('  5010-db connect main   # Connect to main database'));
    console.log(chalk.cyan('  5010-db ssh dev        # SSH into dev bastion host'));
  }
}
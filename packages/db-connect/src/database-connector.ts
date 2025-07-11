import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import chalk from 'chalk';
import { MfaAuthenticator } from './mfa-auth';

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
  keyName?: string;
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
  private secretsClient: SecretsManagerClient;
  private mfaAuth: MfaAuthenticator;
  private region: string;
  private mfaAuthenticated: boolean = false;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.ec2Client = new EC2Client({ region });
    this.ssmClient = new SSMClient({ region });
    this.secretsClient = new SecretsManagerClient({ region });
    this.mfaAuth = new MfaAuthenticator(region);
  }

  /**
   * Check if a local port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const connection = createConnection({ port, host: 'localhost' });
      
      connection.on('connect', () => {
        connection.destroy();
        resolve(false); // Port is in use
      });
      
      connection.on('error', () => {
        resolve(true); // Port is available
      });
    });
  }

  /**
   * Find an available port starting from the given port
   */
  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port <= startPort + 10; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error(`No available ports found in range ${startPort}-${startPort + 10}`);
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
        this.ec2Client = new EC2Client(clientConfig);
        this.ssmClient = new SSMClient(clientConfig);
        this.secretsClient = new SecretsManagerClient(clientConfig);
        
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
   * Get bastion host instance ID by environment
   */
  private async getBastionInstanceId(environment: string): Promise<string> {
    try {
      // First try to get from SSM parameter
      const connectionInfo = await this.callWithMfaRetry(() => this.getConnectionInfo(environment));
      if (connectionInfo.instanceId) {
        return connectionInfo.instanceId;
      }
    } catch (error) {
      console.log(chalk.yellow('Could not get instance ID from SSM, searching EC2...'));
    }

    // Fallback: search EC2 instances by tag
    const response = await this.callWithMfaRetry(async () => {
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
      return await this.ec2Client.send(command);
    });
    
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
  private async getDatabaseInfo(environment: string, database: string = 'platform'): Promise<DatabaseInfo> {
    const parameterName = database === 'platform' 
      ? `/indicator/platform-api/${environment}/database-environment-variables`
      : `/indicator/${database}-api/${environment}/database-environment-variables`;

    const response = await this.callWithMfaRetry(async () => {
      const command = new GetParameterCommand({
        Name: parameterName
      });
      return await this.ssmClient.send(command);
    });
    
    if (!response.Parameter || !response.Parameter.Value) {
      throw new Error(`Database info not found for ${database} in environment: ${environment}`);
    }

    return JSON.parse(response.Parameter.Value);
  }

  /**
   * Get database password from Secrets Manager
   */
  async getDatabasePassword(environment: string, database: string = 'platform'): Promise<string> {
    const dbInfo = await this.getDatabaseInfo(environment, database);
    
    const command = new GetSecretValueCommand({
      SecretId: dbInfo.DATABASE_SECRET_ARN
    });

    const response = await this.callWithMfaRetry(async () => {
      return await this.secretsClient.send(command);
    });

    if (!response.SecretString) {
      throw new Error(`Database password not found in secret: ${dbInfo.DATABASE_SECRET_ARN}`);
    }

    const secretValue = JSON.parse(response.SecretString);
    return secretValue.password || secretValue.PASSWORD;
  }

  /**
   * Create SSH tunnel to database via Session Manager
   */
  async createTunnel(environment: string, database: string = 'platform', localPort: number = 5433): Promise<void> {
    console.log(chalk.blue('🔗 Creating database tunnel via Session Manager...'));
    
    const instanceId = await this.getBastionInstanceId(environment);
    const dbInfo = await this.getDatabaseInfo(environment, database);

    console.log(chalk.green('✅ Connection details:'));
    console.log(`   Environment: ${chalk.yellow(environment)}`);
    console.log(`   Database: ${chalk.yellow(database)}`);
    console.log(`   Local port: ${chalk.yellow(localPort)}`);
    console.log(`   Remote database: ${chalk.yellow(dbInfo.DATABASE_HOST + ':' + dbInfo.DATABASE_PORT)}`);
    console.log(`   Database: ${chalk.yellow(dbInfo.DATABASE_NAME)}`);
    console.log('');

    // Check if local port is available
    console.log(chalk.blue('🔍 Checking local port availability...'));
    const isAvailable = await this.isPortAvailable(localPort);
    
    if (!isAvailable) {
      console.log(chalk.red(`❌ Port ${localPort} is already in use`));
      console.log('');
      console.log(chalk.yellow('💡 Solutions:'));
      console.log(`   1. Use a different port: ${chalk.cyan(`fiftyten-db tunnel ${environment} -d ${database} -p 5433`)}`);
      console.log(`   2. Find what's using port ${localPort}: ${chalk.gray(`lsof -i :${localPort}`)}`);
      console.log(`   3. Stop local PostgreSQL if running: ${chalk.gray('brew services stop postgresql')}`);
      
      // Try to suggest an available port
      try {
        const availablePort = await this.findAvailablePort(localPort + 1);
        console.log(`   4. Suggested available port: ${chalk.cyan(`fiftyten-db tunnel ${environment} -d ${database} -p ${availablePort}`)}`);
      } catch {
        // Ignore if we can't find an available port
      }
      
      throw new Error(`Port ${localPort} is in use. Please use a different port with -p option.`);
    }

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
  async connectDatabase(environment: string, database: string = 'platform'): Promise<void> {
    console.log(chalk.blue('🔗 Connecting to database via Session Manager...'));
    
    const instanceId = await this.getBastionInstanceId(environment);
    const dbInfo = await this.getDatabaseInfo(environment, database);

    console.log(chalk.green('✅ Connection details:'));
    console.log(`   Environment: ${chalk.yellow(environment)}`);
    console.log(`   Database: ${chalk.yellow(database)}`);
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
      console.error(chalk.red('Error fetching connection info:'), error instanceof Error ? error.message : String(error));
      
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
        console.log(`   Error: ${chalk.gray(error instanceof Error ? error.message : String(error))}`);
        console.log('');
      }
    }

    console.log(chalk.gray('Usage examples:'));
    console.log(chalk.cyan('  fiftyten-db tunnel dev -d platform     # Create tunnel to platform database'));
    console.log(chalk.cyan('  fiftyten-db connect main -d copytrading # Connect to copytrading database'));
    console.log(chalk.cyan('  fiftyten-db ssh dev                     # SSH into dev bastion host'));
    console.log(chalk.cyan('  fiftyten-db psql dev -d platform        # Connect with automatic password'));
  }

  /**
   * Discover available databases for an environment
   */
  async discoverDatabases(environment: string): Promise<string[]> {
    console.log(chalk.blue(`🔍 Discovering available databases for ${environment.toUpperCase()}...`));
    console.log('');

    const databases = ['platform', 'copytrading']; // Common database types
    const available: string[] = [];

    for (const database of databases) {
      try {
        await this.getDatabaseInfo(environment, database);
        available.push(database);
        console.log(chalk.green(`✅ ${database}`));
        console.log(`   Command: ${chalk.cyan(`fiftyten-db psql ${environment} -d ${database}`)}`);
      } catch (error) {
        console.log(chalk.gray(`⚪ ${database} (not configured)`));
      }
    }

    console.log('');
    if (available.length === 0) {
      console.log(chalk.yellow('⚠️  No databases found for this environment'));
    } else {
      console.log(chalk.green(`Found ${available.length} available database(s)`));
    }

    return available;
  }

  /**
   * Connect to database with automatic tunnel and password retrieval
   */
  async connectWithPassword(environment: string, database: string = 'platform', localPort: number = 5433): Promise<void> {
    console.log(chalk.blue('🔗 Setting up complete database connection...'));
    
    try {
      // Get database info first, then password (to avoid duplicate MFA)
      const dbInfo = await this.getDatabaseInfo(environment, database);
      const password = await this.getDatabasePassword(environment, database);

      console.log(chalk.green('✅ Retrieved database credentials'));
      console.log(`   Environment: ${chalk.yellow(environment)}`);
      console.log(`   Application: ${chalk.yellow(database)}`);
      console.log(`   Database: ${chalk.yellow(dbInfo.DATABASE_NAME)}`);
      console.log(`   User: ${chalk.yellow(dbInfo.DATABASE_USER)}`);
      console.log(`   Password: ${chalk.yellow(password)}`);
      console.log('');
      console.log(chalk.gray('💡 DATABASE_URL for manual configuration:'));
      console.log(chalk.cyan(`DATABASE_URL=postgres://${dbInfo.DATABASE_USER}:${password}@localhost:${localPort}/${dbInfo.DATABASE_NAME}`));
      console.log('');

      // Check if local port is available
      console.log(chalk.blue('🔍 Checking local port availability...'));
      const isAvailable = await this.isPortAvailable(localPort);
      
      if (!isAvailable) {
        console.log(chalk.red(`❌ Port ${localPort} is already in use`));
        console.log('');
        console.log(chalk.yellow('💡 Solutions:'));
        console.log(`   1. Use a different port: ${chalk.cyan(`fiftyten-db psql ${environment} -d ${database} -p 5433`)}`);
        console.log(`   2. Find what's using port ${localPort}: ${chalk.gray(`lsof -i :${localPort}`)}`);
        console.log(`   3. Stop local PostgreSQL if running: ${chalk.gray('brew services stop postgresql')}`);
        
        // Try to suggest an available port
        try {
          const availablePort = await this.findAvailablePort(localPort + 1);
          console.log(`   4. Suggested available port: ${chalk.cyan(`fiftyten-db psql ${environment} -d ${database} -p ${availablePort}`)}`);
        } catch {
          // Ignore if we can't find an available port
        }
        
        throw new Error(`Port ${localPort} is in use. Please use a different port with -p option.`);
      }

      // Create tunnel in background
      console.log(chalk.blue('🚀 Creating database tunnel...'));
      const instanceId = await this.getBastionInstanceId(environment);
      
      // Start Session Manager port forwarding
      const args = [
        'ssm', 'start-session',
        '--target', instanceId,
        '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
        '--parameters', `host=${dbInfo.DATABASE_HOST},portNumber=${dbInfo.DATABASE_PORT},localPortNumber=${localPort}`
      ];

      const child = spawn('aws', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Wait for tunnel to establish
      console.log(chalk.gray('   Waiting for tunnel to establish...'));
      
      return new Promise((resolve, reject) => {
        let tunnelReady = false;
        
        const checkTunnel = () => {
          setTimeout(() => {
            if (!tunnelReady) {
              // Set password as environment variable for psql
              process.env.PGPASSWORD = password;
              
              console.log(chalk.green('✅ Tunnel established! Connecting to database...'));
              console.log('');
              
              // Launch psql with direct connection to the specific database
              const psqlArgs = [
                '-h', 'localhost',
                '-p', localPort.toString(),
                '-d', dbInfo.DATABASE_NAME,
                '-U', dbInfo.DATABASE_USER
              ];

              const psql = spawn('psql', psqlArgs, {
                stdio: 'inherit'
              });

              psql.on('exit', (code) => {
                // Clean up password from environment
                delete process.env.PGPASSWORD;
                
                // Terminate the tunnel
                child.kill();
                
                if (code === 0) {
                  console.log(chalk.green('Database session ended'));
                  resolve();
                } else {
                  reject(new Error(`psql exited with code ${code}`));
                }
              });

              psql.on('error', (error) => {
                delete process.env.PGPASSWORD;
                child.kill();
                
                if (error.message.includes('ENOENT')) {
                  reject(new Error('psql command not found. Please install PostgreSQL client.'));
                } else {
                  reject(error);
                }
              });

              tunnelReady = true;
            }
          }, 3000); // Wait 3 seconds for tunnel to establish
        };

        child.stdout?.on('data', (data) => {
          const output = data.toString();
          if (output.includes('Waiting for connections') || output.includes('Port forwarding session started')) {
            if (!tunnelReady) {
              checkTunnel();
            }
          }
        });

        child.on('error', (error) => {
          delete process.env.PGPASSWORD;
          console.error(chalk.red('Error starting tunnel:'), error.message);
          reject(error);
        });

        // Fallback - if no specific output detected, try after 5 seconds
        setTimeout(() => {
          if (!tunnelReady) {
            checkTunnel();
          }
        }, 5000);
      });

    } catch (error) {
      console.error(chalk.red('Error setting up database connection:'), error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
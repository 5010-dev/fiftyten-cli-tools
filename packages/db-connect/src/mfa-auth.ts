import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import inquirer from 'inquirer';
import chalk from 'chalk';

export interface MfaCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

export interface MfaConfig {
  roleArn?: string;
  mfaSerial?: string;
  sessionName?: string;
  region?: string;
}

export class MfaAuthenticator {
  private stsClient: STSClient;
  private region: string;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.stsClient = new STSClient({ region });
  }

  /**
   * Check if current credentials are MFA-authenticated
   */
  async checkMfaStatus(): Promise<boolean> {
    try {
      const command = new GetCallerIdentityCommand({});
      const response = await this.stsClient.send(command);
      
      // If we can call GetCallerIdentity and the ARN contains 'assumed-role', 
      // we're likely using temporary credentials (MFA session)
      return response.Arn?.includes('assumed-role') || false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Detect if an error is due to MFA requirement
   */
  isMfaRequired(error: any): boolean {
    const errorMessage = error?.message || '';
    const errorCode = error?.Code || error?.name || '';
    
    return (
      errorMessage.includes('explicit deny') ||
      errorMessage.includes('MFA') ||
      errorMessage.includes('MultiFactorAuthentication') ||
      errorCode === 'AccessDenied' ||
      errorCode === 'AccessDeniedException'
    );
  }

  /**
   * Automatically detect MFA configuration from AWS config
   */
  async detectMfaConfig(): Promise<MfaConfig | null> {
    try {
      // Try to get current identity to determine MFA device
      const command = new GetCallerIdentityCommand({});
      const response = await this.stsClient.send(command);
      
      if (response.Arn && response.UserId) {
        // Extract account and username from ARN
        const accountId = response.Account;
        const arnParts = response.Arn.split('/');
        const username = arnParts[arnParts.length - 1];
        
        // Common MFA device patterns
        const mfaSerial = `arn:aws:iam::${accountId}:mfa/${username}`;
        
        // Common role patterns for MFA
        const roleArn = `arn:aws:iam::${accountId}:role/${username}-mfa-role`;
        
        return {
          mfaSerial,
          roleArn,
          sessionName: `${username}-mfa-session`,
          region: this.region
        };
      }
    } catch (error) {
      // Ignore errors during detection
    }
    
    return null;
  }

  /**
   * Prompt user for MFA configuration
   */
  async promptMfaConfig(detectedConfig?: MfaConfig | null): Promise<MfaConfig> {
    console.log(chalk.yellow('🔐 MFA authentication required'));
    console.log(chalk.gray('Please provide your MFA configuration:'));
    console.log('');

    const questions = [
      {
        type: 'input',
        name: 'roleArn',
        message: 'MFA Role ARN:',
        default: detectedConfig?.roleArn,
        validate: (input: string) => {
          if (!input || !input.startsWith('arn:aws:iam::')) {
            return 'Please enter a valid IAM role ARN (arn:aws:iam::ACCOUNT:role/ROLE_NAME)';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'mfaSerial',
        message: 'MFA Device Serial Number:',
        default: detectedConfig?.mfaSerial,
        validate: (input: string) => {
          if (!input || !input.startsWith('arn:aws:iam::')) {
            return 'Please enter a valid MFA device ARN (arn:aws:iam::ACCOUNT:mfa/USERNAME)';
          }
          return true;
        }
      },
      {
        type: 'input',
        name: 'sessionName',
        message: 'Session Name:',
        default: detectedConfig?.sessionName || 'fiftyten-db-session'
      }
    ];

    const answers = await inquirer.prompt(questions);
    return {
      ...answers,
      region: this.region
    };
  }

  /**
   * Prompt for MFA token
   */
  async promptMfaToken(): Promise<string> {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'token',
        message: 'Enter MFA token code:',
        validate: (input: string) => {
          if (!input || input.length !== 6 || !/^\d{6}$/.test(input)) {
            return 'Please enter a 6-digit MFA token code';
          }
          return true;
        }
      }
    ]);

    return answer.token;
  }

  /**
   * Assume role with MFA
   */
  async assumeRoleWithMfa(config: MfaConfig, tokenCode: string): Promise<MfaCredentials> {
    const command = new AssumeRoleCommand({
      RoleArn: config.roleArn!,
      RoleSessionName: config.sessionName || 'fiftyten-db-session',
      SerialNumber: config.mfaSerial,
      TokenCode: tokenCode,
      DurationSeconds: 3600 // 1 hour
    });

    try {
      const response = await this.stsClient.send(command);
      
      if (!response.Credentials) {
        throw new Error('No credentials returned from STS');
      }

      return {
        accessKeyId: response.Credentials.AccessKeyId!,
        secretAccessKey: response.Credentials.SecretAccessKey!,
        sessionToken: response.Credentials.SessionToken!,
        expiration: response.Credentials.Expiration
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('MultiFactorAuthentication')) {
          throw new Error('Invalid MFA token code. Please try again.');
        }
        if (error.message.includes('TokenCode')) {
          throw new Error('Invalid or expired MFA token code.');
        }
        if (error.message.includes('AccessDenied')) {
          throw new Error('Access denied. Please check your MFA role ARN and device serial number.');
        }
      }
      throw error;
    }
  }

  /**
   * Full MFA authentication flow
   */
  async authenticateWithMfa(): Promise<MfaCredentials> {
    console.log(chalk.blue('🔒 Starting MFA authentication...'));
    
    // Try to detect MFA configuration
    const detectedConfig = await this.detectMfaConfig();
    
    // Prompt for configuration
    const config = await this.promptMfaConfig(detectedConfig);
    
    // Prompt for MFA token
    const tokenCode = await this.promptMfaToken();
    
    // Assume role with MFA
    console.log(chalk.gray('Assuming role with MFA...'));
    const credentials = await this.assumeRoleWithMfa(config, tokenCode);
    
    console.log(chalk.green('✅ MFA authentication successful!'));
    console.log(chalk.gray(`Session expires: ${credentials.expiration?.toLocaleString()}`));
    console.log('');
    
    return credentials;
  }

  /**
   * Apply MFA credentials to AWS SDK clients
   */
  applyCredentials(credentials: MfaCredentials) {
    // Set environment variables for AWS SDK
    process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
  }
}
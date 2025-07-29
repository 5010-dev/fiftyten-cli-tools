import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand, GetSessionTokenCommand } from '@aws-sdk/client-sts';
import { IAMClient, ListMFADevicesCommand } from '@aws-sdk/client-iam';
import * as readline from 'readline';
import chalk from 'chalk';

// Helper functions for readline prompts
function promptInput(message: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = defaultValue ? `${message} (${defaultValue}): ` : `${message}: `;
  
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function promptChoice(message: string, choices: Array<{name: string, value: string}>): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(message);
  choices.forEach((choice, index) => {
    console.log(`${index + 1}. ${choice.name}`);
  });

  return new Promise((resolve) => {
    rl.question('Select option (number): ', (answer) => {
      rl.close();
      const index = parseInt(answer) - 1;
      if (index >= 0 && index < choices.length) {
        resolve(choices[index].value);
      } else {
        console.log('Invalid selection, using first option');
        resolve(choices[0].value);
      }
    });
  });
}

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
  private iamClient: IAMClient;
  private region: string;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.stsClient = new STSClient({ region });
    this.iamClient = new IAMClient({ region });
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
   * Auto-discover MFA devices for current user
   */
  async discoverMfaDevices(): Promise<string[]> {
    try {
      // First, get current user identity
      const identityCommand = new GetCallerIdentityCommand({});
      const identityResponse = await this.stsClient.send(identityCommand);
      
      if (!identityResponse.Arn) {
        return [];
      }

      // Extract username from ARN
      const arnParts = identityResponse.Arn.split('/');
      const username = arnParts[arnParts.length - 1];
      
      // List MFA devices for the user
      const mfaCommand = new ListMFADevicesCommand({
        UserName: username
      });
      
      const mfaResponse = await this.iamClient.send(mfaCommand);
      
      return mfaResponse.MFADevices?.map(device => device.SerialNumber!) || [];
    } catch (error) {
      // If we can't list MFA devices, try fallback detection
      console.log(chalk.yellow('Could not auto-discover MFA devices, using fallback detection'));
      return [];
    }
  }

  /**
   * Automatically detect MFA configuration from AWS config
   */
  async detectMfaConfig(): Promise<MfaConfig | null> {
    try {
      // Try to auto-discover MFA devices
      const mfaDevices = await this.discoverMfaDevices();
      
      if (mfaDevices.length > 0) {
        return {
          mfaSerial: mfaDevices[0], // Use first available device
          region: this.region
        };
      }

      // Fallback: Try to get current identity to determine MFA device
      const command = new GetCallerIdentityCommand({});
      const response = await this.stsClient.send(command);
      
      if (response.Arn && response.UserId) {
        // Extract account and username from ARN
        const accountId = response.Account;
        const arnParts = response.Arn.split('/');
        const username = arnParts[arnParts.length - 1];
        
        // Common MFA device patterns
        const mfaSerial = `arn:aws:iam::${accountId}:mfa/${username}`;
        
        return {
          mfaSerial,
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
    
    // Try to discover available MFA devices
    const availableDevices = await this.discoverMfaDevices();
    
    if (availableDevices.length === 0) {
      console.log(chalk.gray('Please provide your MFA device serial number:'));
      console.log('');

      let mfaSerial = '';
      while (!mfaSerial || !mfaSerial.startsWith('arn:aws:iam::')) {
        mfaSerial = await promptInput('MFA Device Serial Number', detectedConfig?.mfaSerial);
        if (!mfaSerial || !mfaSerial.startsWith('arn:aws:iam::')) {
          console.log(chalk.red('Please enter a valid MFA device ARN (arn:aws:iam::ACCOUNT:mfa/DEVICE_NAME)'));
        }
      }

      return {
        mfaSerial,
        region: this.region
      };
    } else if (availableDevices.length === 1) {
      // Auto-select single device
      console.log(chalk.green(`✅ Auto-detected MFA device: ${availableDevices[0]}`));
      return {
        mfaSerial: availableDevices[0],
        region: this.region
      };
    } else {
      // Multiple devices - let user choose
      console.log(chalk.gray('Multiple MFA devices found. Please select one:'));
      console.log('');

      const choices = availableDevices.map(device => ({
        name: device.split('/').pop() + ` (${device})`,
        value: device
      }));

      const mfaSerial = await promptChoice('Select MFA Device:', choices);
      return {
        mfaSerial,
        region: this.region
      };
    }
  }

  /**
   * Prompt for MFA token
   */
  async promptMfaToken(): Promise<string> {
    let token = '';
    while (!token || token.length !== 6 || !/^\d{6}$/.test(token)) {
      token = await promptInput('Enter MFA token code');
      if (!token || token.length !== 6 || !/^\d{6}$/.test(token)) {
        console.log(chalk.red('Please enter a 6-digit MFA token code'));
      }
    }
    return token;
  }

  /**
   * Get session token with MFA (for users with MFA enforcement policies)
   */
  async getSessionTokenWithMfa(config: MfaConfig, tokenCode: string): Promise<MfaCredentials> {
    const command = new GetSessionTokenCommand({
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
          throw new Error('Access denied. Please check your MFA device serial number.');
        }
      }
      throw error;
    }
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
    
    // Get session token with MFA (not role assumption)
    console.log(chalk.gray('Getting MFA session token...'));
    const credentials = await this.getSessionTokenWithMfa(config, tokenCode);
    
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
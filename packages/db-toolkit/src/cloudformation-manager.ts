import { 
  CloudFormationClient, 
  CreateStackCommand, 
  UpdateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  Stack,
  StackEvent
} from '@aws-sdk/client-cloudformation';
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import chalk from 'chalk';
import { MfaAuthenticator } from './mfa-auth';
import { generateMigrationTemplate, MigrationTemplateParams } from './cloudformation-templates';

export interface CloudFormationDeploymentConfig {
  stackName: string;
  region: string;
  parameters: MigrationTemplateParams;
}

export class CloudFormationManager {
  private cfnClient: CloudFormationClient;
  private ec2Client: EC2Client;
  private mfaAuth: MfaAuthenticator;
  private region: string;
  private mfaAuthenticated: boolean = false;

  constructor(region: string = 'us-west-1') {
    this.region = region;
    this.cfnClient = new CloudFormationClient({ region });
    this.ec2Client = new EC2Client({ region });
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
        this.ec2Client = new EC2Client(clientConfig);
        
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
   * Get VPC and subnet information for DMS deployment
   */
  async getVpcInfo(environmentName: string): Promise<{ vpcId: string; subnetIds: string[] }> {
    try {
      // Try to get VPC from storage infrastructure stack first
      const storageStackName = `indicator-storage-infra-${environmentName}`;
      const storageStack = await this.callWithMfaRetry(async () => {
        const command = new DescribeStacksCommand({ StackName: storageStackName });
        return await this.cfnClient.send(command);
      });

      const stack = storageStack.Stacks?.[0];
      if (stack?.Outputs) {
        const vpcId = stack.Outputs.find(o => o.OutputKey === 'VpcId')?.OutputValue;
        const subnetIds = stack.Outputs
          .filter(o => o.OutputKey?.includes('SubnetId'))
          .map(o => o.OutputValue!)
          .filter(Boolean);

        if (vpcId && subnetIds.length > 0) {
          return { vpcId, subnetIds };
        }
      }
    } catch (error) {
      console.log(chalk.yellow('⚠️  Could not get VPC info from storage stack, using default VPC'));
    }

    // Fallback to default VPC
    const vpcs = await this.callWithMfaRetry(async () => {
      const command = new DescribeVpcsCommand({
        Filters: [{ Name: 'is-default', Values: ['true'] }]
      });
      return await this.ec2Client.send(command);
    });

    const defaultVpc = vpcs.Vpcs?.[0];
    if (!defaultVpc?.VpcId) {
      throw new Error('No default VPC found. Please ensure you have a default VPC or specify VPC details.');
    }

    const subnets = await this.callWithMfaRetry(async () => {
      const command = new DescribeSubnetsCommand({
        Filters: [
          { Name: 'vpc-id', Values: [defaultVpc.VpcId!] },
          { Name: 'default-for-az', Values: ['true'] }
        ]
      });
      return await this.ec2Client.send(command);
    });

    const subnetIds = subnets.Subnets?.map(s => s.SubnetId!).filter(Boolean) || [];
    if (subnetIds.length === 0) {
      throw new Error('No suitable subnets found for DMS deployment');
    }

    return {
      vpcId: defaultVpc.VpcId!,
      subnetIds: subnetIds.slice(0, 3) // DMS needs at least 2 subnets, use max 3
    };
  }

  /**
   * Deploy CloudFormation stack
   */
  async deployStack(config: CloudFormationDeploymentConfig): Promise<void> {
    console.log(chalk.blue('🚀 Deploying migration infrastructure using CloudFormation...'));
    console.log(chalk.gray('   This may take 10-15 minutes to create DMS resources'));
    console.log('');

    try {
      // Get VPC and subnet information
      console.log(chalk.blue('🔍 Discovering VPC and subnet configuration...'));
      const vpcInfo = await this.getVpcInfo(config.parameters.environmentName);
      console.log(chalk.green(`✅ Using VPC: ${vpcInfo.vpcId}`));
      console.log(chalk.green(`✅ Using subnets: ${vpcInfo.subnetIds.join(', ')}`));
      console.log('');

      // Update parameters with VPC info
      const templateParams = {
        ...config.parameters,
        vpcId: vpcInfo.vpcId,
        subnetIds: vpcInfo.subnetIds
      };

      // Generate CloudFormation template
      const template = generateMigrationTemplate(templateParams);

      // Check if stack exists and its status
      let stackExists = false;
      let stackStatus: string | undefined;
      try {
        const response = await this.callWithMfaRetry(async () => {
          const command = new DescribeStacksCommand({ StackName: config.stackName });
          return await this.cfnClient.send(command);
        });
        stackExists = true;
        stackStatus = response.Stacks?.[0]?.StackStatus;
      } catch (error) {
        // Stack doesn't exist, which is fine
      }

      // Handle stack states that require deletion before recreation
      const deletionRequiredStates = [
        'ROLLBACK_COMPLETE',
        'ROLLBACK_FAILED', 
        'CREATE_FAILED',
        'DELETE_FAILED'
      ];
      
      if (stackExists && stackStatus && deletionRequiredStates.includes(stackStatus)) {
        console.log(chalk.yellow(`⚠️  Found stack in ${stackStatus} state - deleting it first...`));
        await this.deleteStack(config.stackName);
        stackExists = false;
        stackStatus = undefined;
        console.log(chalk.blue('🔄 Now creating fresh stack...'));
        console.log('');
      }

      // Deploy or update stack
      const operation = stackExists ? 'update' : 'create';
      console.log(chalk.blue(`📦 ${operation === 'create' ? 'Creating' : 'Updating'} CloudFormation stack: ${config.stackName}`));

      const command = stackExists 
        ? new UpdateStackCommand({
            StackName: config.stackName,
            TemplateBody: JSON.stringify(template, null, 2),
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            Tags: [
              { Key: 'Environment', Value: config.parameters.environmentName },
              { Key: 'ManagedBy', Value: 'CLI' },
              { Key: 'Purpose', Value: 'Database Migration' }
            ]
          })
        : new CreateStackCommand({
            StackName: config.stackName,
            TemplateBody: JSON.stringify(template, null, 2),
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            Tags: [
              { Key: 'Environment', Value: config.parameters.environmentName },
              { Key: 'ManagedBy', Value: 'CLI' },
              { Key: 'Purpose', Value: 'Database Migration' }
            ]
          });

      await this.callWithMfaRetry(async () => {
        return await this.cfnClient.send(command);
      });

      // Wait for deployment to complete
      await this.waitForStackOperation(config.stackName, operation);

      console.log('');
      console.log(chalk.green('✅ Migration infrastructure deployed successfully!'));
      console.log('');
      console.log(chalk.blue('🔄 Next steps:'));
      console.log(`   1. Start migration: ${chalk.cyan(`fiftyten-db migrate start ${config.parameters.environmentName}`)}`);
      console.log(`   2. Monitor progress: ${chalk.cyan(`fiftyten-db migrate status ${config.parameters.environmentName}`)}`);
      console.log(`   3. Validate data: ${chalk.cyan(`fiftyten-db migrate validate ${config.parameters.environmentName}`)}`);

    } catch (error) {
      console.error(chalk.red('❌ CloudFormation deployment failed:'), error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Delete CloudFormation stack
   */
  async deleteStack(stackName: string): Promise<void> {
    console.log(chalk.blue('🧹 Cleaning up migration infrastructure...'));
    console.log('');

    try {
      // Check if stack exists
      let stack: Stack | undefined;
      try {
        const response = await this.callWithMfaRetry(async () => {
          const command = new DescribeStacksCommand({ StackName: stackName });
          return await this.cfnClient.send(command);
        });
        stack = response.Stacks?.[0];
      } catch (error) {
        console.log(chalk.yellow('⚠️  Migration stack not found - may already be cleaned up'));
        return;
      }

      if (!stack) {
        console.log(chalk.yellow('⚠️  Migration stack not found - may already be cleaned up'));
        return;
      }

      console.log(chalk.blue('🗑️  Deleting CloudFormation stack...'));
      
      const command = new DeleteStackCommand({ StackName: stackName });
      await this.callWithMfaRetry(async () => {
        return await this.cfnClient.send(command);
      });

      // Wait for deletion to complete
      await this.waitForStackOperation(stackName, 'delete');

      console.log('');
      console.log(chalk.green('✅ Migration infrastructure cleaned up successfully!'));
      console.log(chalk.gray('   All DMS resources have been removed'));

    } catch (error) {
      console.error(chalk.red('❌ Failed to cleanup migration:'), error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Wait for CloudFormation stack operation to complete
   */
  private async waitForStackOperation(stackName: string, operation: 'create' | 'update' | 'delete'): Promise<void> {
    const targetStatuses = {
      create: ['CREATE_COMPLETE'],
      update: ['UPDATE_COMPLETE'],
      delete: ['DELETE_COMPLETE']
    };

    const failureStatuses = {
      create: ['CREATE_FAILED', 'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED'],
      update: ['UPDATE_FAILED', 'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED'],
      delete: ['DELETE_FAILED']
    };

    let lastEventId: string | undefined;
    const startTime = Date.now();

    while (true) {
      try {
        // Get stack status
        const response = await this.callWithMfaRetry(async () => {
          const command = new DescribeStacksCommand({ StackName: stackName });
          return await this.cfnClient.send(command);
        });

        const stack = response.Stacks?.[0];
        if (!stack) {
          if (operation === 'delete') {
            // Stack deleted successfully
            break;
          }
          throw new Error('Stack not found');
        }

        const status = stack.StackStatus!;

        // Show recent events
        await this.showRecentEvents(stackName, lastEventId);

        // Update last event ID
        try {
          const eventsResponse = await this.callWithMfaRetry(async () => {
            const command = new DescribeStackEventsCommand({ StackName: stackName });
            return await this.cfnClient.send(command);
          });
          lastEventId = eventsResponse.StackEvents?.[0]?.EventId;
        } catch (error) {
          // Ignore errors getting events
        }

        // Check if operation completed
        if (targetStatuses[operation].includes(status)) {
          break;
        }

        // Check if operation failed
        if (failureStatuses[operation].includes(status)) {
          throw new Error(`Stack ${operation} failed with status: ${status}`);
        }

        // Show progress indicator
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        process.stdout.write(`\r${chalk.blue('⏳')} ${operation}ing stack... (${elapsed}s) [${status}]`);

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds

      } catch (error) {
        if (operation === 'delete' && error instanceof Error && error.message.includes('does not exist')) {
          // Stack was deleted
          break;
        }
        throw error;
      }
    }

    process.stdout.write('\n'); // New line after progress indicator
  }

  /**
   * Show recent CloudFormation events
   */
  private async showRecentEvents(stackName: string, lastEventId?: string): Promise<void> {
    try {
      const response = await this.callWithMfaRetry(async () => {
        const command = new DescribeStackEventsCommand({ StackName: stackName });
        return await this.cfnClient.send(command);
      });

      const events = response.StackEvents || [];
      let newEvents: StackEvent[] = [];

      if (lastEventId) {
        const lastIndex = events.findIndex(e => e.EventId === lastEventId);
        if (lastIndex > 0) {
          newEvents = events.slice(0, lastIndex).reverse();
        }
      } else {
        // Show last 3 events on first run
        newEvents = events.slice(0, 3).reverse();
      }

      for (const event of newEvents) {
        const timestamp = event.Timestamp?.toLocaleTimeString() || '';
        const resourceType = event.ResourceType || '';
        const resourceStatus = event.ResourceStatus || '';
        const reason = event.ResourceStatusReason || '';

        let statusColor = chalk.gray;
        if (resourceStatus.includes('COMPLETE')) {
          statusColor = chalk.green;
        } else if (resourceStatus.includes('FAILED')) {
          statusColor = chalk.red;
        } else if (resourceStatus.includes('PROGRESS')) {
          statusColor = chalk.yellow;
        }

        console.log(`   ${chalk.gray(timestamp)} ${statusColor(resourceStatus)} ${chalk.blue(resourceType)}`);
        if (reason && !reason.includes('User Initiated')) {
          console.log(`     ${chalk.gray(reason)}`);
        }
      }
    } catch (error) {
      // Ignore errors showing events
    }
  }

  /**
   * Get stack outputs
   */
  async getStackOutputs(stackName: string): Promise<Record<string, string>> {
    const response = await this.callWithMfaRetry(async () => {
      const command = new DescribeStacksCommand({ StackName: stackName });
      return await this.cfnClient.send(command);
    });

    const stack = response.Stacks?.[0];
    if (!stack?.Outputs) {
      return {};
    }

    const outputs: Record<string, string> = {};
    for (const output of stack.Outputs) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }

    return outputs;
  }
}
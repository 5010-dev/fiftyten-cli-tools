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
import { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, AuthorizeSecurityGroupIngressCommand, AuthorizeSecurityGroupEgressCommand, RevokeSecurityGroupIngressCommand, RevokeSecurityGroupEgressCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { RDSClient, DescribeDBInstancesCommand, DBInstance } from '@aws-sdk/client-rds';
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
	private rdsClient: RDSClient;
	private ssmClient: SSMClient;
	private mfaAuth: MfaAuthenticator;
	private region: string;
	private mfaAuthenticated: boolean = false;

	constructor(region: string = 'us-west-1') {
		this.region = region;
		this.cfnClient = new CloudFormationClient({ region });
		this.ec2Client = new EC2Client({ region });
		this.rdsClient = new RDSClient({ region });
		this.ssmClient = new SSMClient({ region });
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
				this.rdsClient = new RDSClient(clientConfig);
				this.ssmClient = new SSMClient(clientConfig);

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
	 * Discover database security groups for automatic connectivity configuration
	 */
	async discoverDatabaseSecurityGroups(legacyEndpoint: string, targetEndpoint: string): Promise<{
		legacySecurityGroupIds?: string[];
		targetSecurityGroupIds?: string[];
	}> {
		console.log(chalk.blue('🔍 Discovering database security groups...'));

		const result: { legacySecurityGroupIds?: string[]; targetSecurityGroupIds?: string[] } = {};

		try {
			// Get all RDS instances to find matches by endpoint
			const rdsResponse = await this.callWithMfaRetry(async () => {
				const command = new DescribeDBInstancesCommand({});
				return await this.rdsClient.send(command);
			});

			// Find legacy database by endpoint hostname
			const legacyInstance = rdsResponse.DBInstances?.find((instance: DBInstance) =>
				instance.Endpoint?.Address === legacyEndpoint
			);

			if (legacyInstance?.VpcSecurityGroups) {
				result.legacySecurityGroupIds = legacyInstance.VpcSecurityGroups
					.map((sg: any) => sg.VpcSecurityGroupId)
					.filter(Boolean) as string[];
				console.log(chalk.green(`✅ Found legacy database security groups: ${result.legacySecurityGroupIds.join(', ')}`));
			} else {
				console.log(chalk.yellow(`⚠️  Could not find legacy database with endpoint: ${legacyEndpoint}`));
			}

			// Find target database by endpoint hostname
			const targetInstance = rdsResponse.DBInstances?.find((instance: DBInstance) =>
				instance.Endpoint?.Address === targetEndpoint
			);

			if (targetInstance?.VpcSecurityGroups) {
				result.targetSecurityGroupIds = targetInstance.VpcSecurityGroups
					.map((sg: any) => sg.VpcSecurityGroupId)
					.filter(Boolean) as string[];
				console.log(chalk.green(`✅ Found target database security groups: ${result.targetSecurityGroupIds.join(', ')}`));
			} else {
				console.log(chalk.yellow(`⚠️  Could not find target database with endpoint: ${targetEndpoint}`));
			}

		} catch (error) {
			console.log(chalk.yellow('⚠️  Could not auto-discover database security groups'));
			console.log(chalk.gray('   Security group rules will need to be configured manually'));
		}

		return result;
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
			console.log(chalk.yellow('⚠️  Could not get VPC info from storage stack, trying SSM Parameter Store...'));
		}

		// Try to get VPC ID from SSM Parameter Store
		try {
			const vpcIdResponse = await this.callWithMfaRetry(async () => {
				const command = new GetParameterCommand({
					Name: `/indicator/shared/${environmentName}/network/vpc-id`
				});
				return await this.ssmClient.send(command);
			});

			const vpcId = vpcIdResponse.Parameter?.Value;
			if (vpcId) {
				console.log(chalk.green(`✅ Found VPC ID in SSM Parameter Store: ${vpcId}`));

				// Get subnets for this VPC
				const subnets = await this.callWithMfaRetry(async () => {
					const command = new DescribeSubnetsCommand({
						Filters: [
							{ Name: 'vpc-id', Values: [vpcId] },
							{ Name: 'state', Values: ['available'] }
						]
					});
					return await this.ec2Client.send(command);
				});

				const subnetIds = subnets.Subnets?.map(s => s.SubnetId!).filter(Boolean) || [];
				if (subnetIds.length >= 2) {
					return {
						vpcId,
						subnetIds: subnetIds.slice(0, 3) // DMS needs at least 2 subnets, use max 3
					};
				}
			}
		} catch (error) {
			console.log(chalk.yellow('⚠️  Could not get VPC info from SSM Parameter Store, using default VPC'));
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

			// Discover database security groups for automatic connectivity
			const targetEndpoint = config.parameters.targetEndpoint || `fiftyten-indicator-db-${config.parameters.environmentName}.cxw4cwcyepf1.us-west-1.rds.amazonaws.com`;
			const securityGroups = await this.discoverDatabaseSecurityGroups(
				config.parameters.legacyEndpoint,
				targetEndpoint
			);
			console.log('');

			// Update parameters with VPC info and security groups
			const templateParams = {
				...config.parameters,
				vpcId: vpcInfo.vpcId,
				subnetIds: vpcInfo.subnetIds,
				legacySecurityGroupIds: securityGroups.legacySecurityGroupIds,
				targetSecurityGroupIds: securityGroups.targetSecurityGroupIds
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

			// Configure security group access after successful deployment
			try {
				// Get the DMS security group ID from stack outputs
				const outputs = await this.getStackOutputs(config.stackName);
				const dmsSecurityGroupId = outputs.DMSSecurityGroupId;

				if (dmsSecurityGroupId) {
					await this.configureSecurityGroupAccess(
						dmsSecurityGroupId,
						securityGroups.legacySecurityGroupIds,
						securityGroups.targetSecurityGroupIds,
						config.parameters.environmentName
					);
				} else {
					console.log(chalk.yellow('⚠️  Could not find DMS security group ID in stack outputs'));
					console.log(chalk.gray('   Security group rules will need to be configured manually'));
				}
			} catch (error) {
				console.log(chalk.yellow('⚠️  Could not configure security group access automatically'));
				console.log(chalk.gray('   Security group rules will need to be configured manually'));
				console.log(chalk.gray(`   Error: ${error instanceof Error ? error.message : String(error)}`));
			}

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
	 * Configure security group ingress rules for database access with flexible fallback strategies
	 */
	async configureSecurityGroupAccess(
		dmsSecurityGroupId: string,
		legacySecurityGroupIds?: string[],
		targetSecurityGroupIds?: string[],
		environmentName?: string
	): Promise<void> {
		console.log(chalk.blue('🔐 Configuring security group access for database connectivity...'));

		const allSecurityGroupIds = [
			...(legacySecurityGroupIds || []),
			...(targetSecurityGroupIds || [])
		].filter(Boolean);

		if (allSecurityGroupIds.length === 0) {
			console.log(chalk.yellow('⚠️  No database security groups found - skipping automatic configuration'));
			console.log(chalk.gray('   You may need to manually configure security group rules for DMS access'));
			return;
		}

		// Get VPC CIDR for fallback CIDR-based rules
		let vpcCidr: string | undefined;
		try {
			const dmsSecurityGroup = await this.callWithMfaRetry(async () => {
				const command = new DescribeSecurityGroupsCommand({ GroupIds: [dmsSecurityGroupId] });
				return await this.ec2Client.send(command);
			});

			if (dmsSecurityGroup.SecurityGroups?.[0]?.VpcId) {
				const vpcResponse = await this.callWithMfaRetry(async () => {
					const command = new DescribeVpcsCommand({ VpcIds: [dmsSecurityGroup.SecurityGroups![0].VpcId!] });
					return await this.ec2Client.send(command);
				});
				vpcCidr = vpcResponse.Vpcs?.[0]?.CidrBlock;
			}
		} catch (error) {
			console.log(chalk.yellow('⚠️  Could not determine VPC CIDR for fallback rules'));
		}

		for (const sgId of allSecurityGroupIds) {
			await this.configureSingleSecurityGroup(sgId, dmsSecurityGroupId, vpcCidr, environmentName);
		}

		console.log(chalk.green('✅ Security group configuration completed'));
	}

	/**
	 * Remove security group rules that were added during DMS deployment
	 */
	async cleanupSecurityGroupRules(
		dmsSecurityGroupId: string,
		legacySecurityGroupIds?: string[],
		targetSecurityGroupIds?: string[]
	): Promise<void> {
		console.log(chalk.blue('🧹 Removing security group rules added for DMS connectivity...'));

		const allSecurityGroupIds = [
			...(legacySecurityGroupIds || []),
			...(targetSecurityGroupIds || [])
		].filter(Boolean);

		if (allSecurityGroupIds.length === 0) {
			console.log(chalk.yellow('⚠️  No database security groups found - skipping rule cleanup'));
			return;
		}

		for (const sgId of allSecurityGroupIds) {
			await this.removeSingleSecurityGroupRules(sgId, dmsSecurityGroupId);
		}

		console.log(chalk.green('✅ Security group rule cleanup completed'));
	}

	/**
	 * Remove bidirectional security group rules for a single database security group
	 */
	private async removeSingleSecurityGroupRules(dbSecurityGroupId: string, dmsSecurityGroupId: string): Promise<void> {
		try {
			// Remove inbound rule (DMS -> Database)
			try {
				await this.callWithMfaRetry(async () => {
					const command = new RevokeSecurityGroupIngressCommand({
						GroupId: dbSecurityGroupId,
						IpPermissions: [{
							IpProtocol: 'tcp',
							FromPort: 5432,
							ToPort: 5432,
							UserIdGroupPairs: [{
								GroupId: dmsSecurityGroupId,
								Description: 'DMS access for migration'
							}]
						}]
					});
					return await this.ec2Client.send(command);
				});
				console.log(chalk.green(`✅ Removed inbound DMS rule from ${dbSecurityGroupId}`));
			} catch (error) {
				// Rule might not exist, which is fine
				console.log(chalk.gray(`   Inbound rule already removed or doesn't exist for ${dbSecurityGroupId}`));
			}

			// Remove outbound rule (Database -> DMS) 
			try {
				await this.callWithMfaRetry(async () => {
					const command = new RevokeSecurityGroupEgressCommand({
						GroupId: dbSecurityGroupId,
						IpPermissions: [{
							IpProtocol: 'tcp',
							FromPort: 5432,
							ToPort: 5432,
							UserIdGroupPairs: [{
								GroupId: dmsSecurityGroupId,
								Description: 'DMS access for migration'
							}]
						}]
					});
					return await this.ec2Client.send(command);
				});
				console.log(chalk.green(`✅ Removed outbound DMS rule from ${dbSecurityGroupId}`));
			} catch (error) {
				// Rule might not exist, which is fine
				console.log(chalk.gray(`   Outbound rule already removed or doesn't exist for ${dbSecurityGroupId}`));
			}

		} catch (error) {
			console.log(chalk.yellow(`⚠️  Could not remove some rules from ${dbSecurityGroupId}: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	/**
	 * Configure bidirectional security group access for a single database security group with fallback strategies
	 */
	private async configureSingleSecurityGroup(
		sgId: string,
		dmsSecurityGroupId: string,
		vpcCidr?: string,
		environmentName?: string
	): Promise<void> {
		try {
			// Get security group details
			const sgResponse = await this.callWithMfaRetry(async () => {
				const command = new DescribeSecurityGroupsCommand({ GroupIds: [sgId] });
				return await this.ec2Client.send(command);
			});

			const securityGroup = sgResponse.SecurityGroups?.[0];
			if (!securityGroup) {
				console.log(chalk.yellow(`⚠️  Security group ${sgId} not found - skipping`));
				return;
			}

			// Check if any PostgreSQL rules already exist for DMS access (inbound and outbound)
			const hasExistingInboundRule = this.checkExistingPostgreSQLInboundRule(securityGroup, dmsSecurityGroupId, vpcCidr);
			const hasExistingOutboundRule = this.checkExistingPostgreSQLOutboundRule(securityGroup, dmsSecurityGroupId, vpcCidr);

			// Track configuration success
			let inboundConfigured = hasExistingInboundRule;
			let outboundConfigured = hasExistingOutboundRule;

			// Configure inbound rule (database accepts connections from DMS)
			if (hasExistingInboundRule) {
				console.log(chalk.green(`✅ Inbound security group rule already exists for ${sgId}`));
			} else {
				console.log(chalk.blue(`🔄 Configuring inbound rule for ${sgId}...`));
				if (await this.trySecurityGroupInboundReference(sgId, dmsSecurityGroupId, environmentName)) {
					console.log(chalk.green(`✅ Added inbound security group rule for ${sgId}`));
					inboundConfigured = true;
				} else if (vpcCidr && await this.tryVpcCidrInboundRule(sgId, vpcCidr, environmentName)) {
					console.log(chalk.green(`✅ Added inbound VPC CIDR rule for ${sgId}`));
					inboundConfigured = true;
				} else if (await this.tryBroadCidrInboundRule(sgId, environmentName)) {
					console.log(chalk.green(`✅ Added inbound broad CIDR rule for ${sgId}`));
					inboundConfigured = true;
				} else {
					console.log(chalk.yellow(`⚠️  Could not configure inbound rule for ${sgId}`));
				}
			}

			// Configure outbound rule (database can respond back to DMS)
			if (hasExistingOutboundRule) {
				console.log(chalk.green(`✅ Outbound security group rule already exists for ${sgId}`));
			} else {
				console.log(chalk.blue(`🔄 Configuring outbound rule for ${sgId}...`));
				if (await this.trySecurityGroupOutboundReference(sgId, dmsSecurityGroupId, environmentName)) {
					console.log(chalk.green(`✅ Added outbound security group rule for ${sgId}`));
					outboundConfigured = true;
				} else if (vpcCidr && await this.tryVpcCidrOutboundRule(sgId, vpcCidr, environmentName)) {
					console.log(chalk.green(`✅ Added outbound VPC CIDR rule for ${sgId}`));
					outboundConfigured = true;
				} else if (await this.tryBroadCidrOutboundRule(sgId, environmentName)) {
					console.log(chalk.green(`✅ Added outbound broad CIDR rule for ${sgId}`));
					outboundConfigured = true;
				} else {
					console.log(chalk.yellow(`⚠️  Could not configure outbound rule for ${sgId}`));
				}
			}

			// Only provide manual instructions if both rules failed to configure
			if (!inboundConfigured || !outboundConfigured) {
				this.provideManualInstructions(sgId, dmsSecurityGroupId, vpcCidr);
			}

		} catch (error) {
			console.log(chalk.red(`❌ Failed to configure security group ${sgId}: ${error instanceof Error ? error.message : String(error)}`));
			this.provideManualInstructions(sgId, dmsSecurityGroupId, vpcCidr);
		}
	}

	/**
	 * Check if PostgreSQL inbound rule already exists
	 */
	private checkExistingPostgreSQLInboundRule(securityGroup: any, dmsSecurityGroupId: string, vpcCidr?: string): boolean {
		return securityGroup.IpPermissions?.some((rule: any) =>
			rule.IpProtocol === 'tcp' &&
			rule.FromPort === 5432 &&
			rule.ToPort === 5432 &&
			(
				// Security group reference
				rule.UserIdGroupPairs?.some((pair: any) => pair.GroupId === dmsSecurityGroupId) ||
				// VPC CIDR
				(vpcCidr && rule.IpRanges?.some((range: any) => range.CidrIp === vpcCidr)) ||
				// Broad CIDR
				rule.IpRanges?.some((range: any) => range.CidrIp === '10.0.0.0/8')
			)
		) || false;
	}

	/**
	 * Check if PostgreSQL outbound rule already exists
	 */
	private checkExistingPostgreSQLOutboundRule(securityGroup: any, dmsSecurityGroupId: string, vpcCidr?: string): boolean {
		return securityGroup.IpPermissionsEgress?.some((rule: any) =>
			rule.IpProtocol === 'tcp' &&
			rule.FromPort === 5432 &&
			rule.ToPort === 5432 &&
			(
				// Security group reference
				rule.UserIdGroupPairs?.some((pair: any) => pair.GroupId === dmsSecurityGroupId) ||
				// VPC CIDR
				(vpcCidr && rule.IpRanges?.some((range: any) => range.CidrIp === vpcCidr)) ||
				// Broad CIDR
				rule.IpRanges?.some((range: any) => range.CidrIp === '10.0.0.0/8') ||
				// Allow all outbound (covers our case)
				rule.IpRanges?.some((range: any) => range.CidrIp === '0.0.0.0/0')
			)
		) || false;
	}

	/**
	 * Try adding inbound security group reference rule
	 */
	private async trySecurityGroupInboundReference(sgId: string, dmsSecurityGroupId: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupIngressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						UserIdGroupPairs: [
							{
								GroupId: dmsSecurityGroupId,
								Description: `Allow DMS access for database migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   Security group reference failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Try adding inbound VPC CIDR-based rule
	 */
	private async tryVpcCidrInboundRule(sgId: string, vpcCidr: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupIngressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						IpRanges: [
							{
								CidrIp: vpcCidr,
								Description: `Allow DMS access from VPC for database migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   VPC CIDR rule failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Try adding inbound broad CIDR rule (10.0.0.0/8)
	 */
	private async tryBroadCidrInboundRule(sgId: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupIngressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						IpRanges: [
							{
								CidrIp: '10.0.0.0/8',
								Description: `Allow DMS access from private networks for database migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   Broad CIDR rule failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Try adding outbound security group reference rule
	 */
	private async trySecurityGroupOutboundReference(sgId: string, dmsSecurityGroupId: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupEgressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						UserIdGroupPairs: [
							{
								GroupId: dmsSecurityGroupId,
								Description: `Allow outbound PostgreSQL to DMS for database migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   Outbound security group reference failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Try adding outbound VPC CIDR-based rule
	 */
	private async tryVpcCidrOutboundRule(sgId: string, vpcCidr: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupEgressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						IpRanges: [
							{
								CidrIp: vpcCidr,
								Description: `Allow outbound PostgreSQL to VPC for DMS migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   Outbound VPC CIDR rule failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Try adding outbound broad CIDR rule (10.0.0.0/8)
	 */
	private async tryBroadCidrOutboundRule(sgId: string, environmentName?: string): Promise<boolean> {
		try {
			const command = new AuthorizeSecurityGroupEgressCommand({
				GroupId: sgId,
				IpPermissions: [
					{
						IpProtocol: 'tcp',
						FromPort: 5432,
						ToPort: 5432,
						IpRanges: [
							{
								CidrIp: '10.0.0.0/8',
								Description: `Allow outbound PostgreSQL to private networks for DMS migration - ${environmentName || 'CLI'}`
							}
						]
					}
				]
			});

			await this.callWithMfaRetry(async () => {
				return await this.ec2Client.send(command);
			});
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				return true;
			}
			console.log(chalk.yellow(`   Outbound broad CIDR rule failed: ${error instanceof Error ? error.message : String(error)}`));
			return false;
		}
	}

	/**
	 * Provide manual instructions for security group configuration
	 */
	private provideManualInstructions(sgId: string, dmsSecurityGroupId: string, vpcCidr?: string): void {
		console.log(chalk.yellow(`⚠️  Could not automatically configure security group ${sgId}`));
		console.log(chalk.gray(''));
		console.log(chalk.gray('   Manual configuration required:'));
		console.log(chalk.gray('   1. Go to EC2 Console → Security Groups'));
		console.log(chalk.gray(`   2. Find security group: ${sgId}`));
		console.log(chalk.gray('   3. Edit Inbound Rules → Add Rule'));
		console.log(chalk.gray('   4. Type: PostgreSQL, Port: 5432'));
		console.log(chalk.gray('   5. Source options (try in order):'));
		console.log(chalk.gray(`      a) Security Group: ${dmsSecurityGroupId}`));
		if (vpcCidr) {
			console.log(chalk.gray(`      b) CIDR: ${vpcCidr} (VPC range)`));
		}
		console.log(chalk.gray('      c) CIDR: 10.0.0.0/8 (private networks)'));
		console.log(chalk.gray(''));
		console.log(chalk.gray('   Or use AWS CLI:'));
		console.log(chalk.gray(`   aws ec2 authorize-security-group-ingress \\`));
		console.log(chalk.gray(`     --group-id ${sgId} \\`));
		console.log(chalk.gray(`     --protocol tcp --port 5432 \\`));
		console.log(chalk.gray(`     --source-group ${dmsSecurityGroupId}`));
		console.log(chalk.gray(''));
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

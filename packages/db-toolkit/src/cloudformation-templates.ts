/**
 * CloudFormation templates for DMS migration infrastructure
 * These templates replicate the CDK stack functionality without requiring local CDK
 */

export interface MigrationTemplateParams {
	environmentName: string;
	vpcId: string;
	subnetIds: string[];
	legacyEndpoint: string;
	legacyDatabase: string;
	legacyUsername: string;
	legacyPassword: string;
	targetSecretArn: string;
	targetEndpoint?: string;
	targetDatabase?: string;
	targetUsername?: string;
	migrationType?: 'full-load' | 'full-load-and-cdc';
	notificationEmails?: string[];
	legacySecurityGroupIds?: string[];
	targetSecurityGroupIds?: string[];
}

export function generateMigrationTemplate(params: MigrationTemplateParams): any {
	const {
		environmentName,
		vpcId,
		subnetIds,
		legacyEndpoint,
		legacyDatabase,
		legacyUsername,
		legacyPassword,
		targetSecretArn,
		targetEndpoint,
		targetDatabase,
		targetUsername,
		migrationType = 'full-load-and-cdc',
		notificationEmails,
	} = params;

	return {
		AWSTemplateFormatVersion: '2010-09-09',
		Description: `DMS Migration Infrastructure for ${environmentName} environment`,

		Parameters: {
			Environment: {
				Type: 'String',
				Default: environmentName,
				Description: 'Environment name (dev/main)'
			},
			LegacyEndpoint: {
				Type: 'String',
				Default: legacyEndpoint,
				Description: 'Legacy database endpoint for migration source'
			}
		},

		Resources: {
			// DMS CloudWatch Logs Role (required by AWS DMS)
			DMSCloudWatchLogsRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: 'dms-cloudwatch-logs-role',
					AssumeRolePolicyDocument: {
						Version: '2012-10-17',
						Statement: [
							{
								Effect: 'Allow',
								Principal: {
									Service: 'dms.amazonaws.com'
								},
								Action: 'sts:AssumeRole'
							}
						]
					},
					ManagedPolicyArns: [
						'arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole'
					],
					Tags: [
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				}
			},

			// DMS VPC Role
			DMSVPCRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: `dms-vpc-role-${environmentName}`,
					AssumeRolePolicyDocument: {
						Version: '2012-10-17',
						Statement: [
							{
								Effect: 'Allow',
								Principal: {
									Service: 'dms.amazonaws.com'
								},
								Action: 'sts:AssumeRole'
							}
						]
					},
					ManagedPolicyArns: [
						'arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole',
						'arn:aws:iam::aws:policy/service-role/AmazonDMSCloudWatchLogsRole'
					],
					Tags: [
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				}
			},

			// Security Group for DMS
			DMSSecurityGroup: {
				Type: 'AWS::EC2::SecurityGroup',
				Properties: {
					GroupName: `dms-replication-${environmentName}-sg`,
					GroupDescription: `Security group for ${environmentName} DMS replication instance`,
					VpcId: vpcId,
					SecurityGroupEgress: [
						{
							IpProtocol: '-1',
							CidrIp: '0.0.0.0/0',
							Description: 'Allow all outbound traffic'
						}
					],
					SecurityGroupIngress: [
						{
							IpProtocol: 'tcp',
							FromPort: 5432,
							ToPort: 5432,
							CidrIp: '10.0.0.0/8',
							Description: 'Allow DMS access to PostgreSQL databases'
						}
					],
					Tags: [
						{
							Key: 'Name',
							Value: `dms-replication-${environmentName}-sg`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				}
			},

			// DMS Replication Subnet Group
			ReplicationSubnetGroup: {
				Type: 'AWS::DMS::ReplicationSubnetGroup',
				Properties: {
					ReplicationSubnetGroupIdentifier: `dms-subnet-group-${environmentName}`,
					ReplicationSubnetGroupDescription: `DMS subnet group for ${environmentName} migration`,
					SubnetIds: subnetIds,
					Tags: [
						{
							Key: 'Name',
							Value: `dms-subnet-group-${environmentName}`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				}
			},

			// DMS Replication Instance
			ReplicationInstance: {
				Type: 'AWS::DMS::ReplicationInstance',
				Properties: {
					ReplicationInstanceIdentifier: `dms-replication-${environmentName}`,
					ReplicationInstanceClass: environmentName === 'main' ? 'dms.t3.small' : 'dms.t3.micro',
					AllocatedStorage: environmentName === 'main' ? 50 : 20,
					MultiAZ: environmentName === 'main',
					ReplicationSubnetGroupIdentifier: {
						Ref: 'ReplicationSubnetGroup'
					},
					VpcSecurityGroupIds: [
						{
							Ref: 'DMSSecurityGroup'
						}
					],
					EngineVersion: '3.5.3',
					AutoMinorVersionUpgrade: true,
					Tags: [
						{
							Key: 'Name',
							Value: `dms-replication-${environmentName}`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				},
				DependsOn: ['ReplicationSubnetGroup', 'DMSSecurityGroup']
			},

			// Note: Security group ingress rules are configured via direct EC2 API calls
			// after stack deployment to avoid CloudFormation resource ownership issues

			// Source Endpoint (Legacy Database)
			SourceEndpoint: {
				Type: 'AWS::DMS::Endpoint',
				Properties: {
					EndpointIdentifier: `dms-source-${environmentName}`,
					EndpointType: 'source',
					EngineName: 'postgres',
					ServerName: legacyEndpoint,
					Port: 5432,
					DatabaseName: legacyDatabase,
					Username: legacyUsername,
					Password: legacyPassword,
					// Force SSL connection to bypass pg_hba.conf restrictions
					SslMode: 'require',
					Tags: [
						{
							Key: 'Name',
							Value: `dms-source-${environmentName}`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				}
			},

			// Target Endpoint (New Database)
			TargetEndpoint: {
				Type: 'AWS::DMS::Endpoint',
				Properties: {
					EndpointIdentifier: `dms-target-${environmentName}`,
					EndpointType: 'target',
					EngineName: 'postgres',
					ServerName: targetEndpoint || `fiftyten-indicator-db-${environmentName}.cxw4cwcyepf1.us-west-1.rds.amazonaws.com`,
					Port: 5432,
					DatabaseName: targetDatabase || 'indicator_db',
					Username: targetUsername || 'fiftyten',
					Password: `{{resolve:secretsmanager:${targetSecretArn}:SecretString:password}}`,
					// Force SSL connection to match RDS requirements
					SslMode: 'require',
					Tags: [
						{
							Key: 'Name',
							Value: `dms-target-${environmentName}`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				},
				DependsOn: ['DMSVPCRole']
			},

			// CloudWatch Log Group
			DMSLogGroup: {
				Type: 'AWS::Logs::LogGroup',
				Properties: {
					LogGroupName: `/aws/dms/task/migration-task-${environmentName}`,
					RetentionInDays: 30
				}
			},

			// Migration Task
			MigrationTask: {
				Type: 'AWS::DMS::ReplicationTask',
				Properties: {
					ReplicationTaskIdentifier: `migration-task-${environmentName}`,
					MigrationType: migrationType,
					ReplicationInstanceArn: {
						Ref: 'ReplicationInstance'
					},
					SourceEndpointArn: {
						Ref: 'SourceEndpoint'
					},
					TargetEndpointArn: {
						Ref: 'TargetEndpoint'
					},
					TableMappings: JSON.stringify({
						rules: [
							{
								'rule-type': 'selection',
								'rule-id': '1',
								'rule-name': '1',
								'object-locator': {
									'schema-name': 'public',
									'table-name': '%'
								},
								'rule-action': 'include'
							}
						]
					}),
					ReplicationTaskSettings: JSON.stringify({
						FullLoadSettings: {
							TargetTablePrepMode: 'DO_NOTHING',
							CreatePkAfterFullLoad: false,
							StopTaskCachedChangesApplied: true,
							StopTaskCachedChangesNotApplied: false,
							MaxFullLoadSubTasks: 8
						},
						Logging: {
							EnableLogging: true,
							LogComponents: [
								{
									Id: 'SOURCE_UNLOAD',
									Severity: 'LOGGER_SEVERITY_DEFAULT'
								},
								{
									Id: 'TARGET_LOAD',
									Severity: 'LOGGER_SEVERITY_DEFAULT'
								},
								{
									Id: 'SOURCE_CAPTURE',
									Severity: 'LOGGER_SEVERITY_DEFAULT'
								},
								{
									Id: 'TARGET_APPLY',
									Severity: 'LOGGER_SEVERITY_DEFAULT'
								},
								{
									Id: 'TASK_MANAGER',
									Severity: 'LOGGER_SEVERITY_DEFAULT'
								}
							]
						}
					}),
					Tags: [
						{
							Key: 'Name',
							Value: `migration-task-${environmentName}`
						},
						{
							Key: 'Environment',
							Value: environmentName
						},
						{
							Key: 'ManagedBy',
							Value: 'CLI'
						}
					]
				},
				DependsOn: ['ReplicationInstance', 'SourceEndpoint', 'TargetEndpoint', 'DMSLogGroup']
			},

			// SNS Topic for notifications (optional)
			...(notificationEmails && notificationEmails.length > 0 ? {
				NotificationTopic: {
					Type: 'AWS::SNS::Topic',
					Properties: {
						TopicName: `dms-migration-${environmentName}-notifications`,
						DisplayName: `DMS Migration Notifications - ${environmentName}`,
						Subscription: notificationEmails.map(email => ({
							Protocol: 'email',
							Endpoint: email
						}))
					}
				},

				// CloudWatch Alarms
				MigrationTaskStateAlarm: {
					Type: 'AWS::CloudWatch::Alarm',
					Properties: {
						AlarmName: `dms-task-failed-${environmentName}`,
						AlarmDescription: `DMS migration task failed in ${environmentName}`,
						MetricName: 'ReplicationTaskState',
						Namespace: 'AWS/DMS',
						Statistic: 'Maximum',
						Period: 60,
						EvaluationPeriods: 1,
						Threshold: 1,
						ComparisonOperator: 'LessThanThreshold',
						TreatMissingData: 'breaching',
						Dimensions: [
							{
								Name: 'ReplicationTaskIdentifier',
								Value: {
									Ref: 'MigrationTask'
								}
							}
						],
						AlarmActions: [
							{
								Ref: 'NotificationTopic'
							}
						]
					},
					DependsOn: ['MigrationTask', 'NotificationTopic']
				},

				ReplicationInstanceCPUAlarm: {
					Type: 'AWS::CloudWatch::Alarm',
					Properties: {
						AlarmName: `dms-cpu-high-${environmentName}`,
						AlarmDescription: `DMS replication instance CPU high in ${environmentName}`,
						MetricName: 'CPUUtilization',
						Namespace: 'AWS/DMS',
						Statistic: 'Average',
						Period: 300,
						EvaluationPeriods: 3,
						Threshold: 80,
						ComparisonOperator: 'GreaterThanThreshold',
						Dimensions: [
							{
								Name: 'ReplicationInstanceIdentifier',
								Value: {
									Ref: 'ReplicationInstance'
								}
							}
						],
						AlarmActions: [
							{
								Ref: 'NotificationTopic'
							}
						]
					},
					DependsOn: ['ReplicationInstance', 'NotificationTopic']
				}
			} : {})
		},

		Outputs: {
			DMSSecurityGroupId: {
				Description: 'DMS Security Group ID',
				Value: {
					Ref: 'DMSSecurityGroup'
				},
				Export: {
					Name: `indicator-${environmentName}-dms-security-group-id`
				}
			},
			ReplicationInstanceArn: {
				Description: 'DMS Replication Instance ARN',
				Value: {
					Ref: 'ReplicationInstance'
				},
				Export: {
					Name: `indicator-${environmentName}-dms-replication-instance-arn`
				}
			},
			MigrationTaskArn: {
				Description: 'DMS Migration Task ARN',
				Value: {
					Ref: 'MigrationTask'
				},
				Export: {
					Name: `indicator-${environmentName}-dms-migration-task-arn`
				}
			},
			SourceEndpointArn: {
				Description: 'DMS Source Endpoint ARN',
				Value: {
					Ref: 'SourceEndpoint'
				},
				Export: {
					Name: `indicator-${environmentName}-dms-source-endpoint-arn`
				}
			},
			TargetEndpointArn: {
				Description: 'DMS Target Endpoint ARN',
				Value: {
					Ref: 'TargetEndpoint'
				},
				Export: {
					Name: `indicator-${environmentName}-dms-target-endpoint-arn`
				}
			},
			LegacyEndpoint: {
				Description: 'Legacy database endpoint',
				Value: legacyEndpoint,
				Export: {
					Name: `indicator-${environmentName}-legacy-endpoint`
				}
			},
			TargetEndpoint: {
				Description: 'Target database endpoint',
				Value: targetEndpoint || `fiftyten-indicator-db-${environmentName}.cxw4cwcyepf1.us-west-1.rds.amazonaws.com`,
				Export: {
					Name: `indicator-${environmentName}-target-endpoint`
				}
			},
			...(notificationEmails && notificationEmails.length > 0 ? {
				NotificationTopicArn: {
					Description: 'SNS Topic ARN for migration notifications',
					Value: {
						Ref: 'NotificationTopic'
					},
					Export: {
						Name: `indicator-${environmentName}-dms-notification-topic-arn`
					}
				}
			} : {})
		}
	};
}

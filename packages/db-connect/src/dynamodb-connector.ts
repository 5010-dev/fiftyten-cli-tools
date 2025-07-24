import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import chalk from 'chalk';
import { MfaAuthenticator } from './mfa-auth';

export interface DynamoDBTableInfo {
  tableName: string;
  status: string;
  itemCount?: number;
  sizeBytes?: number;
  creationDateTime?: Date;
}

export class DynamoDBConnector {
  private dynamoClient: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;
  private mfaAuth: MfaAuthenticator;
  private mfaAuthenticated: boolean = false;

  constructor(region: string = 'us-west-1') {
    this.dynamoClient = new DynamoDBClient({ region });
    this.docClient = DynamoDBDocumentClient.from(this.dynamoClient);
    this.mfaAuth = new MfaAuthenticator(region);
  }

  /**
   * Ensure MFA authentication if required
   */
  private async ensureMfaAuthentication(): Promise<void> {
    if (!this.mfaAuthenticated) {
      console.log(chalk.yellow('🔐 MFA authentication may be required for DynamoDB access...'));
      try {
        await this.mfaAuth.authenticateWithMfa();
        this.mfaAuthenticated = true;
        console.log(chalk.green('✅ MFA authentication successful'));
      } catch (error) {
        console.log(chalk.blue('ℹ️  Proceeding without MFA - may work with existing credentials'));
      }
    }
  }

  /**
   * List all DynamoDB tables
   */
  async listTables(): Promise<void> {
    await this.ensureMfaAuthentication();

    try {
      console.log(chalk.blue('📋 Listing DynamoDB tables...'));
      
      const command = new ListTablesCommand({});
      const response = await this.dynamoClient.send(command);
      
      if (!response.TableNames || response.TableNames.length === 0) {
        console.log(chalk.yellow('No DynamoDB tables found'));
        return;
      }

      console.log(chalk.green(`\n✅ Found ${response.TableNames.length} tables:`));
      
      for (const tableName of response.TableNames) {
        try {
          const describeCommand = new DescribeTableCommand({ TableName: tableName });
          const tableInfo = await this.dynamoClient.send(describeCommand);
          
          const table = tableInfo.Table;
          console.log(chalk.cyan(`\n📊 ${tableName}`));
          console.log(`   Status: ${table?.TableStatus}`);
          console.log(`   Items: ${table?.ItemCount || 'Unknown'}`);
          console.log(`   Size: ${table?.TableSizeBytes ? `${(table.TableSizeBytes / 1024).toFixed(2)} KB` : 'Unknown'}`);
          console.log(`   Created: ${table?.CreationDateTime?.toISOString() || 'Unknown'}`);
        } catch (error) {
          console.log(chalk.cyan(`\n📊 ${tableName}`));
          console.log(chalk.red(`   Error getting details: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      }
    } catch (error) {
      throw new Error(`Failed to list tables: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Filter out sensitive fields from data
   */
  private filterSensitiveFields(items: any[]): any[] {
    const sensitiveFields = [
      'encrypted_api_key',
      'encrypted_secret_key', 
      'dek_encrypted',
      'api_key',
      'secret_key',
      'passphrase',
      'password',
      'token',
      'access_token',
      'refresh_token'
    ];
    
    return items.map(item => {
      const filteredItem = { ...item };
      sensitiveFields.forEach(field => {
        if (filteredItem[field]) {
          filteredItem[field] = '[HIDDEN]';
        }
      });
      return filteredItem;
    });
  }

  /**
   * Scan a DynamoDB table
   */
  async scanTable(tableName: string, limit?: number): Promise<void> {
    await this.ensureMfaAuthentication();

    try {
      console.log(chalk.blue(`🔍 Scanning table: ${tableName}${limit ? ` (limit: ${limit})` : ''}...`));
      
      const command = new ScanCommand({
        TableName: tableName,
        ...(limit && { Limit: limit })
      });
      
      const response = await this.docClient.send(command);
      
      if (!response.Items || response.Items.length === 0) {
        console.log(chalk.yellow('No items found'));
        return;
      }

      // Always filter sensitive fields for security
      const items = this.filterSensitiveFields(response.Items);
      
      console.log(chalk.green(`\n✅ Found ${items.length} items (sensitive fields hidden):`));
      console.log(JSON.stringify(items, null, 2));
      
      if (response.LastEvaluatedKey) {
        console.log(chalk.yellow('\n⚠️  More items available (pagination truncated)'));
      }
    } catch (error) {
      throw new Error(`Failed to scan table: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Query a DynamoDB table
   */
  async queryTable(tableName: string, keyCondition: string, limit?: number): Promise<void> {
    await this.ensureMfaAuthentication();

    try {
      console.log(chalk.blue(`🔎 Querying table: ${tableName}`));
      console.log(chalk.gray(`Key condition: ${keyCondition}${limit ? ` (limit: ${limit})` : ''}`));
      
      // Parse simple key condition (e.g., "pk = 'value'")
      const match = keyCondition.match(/(\w+)\s*=\s*['"]?([^'"]+)['"]?/);
      if (!match) {
        throw new Error('Invalid key condition format. Use: "keyName = value"');
      }
      
      const [, keyName, keyValue] = match;
      
      const command = new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: `#pk = :pk`,
        ExpressionAttributeNames: {
          '#pk': keyName
        },
        ExpressionAttributeValues: {
          ':pk': keyValue
        },
        ...(limit && { Limit: limit })
      });
      
      const response = await this.docClient.send(command);
      
      if (!response.Items || response.Items.length === 0) {
        console.log(chalk.yellow('No items found'));
        return;
      }

      // Always filter sensitive fields for security
      const items = this.filterSensitiveFields(response.Items);

      console.log(chalk.green(`\n✅ Found ${items.length} items (sensitive fields hidden):`));
      console.log(JSON.stringify(items, null, 2));
      
      if (response.LastEvaluatedKey) {
        console.log(chalk.yellow('\n⚠️  More items available (pagination truncated)'));
      }
    } catch (error) {
      throw new Error(`Failed to query table: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a specific item from DynamoDB table
   */
  async getItem(tableName: string, key: string): Promise<void> {
    await this.ensureMfaAuthentication();

    try {
      console.log(chalk.blue(`🎯 Getting item from table: ${tableName}`));
      console.log(chalk.gray(`Key: ${key}`));
      
      // Parse simple key (e.g., "pk:value" or JSON)
      let keyObj: Record<string, any>;
      
      if (key.startsWith('{')) {
        // JSON format
        keyObj = JSON.parse(key);
      } else {
        // Simple format "keyName:value"
        const [keyName, keyValue] = key.split(':');
        if (!keyName || !keyValue) {
          throw new Error('Invalid key format. Use: "keyName:value" or JSON format');
        }
        keyObj = { [keyName]: keyValue };
      }
      
      const command = new GetCommand({
        TableName: tableName,
        Key: keyObj
      });
      
      const response = await this.docClient.send(command);
      
      if (!response.Item) {
        console.log(chalk.yellow('Item not found'));
        return;
      }

      // Always filter sensitive fields for security
      const [filteredItem] = this.filterSensitiveFields([response.Item]);
      
      console.log(chalk.green('\n✅ Item found (sensitive fields hidden):'));
      console.log(JSON.stringify(filteredItem, null, 2));
    } catch (error) {
      throw new Error(`Failed to get item: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Describe a specific table
   */
  async describeTable(tableName: string): Promise<void> {
    await this.ensureMfaAuthentication();

    try {
      console.log(chalk.blue(`📊 Describing table: ${tableName}...`));
      
      const command = new DescribeTableCommand({ TableName: tableName });
      const response = await this.dynamoClient.send(command);
      
      const table = response.Table;
      if (!table) {
        console.log(chalk.yellow('Table not found'));
        return;
      }

      console.log(chalk.green('\n✅ Table details:'));
      console.log(`Name: ${table.TableName}`);
      console.log(`Status: ${table.TableStatus}`);
      console.log(`Items: ${table.ItemCount || 'Unknown'}`);
      console.log(`Size: ${table.TableSizeBytes ? `${(table.TableSizeBytes / 1024).toFixed(2)} KB` : 'Unknown'}`);
      console.log(`Created: ${table.CreationDateTime?.toISOString() || 'Unknown'}`);
      
      if (table.KeySchema) {
        console.log('\nKey Schema:');
        table.KeySchema.forEach(key => {
          console.log(`  ${key.AttributeName}: ${key.KeyType}`);
        });
      }
      
      if (table.AttributeDefinitions) {
        console.log('\nAttribute Definitions:');
        table.AttributeDefinitions.forEach(attr => {
          console.log(`  ${attr.AttributeName}: ${attr.AttributeType}`);
        });
      }
      
      if (table.GlobalSecondaryIndexes) {
        console.log('\nGlobal Secondary Indexes:');
        table.GlobalSecondaryIndexes.forEach(gsi => {
          console.log(`  ${gsi.IndexName}: ${gsi.IndexStatus}`);
        });
      }
    } catch (error) {
      throw new Error(`Failed to describe table: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
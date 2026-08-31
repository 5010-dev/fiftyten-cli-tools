import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation';
import { spawn, spawnSync } from 'child_process';
import { createConnection } from 'net';
import * as readline from 'readline';
import chalk from 'chalk';
import { MfaAuthenticator } from './mfa-auth';

export interface RedisEndpoint {
	host: string;
	port: string;
}

export interface RedisRunOptions {
	bot?: string;
	db?: number;
	write: boolean;
	yes: boolean;
	port: number;
	command: string[]; // empty → interactive session
}

// Read-only verbs run without --write. Anything not listed is treated as a
// mutation (safe default). CONFIG is special-cased to GET below.
const READ_ONLY_COMMANDS = new Set([
	'GET', 'GETRANGE', 'SUBSTR', 'STRLEN', 'MGET', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
	'EXPIRETIME', 'PEXPIRETIME', 'KEYS', 'SCAN', 'RANDOMKEY', 'DBSIZE', 'DUMP',
	'OBJECT', 'MEMORY', 'LLEN', 'LRANGE', 'LINDEX', 'LPOS', 'HGET', 'HMGET',
	'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HSCAN', 'HRANDFIELD',
	'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SSCAN', 'SINTER',
	'SINTERCARD', 'SUNION', 'SDIFF', 'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX',
	'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZREVRANGEBYLEX', 'ZCARD', 'ZSCORE', 'ZMSCORE',
	'ZRANK', 'ZREVRANK', 'ZCOUNT', 'ZLEXCOUNT', 'ZSCAN', 'ZRANDMEMBER', 'ZDIFF',
	'ZINTER', 'ZUNION', 'ZINTERCARD', 'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO',
	'XPENDING', 'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'BITCOUNT',
	'BITPOS', 'GETBIT', 'SORT_RO', 'PING', 'ECHO', 'INFO', 'TIME', 'COMMAND',
	'LOLWUT', 'LATENCY', 'SLOWLOG', 'WAIT',
]);

// Broadly-catastrophic verbs need an extra confirmation even with --write.
const DESTRUCTIVE_COMMANDS = new Set([
	'FLUSHALL', 'FLUSHDB', 'DEL', 'UNLINK', 'SWAPDB', 'MIGRATE', 'RENAME',
]);

type CommandClass = 'read' | 'write' | 'destructive';

function classifyCommand(command: string[]): CommandClass {
	const verb = (command[0] || '').toUpperCase();
	if (DESTRUCTIVE_COMMANDS.has(verb)) return 'destructive';
	if (verb === 'CONFIG') return (command[1] || '').toUpperCase() === 'GET' ? 'read' : 'write';
	if (READ_ONLY_COMMANDS.has(verb)) return 'read';
	return 'write';
}

function confirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} [y/N]: `, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}

// Valkey speaks the Redis protocol; valkey-cli and redis-cli both work.
// Prefer valkey-cli (matches the ElastiCache backend), fall back to redis-cli.
function resolveCacheCli(): string {
	for (const bin of ['valkey-cli', 'redis-cli']) {
		if (!spawnSync(bin, ['--version'], { encoding: 'utf-8' }).error) return bin;
	}
	throw new Error('No Valkey/Redis CLI found on PATH. Install one with: brew install valkey (or brew install redis).');
}

export class RedisConnector {
	private ec2Client: EC2Client;
	private ssmClient: SSMClient;
	private cfnClient: CloudFormationClient;
	private mfaAuth: MfaAuthenticator;
	private region: string;
	private mfaAuthenticated: boolean = false;

	constructor(region: string = 'us-west-1') {
		this.region = region;
		this.ec2Client = new EC2Client({ region });
		this.ssmClient = new SSMClient({ region });
		this.cfnClient = new CloudFormationClient({ region });
		this.mfaAuth = new MfaAuthenticator(region);
	}

	private async callWithMfaRetry<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (this.mfaAuth.isMfaRequired(error) && !this.mfaAuthenticated) {
				console.error(chalk.yellow('⚠️  MFA authentication required for AWS access'));
				const credentials = await this.mfaAuth.authenticateWithMfa();
				this.mfaAuth.applyCredentials(credentials);
				const clientConfig = {
					region: this.region,
					credentials: {
						accessKeyId: credentials.accessKeyId,
						secretAccessKey: credentials.secretAccessKey,
						sessionToken: credentials.sessionToken,
					},
				};
				this.ec2Client = new EC2Client(clientConfig);
				this.ssmClient = new SSMClient(clientConfig);
				this.cfnClient = new CloudFormationClient(clientConfig);
				this.mfaAuthenticated = true;
				return await operation();
			}
			throw error;
		}
	}

	private async isPortAvailable(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const connection = createConnection({ port, host: 'localhost' });
			connection.on('connect', () => {
				connection.destroy();
				resolve(false);
			});
			connection.on('error', () => resolve(true));
		});
	}

	private async findAvailablePort(startPort: number): Promise<number> {
		for (let port = startPort; port <= startPort + 10; port++) {
			if (await this.isPortAvailable(port)) return port;
		}
		throw new Error(`No available ports found in range ${startPort}-${startPort + 10}`);
	}

	private async getBastionInstanceId(environment: string): Promise<string> {
		try {
			const info = await this.callWithMfaRetry(async () => {
				const command = new GetParameterCommand({ Name: `/indicator/bastion/${environment}/connection-info` });
				return await this.ssmClient.send(command);
			});
			if (info.Parameter?.Value) {
				const parsed = JSON.parse(info.Parameter.Value);
				if (parsed.instanceId) return parsed.instanceId;
			}
		} catch {
			console.error(chalk.yellow('Could not get instance ID from SSM, searching EC2...'));
		}

		const response = await this.callWithMfaRetry(async () => {
			const command = new DescribeInstancesCommand({
				Filters: [
					{ Name: 'tag:Name', Values: [`indicator-bastion-${environment}-host`] },
					{ Name: 'instance-state-name', Values: ['running', 'stopped'] },
				],
			});
			return await this.ec2Client.send(command);
		});

		const instanceId = response.Reservations?.[0]?.Instances?.[0]?.InstanceId;
		if (!instanceId) throw new Error(`No bastion host found for environment: ${environment}`);
		return instanceId;
	}

	/**
	 * Resolve the encrypted Valkey v2 primary endpoint from the storage-infra
	 * CloudFormation exports ({env}-redis-v2-endpoint / {env}-redis-v2-port).
	 * The v2 group remains in transit-encryption `preferred` mode during this
	 * migration, so the local tunnel and CLI protocol stay unchanged.
	 */
	private async getRedisEndpoint(environment: string): Promise<RedisEndpoint> {
		const exports: Record<string, string> = {};
		let nextToken: string | undefined;
		do {
			const page = await this.callWithMfaRetry(async () => {
				return await this.cfnClient.send(new ListExportsCommand({ NextToken: nextToken }));
			});
			for (const exp of page.Exports || []) {
				if (exp.Name && exp.Value) exports[exp.Name] = exp.Value;
			}
			nextToken = page.NextToken;
		} while (nextToken);

		const host = exports[`${environment}-redis-v2-endpoint`];
		const port = exports[`${environment}-redis-v2-port`];
		if (!host || !port) {
			throw new Error(`Valkey endpoint exports not found for '${environment}' (expected ${environment}-redis-v2-endpoint / ${environment}-redis-v2-port)`);
		}
		return { host, port };
	}

	private async getBotDbIndex(environment: string, bot: string): Promise<number> {
		const response = await this.callWithMfaRetry(async () => {
			const command = new GetParameterCommand({ Name: `/indicator/quant/${environment}/bots/${bot}/valkey-db-index` });
			return await this.ssmClient.send(command);
		});
		const raw = response.Parameter?.Value;
		const index = raw !== undefined ? parseInt(raw, 10) : NaN;
		if (Number.isNaN(index)) {
			throw new Error(`valkey-db-index not found for bot '${bot}' in ${environment}`);
		}
		return index;
	}

	private waitForTunnel(child: ReturnType<typeof spawn>): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			child.stdout?.on('data', (data) => {
				const out = data.toString();
				if (out.includes('Waiting for connections') || out.includes('Port forwarding session started')) finish();
			});
			child.stderr?.on('data', (data) => console.error(chalk.gray(data.toString().trim())));
			child.on('error', (error) => {
				console.error(chalk.red('Error starting tunnel:'), error.message);
				console.error(chalk.yellow('Make sure AWS CLI and the Session Manager plugin are installed'));
				finish();
			});
			setTimeout(finish, 5000);
		});
	}

	async run(environment: string, options: RedisRunOptions): Promise<void> {
		const cacheCli = resolveCacheCli();
		const interactive = options.command.length === 0;
		const cls = interactive ? null : classifyCommand(options.command);

		// Write gate (posture b) — verb-based, before any AWS call.
		if (interactive) {
			if (!options.write) {
				throw new Error('Interactive session is write-capable — re-run with --write, or use one-shot mode ("-- <command>") for reads.');
			}
		} else if (cls !== 'read' && !options.write) {
			throw new Error(`'${options.command[0]}' is a write command — re-run with --write to allow mutations.`);
		}

		// Resolve the logical DB index: --bot wins, else -n, else 0 (shared/meta).
		let db = options.db ?? 0;
		if (options.bot) db = await this.getBotDbIndex(environment, options.bot);
		const target = `${environment}${options.bot ? '/' + options.bot : ''} (db ${db})`;

		// Destructive commands confirm against the resolved target, even with --write.
		if (cls === 'destructive' && !options.yes) {
			const ok = await confirm(chalk.red(`⚠️  '${options.command.join(' ')}' is destructive on ${target}. Proceed?`));
			if (!ok) { console.error(chalk.gray('Aborted.')); return; }
		}

		console.error(chalk.blue('🔗 Resolving Valkey endpoint via CloudFormation exports...'));
		const endpoint = await this.getRedisEndpoint(environment);
		const instanceId = await this.getBastionInstanceId(environment);
		const localPort = await this.findAvailablePort(options.port);

		console.error(chalk.blue('🚀 Starting Valkey tunnel via Session Manager...'));
		const tunnelArgs = [
			'ssm', 'start-session',
			'--target', instanceId,
			'--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
			'--parameters', `host=${endpoint.host},portNumber=${endpoint.port},localPortNumber=${localPort}`,
		];
		const tunnel = spawn('aws', tunnelArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
		await this.waitForTunnel(tunnel);

		const keyCount = spawnSync(cacheCli, ['-h', 'localhost', '-p', String(localPort), '-n', String(db), 'DBSIZE'], { encoding: 'utf-8' }).stdout?.trim() || '?';

		console.error('');
		console.error(chalk.green('✅ Connected to Valkey'));
		console.error(`   Env: ${chalk.yellow(environment)}   Bot: ${chalk.yellow(options.bot || '-')}   DB index: ${chalk.yellow(db)}   Keys: ${chalk.yellow(keyCount)}`);
		console.error(`   Endpoint: ${chalk.gray(`${endpoint.host}:${endpoint.port}`)} (via localhost:${localPort})`);
		if (interactive) console.error(chalk.red('   ⚠️  Write-capable session — commands here directly affect live state.'));
		console.error('');

		if (interactive && !options.yes) {
			const ok = await confirm(chalk.yellow(`Open write-capable redis-cli session on ${target}?`));
			if (!ok) { console.error(chalk.gray('Aborted.')); tunnel.kill(); return; }
		}

		const cliArgs = ['-h', 'localhost', '-p', String(localPort), '-n', String(db), ...options.command];
		await new Promise<void>((resolve, reject) => {
			const child = spawn(cacheCli, cliArgs, { stdio: 'inherit' });
			child.on('exit', (code) => {
				tunnel.kill();
				// The SSM tunnel keeps the event loop alive; exit explicitly so
				// one-shot commands return to the prompt, propagating the CLI's code.
				process.exit(code ?? 0);
			});
			child.on('error', (error) => {
				tunnel.kill();
				reject(error);
			});
		});
	}
}

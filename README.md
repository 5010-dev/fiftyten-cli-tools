# Fiftyten CLI Tools

A collection of command-line tools for the Fiftyten platform, designed to improve developer experience and operational efficiency.

## 🚀 Tools Available

### [@fiftyten/db-connect](./packages/db-connect)
Simple CLI tool for connecting to Fiftyten databases via AWS Session Manager.

**Quick Start:**
```bash
# Install globally (pnpm - team standard)
pnpm add -g @fiftyten/db-connect

# Create database tunnel
fiftyten-db tunnel dev

# Connect to database
psql -h localhost -p 5432 -d platform -U fiftyten
```

## 📦 Installation

### Global Installation (Recommended)

#### With pnpm (Team Standard)
```bash
pnpm add -g @fiftyten/db-connect
```

#### With npm
```bash
npm install -g @fiftyten/db-connect
```

### One-time Usage (No Installation)

#### With pnpm
```bash
pnpm dlx @fiftyten/db-connect tunnel dev
```

#### With npm
```bash
npx @fiftyten/db-connect tunnel dev
```

## 🏗️ Development

This is a monorepo using pnpm workspaces.

### Setup
```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Working with Packages
```bash
# Install dependencies for specific package
pnpm --filter db-connect install

# Build specific package
pnpm --filter db-connect build

# Run specific package
pnpm --filter db-connect dev
```

### Adding New Tools
```bash
# Create new package
mkdir packages/new-tool
cd packages/new-tool
npm init -y

# Add to workspace (automatic with pnpm)
```

## 📋 Tool Guidelines

### Package Structure
```
packages/your-tool/
├── package.json        # Package configuration
├── tsconfig.json       # TypeScript configuration
├── README.md          # Tool documentation
├── bin/               # Executable files
├── src/               # Source code
└── dist/              # Compiled output (gitignored)
```

### Naming Convention
- **Package name**: `@fiftyten/tool-name`
- **Binary name**: `fiftyten-tool` or descriptive name
- **Repository folder**: `tool-name`

### Requirements
- **TypeScript**: All tools must be written in TypeScript
- **Tests**: Include comprehensive tests
- **Documentation**: Clear README with examples
- **CLI Standards**: Follow common CLI patterns (help, version, etc.)

## 🔐 Security

- All tools must follow security best practices
- Use AWS SDK v3 for AWS integrations
- Never hardcode credentials or sensitive data
- Support AWS credential chain (IAM roles, profiles, etc.)

## 🚀 Publishing

Packages are automatically published to npm when:
- Changes are merged to `main` branch
- Package version is bumped
- GitHub Actions CI passes

### Manual Publishing
```bash
# Publish all changed packages
pnpm publish-packages

# Publish specific package
pnpm --filter package-name publish --access public
```

## 🎯 Usage Examples

### Database Connection Commands
```bash
# Create tunnel to development database
fiftyten-db tunnel dev

# Connect directly to production database
fiftyten-db connect main

# SSH into bastion host
fiftyten-db ssh dev

# Show connection information
fiftyten-db info dev

# List all available environments
fiftyten-db list
```

### Team Workflow
```bash
# 1. Install once globally with pnpm
pnpm add -g @fiftyten/db-connect

# 2. Connect to dev database (will prompt for MFA if required)
fiftyten-db tunnel dev

# 3. In another terminal, use psql
psql -h localhost -p 5432 -d platform -U fiftyten
```

### MFA Authentication

The CLI tool automatically handles MFA authentication when required:

#### Auto-Discovery (New in v1.2.0!)
```bash
# When MFA is required, the tool auto-discovers your MFA device:
🔐 MFA authentication required
✅ Auto-detected MFA device: arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra
? Enter MFA token code: 123456

✅ MFA authentication successful!
Session expires: 12/31/2023, 2:00:00 PM
```

#### Multiple Devices
```bash
# If you have multiple MFA devices:
🔐 MFA authentication required
Multiple MFA devices found. Please select one:

? Select MFA Device: 
❯ ED_GalaxyS24_Ultra (arn:aws:iam::ACCOUNT:mfa/ED_GalaxyS24_Ultra)
  backup-device (arn:aws:iam::ACCOUNT:mfa/backup-device)
```

#### Manual Entry (Fallback)
```bash
# If auto-discovery fails:
🔐 MFA authentication required
Could not auto-discover MFA devices, using fallback detection
? MFA Device Serial Number: arn:aws:iam::ACCOUNT:mfa/device-name
? Enter MFA token code: 123456
```

**Features:**
- 🔍 **Smart Auto-Discovery** of MFA devices from IAM
- 🎯 **Single Device Auto-Selection** for seamless experience  
- 📋 **Multiple Device Selection** with friendly device names
- 🔒 **Secure Session Token** handling (no role assumption needed)
- ⏰ **Session Management** with automatic expiration
- 🔄 **Automatic Retry** of failed operations after MFA authentication

## 🤝 Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Workflow
1. **Issues First**: Create an issue before starting work
2. **Small PRs**: Keep pull requests focused and small
3. **Tests Required**: All new features must include tests
4. **Documentation**: Update documentation for user-facing changes

## 📊 Available Tools

| Tool | Description | Status | Version |
|------|-------------|--------|---------|
| [db-connect](./packages/db-connect) | Database connection via Session Manager | ✅ Active | 1.0.0 |
| monitoring-cli | Infrastructure monitoring tools | 🚧 Planned | - |
| deployment-helper | Deployment utilities | 🚧 Planned | - |

## 🆘 Support

- **Documentation**: Check individual tool READMEs
- **Issues**: [GitHub Issues](https://github.com/5010-dev/fiftyten-cli-tools/issues)
- **Discussions**: [GitHub Discussions](https://github.com/5010-dev/fiftyten-cli-tools/discussions)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Related Projects

- [5010-indicator](https://github.com/5010-dev/5010-indicator) - Main platform
- [5010-indicator-storage-infra](https://github.com/5010-dev/5010-indicator-storage-infra) - Storage infrastructure
- [indicator-ecs-infra](https://github.com/5010-dev/indicator-ecs-infra) - ECS infrastructure
# Fiftyten CLI Tools

A collection of command-line tools for the Fiftyten platform, designed to improve developer experience and operational efficiency.

## 🚀 Tools Available

### [@fiftyten/db-connect](./packages/db-connect)
Simple CLI tool for connecting to Fiftyten databases via AWS Session Manager.

**Quick Start:**
```bash
# 1. Install prerequisites (one-time setup)
brew install --cask session-manager-plugin
brew install postgresql awscli

# 2. Install globally (pnpm - team standard)
pnpm add -g @fiftyten/db-connect

# 3. One command for complete database access
fiftyten-db psql dev -d platform

# That's it! Automatic tunnel + password + psql connection
```

## 📦 Installation

### Prerequisites

**Required dependencies:**
```bash
# 1. AWS Session Manager plugin (required for tunnel connections)
brew install --cask session-manager-plugin

# 2. PostgreSQL client (for database connections)
brew install postgresql

# 3. AWS CLI (if not already installed)
brew install awscli
```

### Global Installation (Recommended)

#### With pnpm (Team Standard)
```bash
pnpm add -g @fiftyten/db-connect
```

#### With npm
```bash
npm install -g @fiftyten/db-connect
```

### Quick Setup Verification
```bash
# Test that everything is installed correctly
fiftyten-db --version
session-manager-plugin
psql --version
aws --version
```

### One-time Usage (No Installation)

#### With pnpm
```bash
# One-command connection
pnpm dlx @fiftyten/db-connect psql dev -d platform

# Or manual tunnel
pnpm dlx @fiftyten/db-connect tunnel dev -d platform
```

#### With npm
```bash
# One-command connection  
npx @fiftyten/db-connect psql dev -d platform

# Or manual tunnel
npx @fiftyten/db-connect tunnel dev -d platform
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

### One-Command Database Connection (Recommended)
```bash
# Connect to platform database with automatic password
fiftyten-db psql dev -d platform

# Connect to copy trading database  
fiftyten-db psql dev -d copytrading

# Use different port if needed
fiftyten-db psql dev -d platform -p 5433
```

### Database Discovery
```bash
# See what databases are available
fiftyten-db databases dev
```

### Manual Tunnel Commands (Advanced)
```bash
# Create tunnel to platform database
fiftyten-db tunnel dev -d platform

# Connect directly to copytrading database
fiftyten-db connect main -d copytrading

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

# 2. One command for complete database access (recommended)
fiftyten-db psql dev -d platform

# Alternative: Manual tunnel approach
# 2a. Create tunnel (will prompt for MFA if required)
fiftyten-db tunnel dev -d platform
# 2b. In another terminal, use psql
psql -h localhost -p 5433 -d platform -U fiftyten
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

**Key Features:**
- 🚀 **One-Command Connection**: `fiftyten-db psql dev -d platform` - tunnel + password + psql automatically
- 🔍 **Multi-Database Support**: Connect to platform, copytrading, or any configured database
- 🔍 **Database Discovery**: `fiftyten-db databases dev` to see what's available
- 🔐 **Smart MFA Handling**: Auto-discovers MFA devices with single prompt
- 🎯 **Single Device Auto-Selection** for seamless experience  
- 📋 **Multiple Device Selection** with friendly device names when needed
- 🔒 **Secure Session Token** handling (no role assumption needed)
- ⏰ **Session Management** with automatic expiration
- 🔄 **Automatic Password Retrieval** from AWS Secrets Manager
- 🛡️ **Enterprise Security**: Session Manager + MFA + Secrets Manager integration

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
| [db-connect](./packages/db-connect) | Multi-database connection via Session Manager | ✅ Active | 1.8.0 |
| monitoring-cli | Infrastructure monitoring tools | 🚧 Planned | - |
| deployment-helper | Deployment utilities | 🚧 Planned | - |

## 🆘 Support

### Common Issues & Solutions

**"Error starting tunnel: No such file or directory"**
```bash
# Install Session Manager plugin
brew install --cask session-manager-plugin
```

**"psql: command not found"**
```bash
# Install PostgreSQL client
brew install postgresql
```

**"Port 5432 is already in use"**
```bash
# The CLI will automatically suggest solutions, or use a different port
fiftyten-db psql dev -d platform -p 5433
```

**"MFA authentication required"**
- This is normal! The CLI will guide you through MFA setup
- Make sure your AWS credentials are configured: `aws configure`

**"Access denied" errors**
- Check that you have the required IAM permissions (see infrastructure documentation)
- Ensure MFA device is properly configured

### Getting Help

- **Documentation**: Check individual tool READMEs
- **Issues**: [GitHub Issues](https://github.com/5010-dev/fiftyten-cli-tools/issues)
- **Discussions**: [GitHub Discussions](https://github.com/5010-dev/fiftyten-cli-tools/discussions)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Related Projects

- [5010-indicator](https://github.com/5010-dev/5010-indicator) - Main platform
- [5010-indicator-storage-infra](https://github.com/5010-dev/5010-indicator-storage-infra) - Storage infrastructure
- [indicator-ecs-infra](https://github.com/5010-dev/indicator-ecs-infra) - ECS infrastructure
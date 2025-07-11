# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript monorepo containing CLI tools for the Fiftyten platform ecosystem. The tools are designed to streamline database connectivity and operational tasks through AWS Session Manager integration.

### Architecture
- **Monorepo Structure**: pnpm workspaces with packages in `packages/` directory
- **Primary Tool**: `@fiftyten/db-connect` - AWS Session Manager-based database connectivity tool
- **Target Deployment**: Published to npm as scoped packages under `@fiftyten/`
- **AWS Integration**: Heavy use of AWS SDK v3 (EC2, SSM, Secrets Manager, IAM)

### Current Packages
- **db-connect**: Database connection tool with MFA support, automatic password retrieval, and port conflict detection

## Development Commands

### Repository Setup
```bash
# Install dependencies for all packages
pnpm install

# Build all packages
pnpm build

# Run tests across all packages  
pnpm test

# Lint all packages
pnpm lint

# Format all packages
pnpm format

# Clean all build artifacts
pnpm clean
```

### Package-Specific Development
```bash
# Work with specific package
pnpm --filter db-connect build
pnpm --filter db-connect dev         # Watch mode compilation
pnpm --filter db-connect test

# Install dependencies for specific package
pnpm --filter db-connect install <package>
```

### Testing CLI Tools
```bash
# Test db-connect locally after building
node packages/db-connect/bin/fiftyten-db.js --help

# Test with pnpm dlx (without global install)
pnpm dlx @fiftyten/db-connect psql dev -d platform
```

### Publishing
```bash
# Publish all changed packages
pnpm publish-packages

# Publish specific package
pnpm --filter db-connect publish --access public
```

## Code Architecture

### Package Structure
Each tool follows this structure:
- `package.json` - Package configuration with `bin` entries for CLI commands
- `src/index.ts` - Main CLI entry point using Commander.js
- `src/` - Source modules (TypeScript)
- `bin/` - Compiled executable files
- `tsconfig.json` - TypeScript configuration extending root config

### Key Dependencies
- **Commander.js**: CLI framework for argument parsing and command structure
- **AWS SDK v3**: Modular AWS service clients (EC2, SSM, Secrets Manager, IAM)
- **Chalk**: Terminal output coloring
- **Inquirer**: Interactive prompts for MFA and user input

### AWS Integration Patterns
- **Credential Chain**: Supports AWS profiles, IAM roles, environment variables
- **MFA Authentication**: Automatic device discovery with session token management
- **Session Manager**: Port forwarding for secure database connections without SSH keys
- **Secrets Manager**: Automatic password retrieval for database connections
- **Parameter Store**: Configuration storage for environment-specific settings

### Database Connection Flow
1. **Environment Resolution**: Maps environment (dev/main) to AWS infrastructure
2. **MFA Authentication**: Auto-discovers MFA devices, prompts for token
3. **Instance Discovery**: Finds bastion hosts via EC2 tags
4. **Parameter Retrieval**: Gets database configuration from SSM Parameter Store
5. **Secret Retrieval**: Fetches database passwords from Secrets Manager
6. **Tunnel Creation**: Establishes Session Manager port forwarding
7. **Connection**: Launches psql with automatic credentials

### CLI Command Patterns
- Use Commander.js with consistent argument/option patterns
- Environment argument: `<environment>` (dev/main)
- Database option: `-d, --database <app>` (platform, copytrading)
- Port option: `-p, --port <port>` with intelligent defaults
- Region option: `--region <region>` defaulting to us-west-1

## Development Guidelines

### TypeScript Configuration
- Target ES2020 with CommonJS modules
- Strict mode enabled with full type checking
- Source maps and declarations generated for debugging
- JSON module resolution for package.json imports

### Error Handling
- Use chalk for colored error output
- Exit with appropriate codes (0 for success, 1 for errors)
- Provide helpful error messages with suggested solutions
- Handle AWS credential/permission errors gracefully

### CLI Standards
- Include `--version` and `--help` flags
- Use consistent command naming (`fiftyten-` prefix)
- Provide descriptive help text and examples
- Support both short and long option formats

### AWS Best Practices
- Use AWS SDK v3 modular imports to minimize bundle size
- Never hardcode credentials or sensitive information
- Implement proper credential chain support
- Handle MFA requirements transparently
- Use least-privilege IAM permissions

### Code Quality
- Follow existing TypeScript patterns and naming conventions
- Maintain clear separation between CLI interface and core logic
- Use dependency injection for AWS clients to enable testing
- Include comprehensive error messages and user guidance

## Package Development

### Adding New Tools
1. Create new directory under `packages/`
2. Initialize with `package.json` including:
   - Scoped name `@fiftyten/tool-name`
   - Binary entries in `bin` field
   - Proper scripts (build, dev, prepublishOnly)
3. Add TypeScript configuration extending root config
4. Implement CLI using Commander.js pattern
5. Add package reference to root `tsconfig.json`

### Publishing Requirements
- Version bumps required for publishing
- `prepublishOnly` script must build successfully
- Public access configuration for scoped packages
- GitHub repository and bug tracking URLs

### Testing Integration
- Use Node.js native test capabilities or Jest
- Test CLI commands with actual AWS integration (when appropriate)
- Mock AWS services for unit testing core logic
- Include integration tests for critical user workflows
# Platypus — Repository Analysis

> Auto-generated analysis of the Platypus codebase. Last updated: 2026-05-29

## Overview

**Platypus** is an AI-powered agent platform (v1.85.1) built as a Turborepo monorepo. It provides a multi-tenant system for managing AI agents, chats, tools, skills, and MCP (Model Context Protocol) servers within organizations and workspaces.

## Architecture

```
Monorepo
├── apps/frontend       Next.js App
├── apps/backend        Hono.js REST API
├── packages/schemas    Zod Schemas
├── docs/adr/           Architecture Decision Records
└── plans/              Implementation plans
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Monorepo** | Turborepo + pnpm (v10.26.1) |
| **Frontend** | Next.js (App Router) |
| **Backend** | Hono.js (Node.js server) |
| **Database** | PostgreSQL with Drizzle ORM |
| **Vector DB** | pgvector (for memory embeddings) |
| **Auth** | Better Auth v1.6.11 |
| **AI SDK** | AI SDK v6 (ai-sdk) with multiple providers |
| **Testing** | Vitest v4.1.7 |
| **Sandbox** | Dockerode (Docker container isolation) |
| **Logging** | Pino |
| **Validation** | Zod v4 + hono/standard-validator |

## Project Structure

```
platypus/
├── apps/
│   ├── backend/                 # Hono.js REST API
│   │   ├── src/
│   │   │   ├── db/              # Database schema & auth
│   │   │   ├── routes/          # API route handlers
│   │   │   ├── services/        # Business logic services
│   │   │   ├── sandbox/         # Sandbox execution environment
│   │   │   ├── storage/         # File storage (disk, S3)
│   │   │   ├── tools/           # Agent tools implementation
│   │   │   └── jobs/            # Background schedulers
│   │   └── drizzle/             # SQL migration files (26+)
│   └── frontend/                # Next.js web application
├── packages/
│   └── schemas/                 # Shared Zod schemas
├── docs/
│   ├── adr/                     # Architecture Decision Records (4)
│   └── agents/                  # Domain docs, issue tracker, triage
└── plans/                       # Implementation plans (20 features)
```

## Core Domain Model

### Key Entities

- **Organization**: Top-level tenant. Owns workspaces, org-scoped providers, and member roles.
- **Workspace**: Scoped environment inside an Organization. Contains chats, agents, MCPs, skills, and workspace-scoped providers. Owned by exactly one user.
- **Chat**: Persisted conversation in a workspace. Composed of messages and configuration.
- **Chat turn**: Single round of running the model given prior messages and workspace + agent selection.
- **Agent**: Configurable preset that pins a provider, model, system prompt, generation parameters, tools, skills, and sub-agents.
- **Sub-Agent**: Agent referenced by a parent agent and exposed as a delegate tool.
- **Provider**: Configured connection to an AI vendor (OpenAI, Anthropic, Google, Bedrock, etc.). Lives at org or workspace scope.
- **Tool set**: Named bundle of tools an agent can be granted.
- **MCP**: Model Context Protocol server registered in a workspace. Resolves to a tool set at chat-turn time.
- **Skill**: Named capability with a description, attached to an agent.
- **Sandbox**: Isolated execution environment (Docker-backed) providing shell and filesystem tools.
- **Memory**: Persisted summary of prior activity, retrieved per-user per-workspace.
- **Context**: Free-text notes a user attaches at global or per-workspace scope.

### Relationships

- An **Organization** has many **Workspaces** and **Organization Members**.
- A **Workspace** has many **Chats**, **Agents**, **MCPs**, **Skills**, **Triggers**, **Kanban Boards**, **Dashboards**, **Notifications**, and **Webhooks**, and zero-or-one **Sandbox**.
- A **Chat** is produced by a sequence of **Chat turns**.
- An **Agent** references one **Provider**, zero-or-more **Tool sets**, zero-or-more **Skills**, and zero-or-more **Sub-Agents**.
- A **Provider** belongs to either an **Organization** (shared) or a **Workspace** (private).

## Key Features

### 1. Multi-Tenancy
- Organizations with admin/member roles
- Workspaces owned by individual users within organizations
- Invitation-based membership system

### 2. AI Agent System
- **Agents**: Configurable presets pinning Provider, model, system prompt, tools, skills, and sub-agents
- **Providers**: Connections to AI vendors (OpenAI, Anthropic, Google, Bedrock, OpenRouter)
- **Sub-Agents**: Delegate tools exposed to parent agents
- **Skills**: Named capabilities with instructions loaded on demand

### 3. Chat & Conversations
- Persisted conversations with message history
- Chat turns with streaming responses
- Tag-based filtering and pinning
- Memory extraction and processing pipeline

### 4. Sandbox Execution
- Docker-based isolated execution environments
- Pluggable backend architecture
- Shell and filesystem tools for agents
- Teardown failure tracking for resource reconciliation

### 5. Memory System
- Daily summaries of prior activity
- Vector embeddings via pgvector
- Per-user, per-workspace memory retrieval
- Automatic invalidation pipeline

### 6. Triggers & Automation
- Cron-based and event-based triggers
- Trigger runs with status tracking
- Scheduler background jobs

### 7. Kanban Boards
- Boards with columns and cards
- Labels, assignees, due dates, priorities
- Comments on cards
- Agent and user creation tracking

### 8. Dashboards & Widgets
- Desktop/mobile layouts
- Widget types: metric, text, image, weather, line-chart, pie-chart, bar-chart

### 9. Webhooks & Notifications
- Multiple webhooks per workspace with signing secrets
- Event-based delivery
- Notification system with read tracking

### 10. MCP Integration
- Model Context Protocol server registration
- OAuth support for MCP servers
- Tool set resolution at chat-turn time

## API Route Structure

All routes follow a hierarchical pattern:

```
/health
/auth/*                          # Better Auth handlers
/files/*
/organizations/*
/organizations/:orgId/providers  # Org-scoped providers
/organizations/:orgId/invitations
/organizations/:orgId/members
/organizations/:orgId/workspaces/*
/organizations/:orgId/workspaces/:workspaceId/chat
/organizations/:orgId/workspaces/:workspaceId/agents
/organizations/:orgId/workspaces/:workspaceId/providers
/organizations/:orgId/workspaces/:workspaceId/mcps
/organizations/:orgId/workspaces/:workspaceId/sandbox
/organizations/:orgId/workspaces/:workspaceId/skills
/organizations/:orgId/workspaces/:workspaceId/tools
/organizations/:orgId/workspaces/:workspaceId/triggers
/organizations/:orgId/workspaces/:workspaceId/boards
/organizations/:orgId/workspaces/:workspaceId/dashboards
/organizations/:orgId/workspaces/:workspaceId/notifications
/organizations/:orgId/workspaces/:workspaceId/webhooks
/users/me/invitations
/users/me/contexts
/oauth/mcp/callback
```

## Database Schema

The schema uses **Drizzle ORM** with PostgreSQL and includes 20+ tables:

| Table | Purpose |
|-------|---------|
| `user` | Auth users (from Better Auth) |
| `organization` | Multi-tenant orgs with run settings |
| `workspace` | Scoped environments with memory config |
| `provider` | AI vendor connections (org or workspace scoped) |
| `agent` | AI agent configurations |
| `chat` | Persisted conversations |
| `mcp` | MCP server registrations |
| `sandbox` | Docker execution configs |
| `skill` | Agent capabilities |
| `trigger` / `trigger_run` | Automation triggers |
| `memory_daily_summary` | Vector-embedded memory |
| `kanban_board/column/card` | Project management |
| `kanban_card_comment` | Comments on kanban cards |
| `dashboard/widget` | Customizable dashboards |
| `notification` / `notification_read` | Notification system |
| `webhook` | External integrations |
| `invitation` | Membership invitations |
| `organization_member` | Org membership roles |
| `context` | User workspace context |
| `mcp_oauth_state` | OAuth state for MCP servers |
| `sandbox_teardown_failure` | Reconcile leaked sandbox resources |

## Architecture Decision Records

Located in [`docs/adr/`](docs/adr/):

| ADR | Topic |
|-----|-------|
| 0001 | Sandbox as workspace-keyed execution environment |
| 0002 | Sandbox fixed five-tool core |
| 0003 | Docker reference sandbox adapter socket mount |
| 0004 | Sandbox workspace default env vars |

## Implementation Plans

20 feature plans tracked in [`plans/`](plans/):

| # | Plan |
|---|------|
| 00 | Authorization middleware implementation |
| 01 | Better Auth implementation |
| 02 | Invitation feature |
| 03 | Member management |
| 04 | Org-level providers |
| 05 | Route restructuring |
| 06 | Super admin role refactoring |
| 07 | Vitest implementation |
| 08 | Skills feature implementation |
| 09 | Org routing architecture |
| 10 | Org routing refactor |
| 11 | Sub-agents feature |
| 12 | Migrate sub-agents to AI SDK native |
| 12 | Single-user workspaces |
| 13 | Memory feature |
| 14 | Tag-based chat filtering |
| 15 | Cron feature |
| 16 | Storage backend |
| 17 | Kanban board |
| 18 | Kanban labels JSON migration |
| 19 | Agent avatar |
| 20 | Multiple webhooks |

## Testing

- **Framework**: Vitest v4.1.7 with coverage-v8
- **Coverage**: Extensive test files across backend services, tools, storage, sandbox, and utils
- **Pattern**: Co-located `*.test.ts` files alongside implementation files

## Development Commands

```bash
pnpm install
cp apps/frontend/.env.example apps/frontend/.env
cp apps/backend/.env.example apps/backend/.env

pnpm dev              # Start dev servers (Turborepo)
pnpm build            # Build all packages
pnpm test             # Run tests
pnpm format           # Format with Prettier
pnpm drizzle-kit-push # Push schema to DB
pnpm drizzle-kit-generate # Generate migrations
```

## Security & Isolation

- Better Auth for session-based authentication
- Organization/workspace-level access control middleware
- Docker sandboxed tool execution
- Webhook signing secrets
- MCP OAuth flow for external tool servers

## Known Constraints

- **Postgres 18 is not supported** (Drizzle ORM incompatibility)
- **No TypeScript parameter properties** — Node's strip-only TS mode rejects `constructor(private x: T)` shorthand
- Format with Prettier conventions
- Git branches MUST be prefixed `feature/`, `fix/`, or `chore/` only
- Git commits follow Conventional Commits with strict types: `feat`, `fix`, `chore`

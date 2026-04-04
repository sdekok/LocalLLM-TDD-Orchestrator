# MCP Integration for TDD Sub-Agents

This document outlines the plan for giving the TDD Orchestrator's sub-agents (Planner, Implementer, Reviewer) access to all MCP servers registered in Pi, and for integrating context-mode's knowledge base into the workflow.

---

## 1. The Problem

The TDD sub-agents currently make direct HTTP calls to llama.cpp via `LLMClient`. They have no visibility into MCP servers registered on the user's machine (context-mode, searxng, postgres, etc.). This means:

- The Implementer can't search context-mode's indexed knowledge base before writing code
- The Planner can't query external tools (database schemas, API docs) during task breakdown
- Any MCP server the user registers in Pi is invisible to the TDD workflow

### Why Not Pi's AgentSession?

Pi's `ExtensionAPI` has **no `callTool()` method**. Extensions can register tools, listen for tool calls, and block them — but cannot programmatically invoke other extensions' tools. Spawning a Pi `AgentSession` would introduce:

- A full LLM tool-calling loop (loses our single-shot determinism)
- A custom `submit_tdd_implementation` handoff tool (fragile with local models)
- A tool blocklist for write/edit/bash (brittle across Pi versions)
- A hard runtime dependency on the Pi SDK

Instead, we connect to MCP servers **as a client** using `@modelcontextprotocol/sdk` (already a dependency). This keeps the architecture simple, portable, and deterministic.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Pi Extension (src/interfaces/pi/index.ts)                  │
│                                                            │
│  On /tdd:                                                  │
│  1. Read ~/.pi/agent/mcp.json for server configs           │
│  2. Pass configs → MCPClientPool                           │
│  3. Create WorkflowExecutor with pool injected             │
│  4. Forward executor events → ctx_index (keep CM informed) │
└─────────────────────────┬──────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ MCPClientPool (NEW: src/mcp/client-pool.ts)                │
│                                                            │
│  - Reads MCP server configs (from Pi mcp.json or project)  │
│  - Spawns & connects to each server as an MCP CLIENT       │
│  - Discovers tools per server on connect                   │
│  - Provides:                                               │
│    • listTools() → all available tools across servers       │
│    • callTool(server, tool, args) → invoke any MCP tool    │
│    • disconnect() → clean shutdown                         │
│                                                            │
│  Servers connected (from mcp.json):                        │
│  ├─ context-mode  → ctx_search, ctx_execute, ctx_index ... │
│  ├─ searxng        → search                               │
│  └─ (any future servers registered in Pi)                  │
└─────────────────────────┬──────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│ Context Gatherer (ENHANCED: src/context/gatherer.ts)       │
│                                                            │
│  gatherWorkspaceSnapshot(projectDir, task, mcpPool?)       │
│                                                            │
│  Existing sources:                                         │
│  ├─ File tree, package.json, tsconfig                      │
│  ├─ Relevant files via grep                                │
│  ├─ Cached code analysis                                   │
│  └─ SearXNG search (existing SearchClient — kept as-is)    │
│                                                            │
│  NEW MCP sources (when mcpPool provided):                  │
│  ├─ ctx_search → indexed knowledge from context-mode       │
│  ├─ ctx_execute → sandboxed command output                 │
│  └─ Any other MCP tool deemed relevant to the task         │
│                                                            │
│  All results feed into WorkspaceSnapshot as text context   │
│  for the single-shot LLM call. No agent loop needed.       │
└─────────────────────────┬──────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────┐
│  Single-shot LLM → Sandbox → Quality Gates (unchanged)    │
└────────────────────────────────────────────────────────────┘
```

---

## 3. How Context-Mode Fits

Context-mode is both a Pi extension (lifecycle hooks) and an MCP server (tools). Each role is handled differently:

### Role 1: Tool Provider (ctx_search, ctx_execute, ctx_index)

Handled uniformly through MCPClientPool — no special treatment. The orchestrator connects to context-mode's MCP server like any other. `ctx_search` is called during context gathering to pull indexed knowledge into the implementer's prompt.

### Role 2: Session Observer (tracking what happened)

Context-mode's Pi extension hooks (`tool_call`, `tool_result`, `session_before_compact`) only fire for Pi's main agent session. The TDD sub-agents bypass this entirely since they make direct HTTP calls to llama.cpp.

**Solution:** The TDD extension feeds activity back to context-mode via `ctx_index` calls through the pool.

When the orchestrator completes a subtask, the Pi extension calls `ctx_index` to record what happened:

```typescript
executor.events.on('taskCompleted', async (data) => {
  if (mcpPool?.hasServer('context-mode')) {
    await mcpPool.callTool('context-mode', 'ctx_index', {
      content: `## TDD Task Completed: ${data.task.description}\n` +
               `Files modified: ${data.filesChanged.join(', ')}\n` +
               `Tests: ${data.testCount} passing\n` +
               `Branch: ${data.branch}`,
      title: `TDD: ${data.task.description.substring(0, 50)}`
    });
  }
});
```

This keeps context-mode's knowledge base current with TDD workflow activity. When Pi's main session compacts, context-mode can reconstruct what the TDD workflow did because it's indexed.

### What Context-Mode's Middleware Layer Does NOT Cover Here

Context-mode's interception behavior (redirecting `read`/`bash` calls through its sandbox for context window protection) does not apply to sub-agents and doesn't need to:

- Sub-agents don't call Pi tools — they produce JSON output
- The orchestrator manages sub-agent context windows programmatically via `WorkspaceSnapshot` and token budgets
- Session tracking for the TDD workflow is handled by `StateManager`

---

## 4. MCPClientPool Implementation

### Core Class (~200 lines)

```typescript
// src/mcp/client-pool.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface DiscoveredTool {
  server: string;
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPClientPool {
  private clients = new Map<string, Client>();
  private tools = new Map<string, DiscoveredTool[]>();

  /**
   * Load from Pi's mcp.json (used by Pi extension interface).
   */
  static async fromPiConfig(mcpJsonPath: string): Promise<MCPClientPool> {
    const pool = new MCPClientPool();
    const config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));

    for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
      if (name === 'tdd-workflow') continue; // skip ourselves
      try {
        await pool.connect(name, serverConfig as MCPServerConfig);
      } catch (err) {
        logger.warn(`Failed to connect to MCP server "${name}": ${err}`);
      }
    }
    return pool;
  }

  /**
   * Load from a project-level config file (used by headless MCP interface).
   */
  static async fromProjectConfig(projectDir: string): Promise<MCPClientPool> {
    const pool = new MCPClientPool();
    const configPath = path.join(projectDir, '.tdd-workflow', 'mcp.json');
    if (!fs.existsSync(configPath)) return pool;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
      if (name === 'tdd-workflow') continue;
      try {
        await pool.connect(name, serverConfig as MCPServerConfig);
      } catch (err) {
        logger.warn(`Failed to connect to MCP server "${name}": ${err}`);
      }
    }
    return pool;
  }

  async connect(name: string, config: MCPServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env },
    });

    const client = new Client(
      { name: 'tdd-workflow', version: '2.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    this.clients.set(name, client);

    const { tools } = await client.listTools();
    this.tools.set(name, tools.map(t => ({
      server: name,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema,
    })));
  }

  hasServer(name: string): boolean {
    return this.clients.has(name);
  }

  listAllTools(): DiscoveredTool[] {
    return Array.from(this.tools.values()).flat();
  }

  listServerTools(server: string): DiscoveredTool[] {
    return this.tools.get(server) || [];
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<any> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server "${server}" not connected`);
    return client.callTool({ name: tool, arguments: args });
  }

  async disconnect(): Promise<void> {
    for (const [, client] of this.clients) {
      try { await client.close(); } catch { /* best-effort */ }
    }
    this.clients.clear();
    this.tools.clear();
  }
}
```

---

## 5. Integration Points

### Context Gatherer Enhancement

Add an optional `mcpPool` parameter. When present, call relevant MCP tools during context gathering:

```typescript
// In gatherer.ts — new section after existing relevantFiles logic

let mcpContext: string | null = null;
if (mcpPool && taskDescription) {
  const sections: string[] = [];

  // Search context-mode's indexed knowledge
  if (mcpPool.hasServer('context-mode')) {
    try {
      const result = await mcpPool.callTool('context-mode', 'ctx_search', {
        queries: extractKeywords(taskDescription).slice(0, 3),
      });
      if (result.content?.[0]?.text) {
        sections.push(`## Indexed Knowledge\n${result.content[0].text}`);
      }
    } catch { /* context-mode not available */ }
  }

  if (sections.length > 0) {
    mcpContext = sections.join('\n\n');
  }
}
```

### Pi Extension Wiring

```typescript
// In src/interfaces/pi/index.ts
const mcpConfigPath = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
if (fs.existsSync(mcpConfigPath) && !mcpPool) {
  mcpPool = await MCPClientPool.fromPiConfig(mcpConfigPath);
}

// Pass pool to executor
executor = new WorkflowExecutor(stateManager, llmClient, {
  searchClient,
  mcpPool,
});

// Disconnect on shutdown
pi.on('session_shutdown', async () => {
  await mcpPool?.disconnect();
});
```

### MCP Interface Wiring (Headless)

For Cursor/Windsurf, looks for a project-level config file:

```typescript
// In src/interfaces/mcp/index.ts
const mcpPool = await MCPClientPool.fromProjectConfig(projectDir);
// ... pass to executor same as above
```

---

## 6. SearXNG Handling

Keep the existing custom `SearchClient` as-is. It provides `searchAndSummarize()` with HTML stripping and page fetching that the raw MCP tool doesn't. The MCP-registered searxng server is available through the pool for other uses, but the TDD workflow continues using the dedicated client for its specific search patterns.

---

## 7. Connection Lifecycle

The MCPClientPool stays connected for the full duration of the workflow:
- **Connect** when `/tdd` is first invoked (or when the MCP server starts)
- **Stay connected** across all subtask processing
- **Disconnect** on `session_shutdown` (Pi) or server exit (MCP)

This avoids the overhead of spawning MCP server processes per subtask while keeping resource usage bounded to the workflow's lifetime.

---

## 8. Execution Roadmap

- [ ] **Phase 1: Build MCPClientPool**
  - Create `src/mcp/client-pool.ts` with the client pool class
  - Config loading from Pi's `mcp.json` and project-level `.tdd-workflow/mcp.json`
  - Tool discovery and `callTool()` invocation
  - Connection lifecycle management (connect, disconnect)
  - Unit tests with mock MCP servers

- [ ] **Phase 2: Enhance Context Gatherer**
  - Add optional `mcpPool` parameter to `gatherWorkspaceSnapshot()`
  - Add `mcpContext` field to `WorkspaceSnapshot`
  - Wire `ctx_search` calls for context-mode knowledge retrieval
  - Add MCP context section to `formatSnapshotForPrompt()`

- [ ] **Phase 3: Wire Pi Extension**
  - Read `~/.pi/agent/mcp.json` on `/tdd` init
  - Pass `MCPClientPool` to `WorkflowExecutor`
  - Forward `taskCompleted` events to `ctx_index`
  - Clean disconnect on `session_shutdown`

- [ ] **Phase 4: Wire MCP Interface (Headless)**
  - Read project-level `.tdd-workflow/mcp.json`
  - Same pool injection into executor
  - Document config format in USER_GUIDE.md

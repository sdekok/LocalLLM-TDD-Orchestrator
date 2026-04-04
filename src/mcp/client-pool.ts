import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DiscoveredTool {
  server: string;
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPClientPool {
  private clients = new Map<string, Client>();
  private tools = new Map<string, DiscoveredTool[]>();

  /**
   * Load MCP server configs from Pi's mcp.json or a config object.
   */
  static async fromPiConfig(mcpJsonPath: string): Promise<MCPClientPool> {
    const pool = new MCPClientPool();
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    } catch (e) {
      logger.warn(`Could not read Pi MCP config at ${mcpJsonPath}: ${e}`);
      return pool;
    }
    
    for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
      // Skip ourselves (tdd-workflow) to avoid recursion
      if (name === 'tdd-workflow') continue;
      
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

    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      logger.warn(`Could not read project MCP config at ${configPath}: ${e}`);
      return pool;
    }

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
    // If the tool is a node script and "args" points to something like ~ or $HOME we should expand it roughly.
    // We'll let standard env vars to the spawned command.
    
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    for (const [k, v] of Object.entries(config.env || {})) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: mergedEnv,
    });
    
    const client = new Client(
      { name: 'tdd-workflow', version: '2.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    this.clients.set(name, client);
    
    // Discover tools
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

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<any> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server "${server}" not connected`);
    
    const result = await client.callTool({ name: tool, arguments: args });
    return result;
  }

  async disconnect(): Promise<void> {
    for (const [name, client] of this.clients) {
      try { await client.close(); } catch { /* best-effort */ }
    }
    this.clients.clear();
    this.tools.clear();
  }
}

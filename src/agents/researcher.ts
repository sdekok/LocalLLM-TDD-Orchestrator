import { createSubAgentSession } from '../subagent/factory.js';
import { ModelRouter } from '../llm/model-router.js';
import { createResearchTools } from '../subagent/research-tools.js';
import { SearchClient } from '../search/searxng.js';
import { getLogger } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

export const RESEARCHER_PROMPT = `You are a Deep Research Agent. Your goal is to deeply investigate the user's topic by utilizing search and reading tools, and distill your findings into a comprehensive markdown report.

## Context Mode (MANDATORY)

Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations.
**Everything else → \`ctx_execute\` or \`ctx_execute_file\`.**

### Your Tools
1. 'fetch_and_convert_html' to extract readable content from articles and documentation.
2. 'parse_youtube_transcript' to quickly ingest tech talks and video tutorials.
3. Inherited tools from the environment (e.g. search, Puppeteer for heavily dynamic JS sites).

### INSTRUCTIONS
1. Identify the core components of the user's research topic. **If the topic concerns the internal project codebase, always start by checking \`.tdd-workflow/analysis/\` for existing architectural context.**
2. Search the web using the available tools (e.g. 'search' or similar MCP tools if available) to find high-quality resources.
3. Use your reading tools to fetch the content of the most promising 3-5 URLs.
4. Synthesize the findings into a well-structured Markdown document containing:
   - Executive Summary
   - Technical Deep Dive / Viable Options
   - Pros/Cons
   - Citations (link back to your sources)
5. Save the final Markdown report to the specified file path using the available file writing tools.
`;

export interface ResearchOptions {
  background: boolean;
  uiContext: {
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
    setStatus: (id: string, text?: string) => void;
    editor: (label: string, initialText: string) => Promise<string | undefined | null>;
  };
}

export async function performDeepResearch(
  topic: string,
  cwd: string,
  modelRouter: ModelRouter,
  searchClient: SearchClient | null,
  options: ResearchOptions
) {
  const logger = getLogger();
  logger.info(`Starting deep research on: ${topic}`);

  const researchDir = path.join(cwd, 'Research');
  if (!fs.existsSync(researchDir)) {
    fs.mkdirSync(researchDir, { recursive: true });
  }

  // Create tools
  const researchTools = createResearchTools();

  // Also expose SearchClient if search isn't natively available
  if (searchClient) {
    researchTools.push({
      name: 'searxng_search',
      label: 'SearXNG Web Search',
      description: 'Search the web using SearXNG metasearch.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      } as any,
      execute: async (callId: string, args: { query: string }) => {
        try {
          const results = await searchClient.search(args.query);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }], details: {} };
        } catch (e) {
          return { content: [{ type: 'text', text: `Search failed: ${(e as Error).message}` }], details: {} };
        }
      }
    });
  }

  const sessionP = createSubAgentSession({
    taskType: 'project-plan', // We can reuse project-plan routing for dense reasoning, or register 'research' in ModelRouter
    systemPrompt: RESEARCHER_PROMPT,
    cwd,
    modelRouter,
    tools: 'coding', // Need 'coding' so it can use file writing tools to output the final report!
    customTools: researchTools,
  });

  if (options.background) {
    options.uiContext.notify('Deep Research started in the background. You will be notified when complete.', 'info');
    
    sessionP.then(async (session) => {
      try {
        const outFileName = `Research/${topic.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
        await session.prompt(`Topic: ${topic}\nPlease conduct your research and write the final report to ${outFileName}.`);
        options.uiContext.notify(`Deep Research on "${topic}" completed! Saved to ${outFileName}.`, 'info');
      } catch (err) {
        options.uiContext.notify(`Deep Research on "${topic}" failed: ${(err as Error).message}`, 'error');
      } finally {
        session.dispose();
      }
    });
    
    return;
  }

  // Foreground execution
  options.uiContext.setStatus('research', '🔍 Launching Researcher Agent...');
  
  try {
    const session = await sessionP;
    
    // Subscribe to tool events to show progress in TUI!
    session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        const toolName = event.toolName || 'unknown_tool';
        options.uiContext.setStatus('research', `🔍 Using tool: ${toolName}...`);
      }
    });

    const outFileName = `Research/${topic.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
    await session.prompt(`Topic: ${topic}\nPlease conduct your research and write the final report to ${outFileName}.`);
    
    options.uiContext.setStatus('research', undefined);
    options.uiContext.notify(`Deep Research completed! Modeled successfully.`, 'info');
    
    // Try to open the file in the editor
    const absPath = path.join(cwd, outFileName);
    if (fs.existsSync(absPath)) {
      const content = fs.readFileSync(absPath, 'utf-8');
      await options.uiContext.editor(outFileName, content);
    }
    
    session.dispose();
  } catch (err) {
    options.uiContext.setStatus('research', undefined);
    options.uiContext.notify(`Research failed: ${(err as Error).message}`, 'error');
  }
}

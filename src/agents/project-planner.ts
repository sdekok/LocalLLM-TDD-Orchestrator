import { createSubAgentSession } from '../subagent/factory.js';
import { PROJECT_PLANNER_PROMPT } from '../subagent/prompts.js';
import { ModelRouter } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { ProjectPlanSchema, type ProjectPlan } from './project-plan-schema.js';
import { generatePlanMarkdown } from './components/markdown-generator.js';
import { extractPlanFromResponse } from './components/response-extractor.js';
export { generatePlanMarkdown };
export { extractPlanFromResponse } from './components/response-extractor.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectPlanResult {
  summary: string;
  plan?: ProjectPlan;
}

/**
 * Spawns a project planning sub-agent session.
 * This sub-agent is responsible for:
 * 1. Exploring the codebase.
 * 2. Decomposing a request into epics and work items.
 * 3. Returning a structured JSON plan.
 * 
 * The orchestrator (not the agent) is responsible for writing files to WorkItems/.
 */
export async function planProject(
  request: string,
  modelRouter: ModelRouter,
  cwd: string,
  uiContext?: {
    input: (prompt: string) => Promise<string | null>;
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
    editor: (label: string, initialText: string) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  }
): Promise<ProjectPlanResult> {
  const logger = getLogger();
  logger.info(`Starting project-level planning for: ${request.substring(0, 100)}`);

  // Log the model selection for project-plan task
  const modelProfile = modelRouter.selectModel('project-plan');
  logger.info(`Selected model for project-plan: ${modelProfile.modelId || modelProfile.ggufFilename}`);
  logger.info(`Model provider: ${modelProfile.provider}`);
  logger.info(`Model enableThinking: ${modelProfile.enableThinking}`);

  const session = await createSubAgentSession({
    taskType: 'project-plan',
    systemPrompt: PROJECT_PLANNER_PROMPT,
    cwd,
    modelRouter,
    tools: 'coding', // Agent can still read files, but won't write the plan files
    uiContext: uiContext ? {
      input: uiContext.input,
      notify: uiContext.notify,
    } : undefined,
  });
  
  logger.info(`Sub-agent session created, starting to send prompt...`);
  logger.info(`Prompt length: ${request.length} characters`);
  logger.info(`Sending prompt to agent: ${request.substring(0, 200)}...`);

  try {
    // Send the initial prompt
    logger.info(`Calling session.prompt() - waiting for model response...`);
    logger.info(`Prompt being sent: ${request.substring(0, 300)}...`);
    const promptStart = Date.now();
    await session.prompt(request);
    const promptDuration = Date.now() - promptStart;
    logger.info(`session.prompt() completed in ${promptDuration}ms`);
    
    // Get the last assistant message and extract JSON
    const messages = session.messages;
    logger.info(`Total messages in session: ${messages.length}`);
    messages.forEach((msg, idx) => {
      logger.info(`Message ${idx}: role=${msg.role}, constructor=${msg.constructor?.name}`);
      const hasContent = 'content' in msg;
      if (hasContent) {
        const content = (msg as any).content;
        logger.info(`  Content is ${Array.isArray(content) ? 'array' : 'string'} with ${Array.isArray(content) ? content.length : 0} items`);
        if (Array.isArray(content) && content.length > 0) {
          logger.info(`  Content types: ${content.map((c: any) => c.type).join(', ')}`);
        }
      }
    });
    
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    logger.info(`Assistant messages found: ${assistantMessages.length}`);
    
    const lastAssistantMessage = assistantMessages.pop();

    if (!lastAssistantMessage) {
      throw new Error('Agent did not produce any response.');
    }
    
    // Log message details
    logger.info(`Last assistant message found`);
    const lastMsgContent = (lastAssistantMessage as any).content;
    logger.info(`Message content type: ${Array.isArray(lastMsgContent) ? 'array' : typeof lastMsgContent}`);
    logger.info(`Message content length: ${Array.isArray(lastMsgContent) ? lastMsgContent.length : 'N/A'}`);
    if (Array.isArray(lastMsgContent)) {
      logger.info(`Content block types: ${lastMsgContent.map((c: any) => c.type).join(', ')}`);
      lastMsgContent.forEach((c: any, i: number) => {
        logger.info(`  Block ${i}: type=${c.type}, text=${c.text ? c.text.substring(0, 100) : 'N/A'}, thinking=${c.thinking ? c.thinking.substring(0, 100) : 'N/A'}`);
      });
    }

    // Extract text content from the message. Thinking blocks are a fallback for
    // reasoning models that don't emit a separate text block in passthrough mode.
    const extractText = (msg: any): string => {
      if (typeof msg.content === 'string') return msg.content;
      if (!Array.isArray(msg.content)) return '';
      const textBlocks = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text as string);
      if (textBlocks.length > 0) return textBlocks.join('\n');
      // Fallback: try thinking blocks
      return msg.content.filter((c: any) => c.type === 'thinking').map((c: any) => c.thinking as string).join('\n');
    };

    let assistantText = extractText(lastAssistantMessage);

    // Comprehensive logging
    logger.info(`--- PLANNER EXTRACTION DETAILS ---`);
    logger.info(`Assistant text extracted: ${assistantText.length} characters`);
    logger.info(`Assistant text preview (first 200 chars): ${assistantText.substring(0, 200)}`);
    logger.info(`All message types in session: ${messages.map((m: any) => m.role).join(', ')}`);
    logger.info(`--- END PLANNER DETAILS ---`);
    logger.debug(`[DEBUG] Planner session completed. Total messages: ${messages.length}`);
    logger.debug(`[DEBUG] Last assistant response length: ${assistantText.length}`);
    logger.debug(`[DEBUG] Last assistant raw message content: ${JSON.stringify(lastAssistantMessage.content, null, 2)}`);

    // Parse and validate the JSON. If the model didn't return JSON (common with passthrough
    // mode chat models), send a follow-up prompt that explicitly requests structured output.
    let plan: ProjectPlan;
    try {
      plan = extractPlanFromResponse(assistantText);
    } catch {
      logger.info(`[PLANNER] No JSON in initial response — sending follow-up prompt for structured output.`);
      const schemaHint = `{"reasoning":"string","summary":"string","epics":[{"title":"string","slug":"string","description":"string","workItems":[{"id":"string","title":"string","description":"string","acceptance":["string"],"tests":["string"]}]}],"architecturalDecisions":["string"]}`;
      await session.prompt(
        `Your previous response did not contain a valid JSON plan.\n\n` +
        `Please respond with ONLY a JSON object — no prose, no markdown fences — that matches this shape:\n${schemaHint}\n\n` +
        `Use the exploration you already did. Output the JSON now.`
      );

      const retryMessages = session.messages.filter((m: any) => m.role === 'assistant');
      const retryMessage = retryMessages[retryMessages.length - 1];
      if (!retryMessage) {
        throw new Error('Agent did not produce a response on retry.');
      }
      assistantText = extractText(retryMessage);
      logger.info(`[PLANNER] Retry response length: ${assistantText.length} characters`);
      logger.info(`[PLANNER] Retry response preview: ${assistantText.substring(0, 200)}`);

      try {
        plan = extractPlanFromResponse(assistantText);
      } catch (retryErr) {
        const e = retryErr as Error;
        logger.debug(`[DEBUG] Failed to parse plan JSON after retry: ${e.message}`);
        throw new Error(`Invalid plan format after retry: ${e.message}. Raw output:\n${assistantText.substring(0, 500)}`);
      }
    }

    // If UI context is provided, show the plan for review
    if (uiContext) {
      const planMarkdown = generatePlanMarkdown(plan);
      const edited = await uiContext.editor('Review Plan:', planMarkdown);
      if (edited === null) {
        return { summary: 'Plan review cancelled by user.' };
      }
      // TODO: Parse edited markdown back to JSON if needed
      
      // Confirm before writing files
      const confirmed = await uiContext.confirm(`Create WorkItems/ directory with ${plan.epics.length} epics?`);
      if (!confirmed) {
        return { summary: 'Plan approved but file writing cancelled.' };
      }

      // Write the plan files
      await writePlanFiles(plan, cwd);
      
      // Append architectural decisions to agents.md
      if (plan.architecturalDecisions.length > 0) {
        await appendArchitecturalDecisions(plan.architecturalDecisions, cwd);
      }
    } else {
      // No UI context - just write the files directly
      await writePlanFiles(plan, cwd);
      
      // Append architectural decisions to agents.md
      if (plan.architecturalDecisions.length > 0) {
        await appendArchitecturalDecisions(plan.architecturalDecisions, cwd);
      }
    }

    return {
      summary: `Project planning complete. Created ${plan.epics.length} epics in WorkItems/.`,
      plan,
    };
  } finally {
    session.dispose();
  }
}

/**
 * Writes the plan to the WorkItems/ directory.
 */
export async function writePlanFiles(plan: ProjectPlan, cwd: string): Promise<void> {
  const workItemsDir = path.join(cwd, 'WorkItems');
  
  // Create directory
  if (!fs.existsSync(workItemsDir)) {
    fs.mkdirSync(workItemsDir, { recursive: true });
  }

  // Find existing epic files to determine max index and existing slugs
  const existingFiles = fs.readdirSync(workItemsDir);
  const epicFiles = existingFiles.filter(f => f.startsWith('epic-') && f.endsWith('.md'));
  
  let maxIndex = 0;
  const slugToFile = new Map<string, string>();
  
  epicFiles.forEach(f => {
    const match = f.match(/^epic-(\d+)-(.+)\.md$/);
    if (match) {
      const idx = parseInt(match[1]!, 10);
      maxIndex = Math.max(maxIndex, idx);
      slugToFile.set(match[2]!, f);
    }
  });

  // Write overview
  const overviewPath = path.join(workItemsDir, '_overview.md');
  const overview = `# Project Overview\n\n${plan.summary}\n\n## Architectural Decisions\n\n` +
    plan.architecturalDecisions.map(d => `- ${d}`).join('\n');
  fs.writeFileSync(overviewPath, overview);

  // Write each epic
  for (let i = 0; i < plan.epics.length; i++) {
    const epic = plan.epics[i]!;
    
    // Reuse existing filename if slug matches, otherwise generate new index
    const existingFile = slugToFile.get(epic.slug);
    let filename: string;
    
    if (existingFile) {
      filename = existingFile;
    } else {
      maxIndex++;
      filename = `epic-${String(maxIndex).padStart(2, '0')}-${epic.slug}.md`;
    }
    
    const epicPath = path.join(workItemsDir, filename);
    
    let epicMd = `# Epic: ${epic.title}\n\n## Summary\n${epic.description}\n\n`;
    
    if (epic.securityStrategy) {
      epicMd += `## Security Strategy\n${epic.securityStrategy}\n\n`;
    }
    
    if (epic.testStrategy) {
      epicMd += `## Testing Strategy\n${epic.testStrategy}\n\n`;
    }
    
    epicMd += `## Work Items\n\n`;
    
    epic.workItems.forEach(wi => {
      epicMd += `### ${wi.id}: ${wi.title}\n\n`;
      epicMd += `**Description**: ${wi.description}\n\n`;
      epicMd += `**Acceptance Criteria**:\n`;
      wi.acceptance.forEach(a => {
        epicMd += `- ${a}\n`;
      });
      epicMd += `\n`;
      
      if (wi.security) {
        epicMd += `**Security Considerations**: ${wi.security}\n\n`;
      }
      
      if (wi.tests && wi.tests.length > 0) {
        epicMd += `**Recommended Tests**:\n`;
        wi.tests.forEach(t => {
          epicMd += `- ${t}\n`;
        });
        epicMd += `\n`;
      }
      
      if (wi.devNotes) {
        epicMd += `**Developer Notes**: ${wi.devNotes}\n\n`;
      }
      
      epicMd += `---\n\n`;
    });
    
    fs.writeFileSync(epicPath, epicMd);
  }
}

/**
 * Appends architectural decisions to agents.md.
 */
export async function appendArchitecturalDecisions(
  decisions: string[],
  cwd: string,
  agentsMdPath: string = 'agents.md'
): Promise<void> {
  const fullPath = path.join(cwd, agentsMdPath);
  
  let content = '';
  if (fs.existsSync(fullPath)) {
    content = fs.readFileSync(fullPath, 'utf-8');
  } else {
    content = '# Agents File\n';
  }

  const sectionHeader = '## Architectural Decisions (Auto-generated)';
  
  // Check if section already exists
  if (content.includes(sectionHeader)) {
    // Append decisions to the existing section
    const newDecisions = decisions.map(d => `- ${d}`).join('\n');
    // Find the section and append to it
    const sectionRegex = new RegExp(`(${sectionHeader}\\n.*?)(?=\n##|$)`, 's');
    if (sectionRegex.test(content)) {
      content = content.replace(sectionRegex, `$1\n${newDecisions}`);
    } else {
      // Fallback: just append at end
      content += `\n${newDecisions}`;
    }
  } else {
    // Add new section
    const newSection = `\n${sectionHeader}\n\n${decisions.map(d => `- ${d}`).join('\n')}`;
    content += newSection;
  }

  fs.writeFileSync(fullPath, content);
}



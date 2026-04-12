import { createSubAgentSession } from '../subagent/factory.js';
import { PROJECT_PLANNER_PROMPT } from '../subagent/prompts.js';
import { ModelRouter } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { ProjectPlanSchema, type ProjectPlan } from './project-plan-schema.js';
import { generatePlanMarkdown } from './components/markdown-generator.js';
import { extractPlanFromResponse, TruncatedJsonError } from './components/response-extractor.js';
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
    /** Post a message into the Pi chat history for live progress visibility. */
    chatMessage?: (content: string) => void;
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
  
  // Stream reasoning, tool calls, and text back into Pi chat
  if (uiContext?.chatMessage) {
    const chatMessage = uiContext.chatMessage;
    session.subscribe((event) => {
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae.type === 'thinking_end' && ae.content) {
          const preview = ae.content.length > 400
            ? ae.content.substring(0, 400) + '…'
            : ae.content;
          chatMessage(`💭 ${preview}`);
        } else if (ae.type === 'text_end' && ae.content?.trim()) {
          chatMessage(ae.content);
        }
      } else if (event.type === 'tool_execution_start') {
        // Extract a short human-readable arg summary (first string value in args)
        const firstArg = event.args && typeof event.args === 'object'
          ? Object.values(event.args as Record<string, unknown>).find(v => typeof v === 'string') as string | undefined
          : undefined;
        const argHint = firstArg ? `: ${firstArg.length > 60 ? firstArg.substring(0, 60) + '…' : firstArg}` : '';
        chatMessage(`🔧 \`${event.toolName}\`${argHint}`);
      }
    });
  }

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
    


    /**
     * Extract all text from a message, combining text blocks and thinking blocks.
     * Only falls back to thinking if text blocks are absent or all empty — avoids
     * returning an empty string when the model emits a blank text block followed
     * by a thinking block that contains the actual JSON.
     */
    const extractText = (msg: any): string => {
      if (typeof msg.content === 'string') return msg.content;
      if (!Array.isArray(msg.content)) return '';
      return msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text as string)
        .join('\n')
        .trim();
    };

    /**
     * Scan all assistant messages (newest first) for a valid plan.
     * The JSON may appear in any turn — e.g. the model reasoned in a thinking
     * block and then produced JSON in a prior text block.
     */
    const findPlanInMessages = (msgs: any[]): ProjectPlan | null => {
      const assistantMsgs = [...msgs].filter(m => m.role === 'assistant').reverse();
      for (const msg of assistantMsgs) {
        const text = extractText(msg);
        if (!text) continue;
        try {
          return extractPlanFromResponse(text);
        } catch {
          // not this message
        }
      }
      return null;
    };

    const lastMsgContent = (lastAssistantMessage as any).content;
    logger.info(`Last assistant message content types: ${Array.isArray(lastMsgContent) ? lastMsgContent.map((c: any) => c.type).join(', ') : typeof lastMsgContent}`);
    let assistantText = extractText(lastAssistantMessage);
    logger.info(`[PLANNER] Extracted text length: ${assistantText.length} chars`);

    /** Dump full session messages to a timestamped file for debugging. */
    const dumpSessionMessages = (label: string) => {
      try {
        const dumpDir = path.join(cwd, '.tdd-workflow', 'logs');
        fs.mkdirSync(dumpDir, { recursive: true });
        const dumpFile = path.join(dumpDir, `planner-session-${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify({ label, messages: session.messages }, null, 2), 'utf-8');
        logger.info(`[PLANNER] Session dump written to ${dumpFile}`);
      } catch (e) {
        logger.warn(`[PLANNER] Failed to write session dump: ${(e as Error).message}`);
      }
    };

    // Parse and validate the JSON. If the model didn't return JSON (common with passthrough
    // mode chat models), send a follow-up prompt that explicitly requests structured output.
    let plan: ProjectPlan;

    // First: scan all messages — the plan might be in an earlier turn or a thinking block
    const foundPlan = findPlanInMessages(messages);
    if (foundPlan) {
      plan = foundPlan;
    } else {
      dumpSessionMessages('no-json-in-initial-response');
      logger.info(`[PLANNER] No JSON found in any message — sending follow-up prompt.`);
      const schemaHint = `{"summary":"string","epics":[{"title":"string","slug":"string","description":"string","workItems":[{"id":"string","title":"string","description":"string","acceptance":["string"],"tests":["string"]}]}],"architecturalDecisions":["string"]}`;
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

      // Scan all messages again — retry turn may have put JSON in a thinking block
      const retryPlan = findPlanInMessages(session.messages);
      if (retryPlan) {
        plan = retryPlan;
      } else {
        dumpSessionMessages('no-json-after-retry');
        let lastErr: Error = new Error('No JSON found');
        try { extractPlanFromResponse(assistantText); } catch (e) { lastErr = e as Error; }
        if (lastErr instanceof TruncatedJsonError) {
          throw new Error(
            `Model output was truncated — the plan JSON was cut off mid-stream. ` +
            `This usually means maxOutputTokens is too low for the size of plan requested. ` +
            `Check models.config.json or ask for a smaller plan.`
          );
        }
        throw new Error(`Invalid plan format after retry: ${lastErr.message}. Raw output:\n${assistantText.substring(0, 500)}`);
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



import { createSubAgentSession } from '../subagent/factory.js';
import { PROJECT_PLANNER_PROMPT } from '../subagent/prompts.js';
import { ModelRouter } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { type ProjectPlan, type EpicOverview, type Epic } from './project-plan-schema.js';
import { generatePlanMarkdown, formatWorkItemMarkdown } from './components/markdown-generator.js';
import { extractPlanFromResponse, extractEpicOverview, extractSingleEpic } from './components/response-extractor.js';
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

  try {
    // ── Shared helpers ────────────────────────────────────────────────────────

    const extractText = (msg: any): string => {
      if (typeof msg.content === 'string') return msg.content;
      if (!Array.isArray(msg.content)) return '';
      return msg.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text as string)
        .join('\n')
        .trim();
    };

    const dumpSessionMessages = (label: string) => {
      try {
        const dumpDir = path.join(cwd, '.tdd-workflow', 'logs');
        fs.mkdirSync(dumpDir, { recursive: true });
        const dumpFile = path.join(dumpDir, `planner-session-${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify({ label, messages: session.messages }, null, 2), 'utf-8');
        logger.info(`[PLANNER] Session dump (${label}): ${dumpFile}`);
      } catch (e) {
        logger.warn(`[PLANNER] Failed to write session dump: ${(e as Error).message}`);
      }
      const assistantMsgs = (session.messages as any[]).filter(m => m.role === 'assistant');
      assistantMsgs.forEach((msg, msgIdx) => {
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        blocks.forEach((block, blockIdx) => {
          if (block.type === 'thinking') {
            logger.info(`[PLANNER] msg[${msgIdx}] thinking[${blockIdx}]: ${String(block.thinking ?? '').substring(0, 500)}`);
          } else if (block.type === 'text') {
            logger.info(`[PLANNER] msg[${msgIdx}] text[${blockIdx}]: ${String(block.text ?? '').substring(0, 500)}`);
          } else {
            logger.info(`[PLANNER] msg[${msgIdx}] ${block.type}[${blockIdx}]`);
          }
        });
      });
    };

    /** Scan all assistant messages newest-first for a valid T. */
    const findInMessages = <T>(msgs: any[], extractor: (text: string) => T): T | null => {
      const assistantMsgs = [...msgs].filter(m => m.role === 'assistant').reverse();
      for (const msg of assistantMsgs) {
        const text = extractText(msg);
        if (!text) continue;
        try { return extractor(text); } catch { /* not this message */ }
      }
      return null;
    };

    /** Send a prompt, scan for T, retry once with schema hint if missing. */
    const promptAndFind = async <T>(
      promptText: string,
      extractor: (text: string) => T,
      schemaHint: string,
      dumpLabel: string,
    ): Promise<T> => {
      const start = Date.now();
      await session.prompt(promptText);
      logger.info(`[PLANNER] ${dumpLabel} completed in ${Date.now() - start}ms`);
      dumpSessionMessages(dumpLabel);

      let result = findInMessages(session.messages, extractor);
      if (!result) {
        logger.info(`[PLANNER] No JSON found after ${dumpLabel} — retrying.`);
        await session.prompt(
          `Your response did not contain valid JSON. ` +
          `Reply with ONLY a JSON object matching this shape:\n${schemaHint}`
        );
        dumpSessionMessages(`${dumpLabel}-retry`);
        result = findInMessages(session.messages, extractor);
        if (!result) {
          throw new Error(`No valid JSON found after retry for: ${dumpLabel}`);
        }
      }
      return result;
    };

    // ── Phase 1: Epic overview ────────────────────────────────────────────────

    const OVERVIEW_HINT = `{"summary":"...","architecturalDecisions":["..."],"epics":[{"title":"...","slug":"...","description":"..."}]}`;

    const overview: EpicOverview = await promptAndFind(
      `${request}\n\nReturn the epic overview JSON now. No work items yet — just the epic list.`,
      extractEpicOverview,
      OVERVIEW_HINT,
      'phase1-overview',
    );

    logger.info(`[PLANNER] Overview: ${overview.epics.length} epics`);
    uiContext?.chatMessage?.(`📋 Overview ready: ${overview.epics.length} epics planned.`);

    // Optional UI confirm after overview
    if (uiContext) {
      const epicList = overview.epics.map((e, i) => `${i + 1}. ${e.title}`).join('\n');
      const confirmed = await uiContext.confirm(
        `Plan has ${overview.epics.length} epics:\n${epicList}\n\nProceed to generate work items?`
      );
      if (!confirmed) return { summary: 'Planning cancelled by user.' };
    }

    // Write overview file immediately
    const workItemsDir = path.join(cwd, 'WorkItems');
    if (!fs.existsSync(workItemsDir)) fs.mkdirSync(workItemsDir, { recursive: true });

    fs.writeFileSync(
      path.join(workItemsDir, '_overview.md'),
      `# Project Overview\n\n${overview.summary}\n\n## Architectural Decisions\n\n` +
      overview.architecturalDecisions.map(d => `- ${d}`).join('\n')
    );

    if (overview.architecturalDecisions.length > 0) {
      await appendArchitecturalDecisions(overview.architecturalDecisions, cwd);
    }

    // ── Phase 2: Work items per epic (fresh session each) ────────────────────
    // Each epic gets its own session to prevent context buildup from prior epics
    // causing truncated JSON responses and wrong-file extraction fallbacks.

    const EPIC_HINT = `{"title":"...","slug":"...","description":"...","workItems":[{"id":"WI-N","title":"...","description":"one sentence","acceptance":["..."],"tests":["Unit: ..."]}]}`;

    const completedEpics: Epic[] = [];

    // Shared context prefix injected at the start of every per-epic session
    const overviewContext =
      `Project overview: ${overview.summary}\n\n` +
      `All planned epics:\n${overview.epics.map((e, idx) => `${idx + 1}. ${e.title} (slug: ${e.slug}) — ${e.description}`).join('\n')}\n\n` +
      `Architectural decisions:\n${overview.architecturalDecisions.map(d => `- ${d}`).join('\n')}`;

    session.dispose(); // Done with Phase 1 session

    for (let i = 0; i < overview.epics.length; i++) {
      const epicStub = overview.epics[i]!;
      const epicNum = String(i + 1).padStart(2, '0');
      logger.info(`[PLANNER] Fetching work items for epic ${epicNum}: ${epicStub.title}`);
      uiContext?.chatMessage?.(`⏳ Epic ${i + 1}/${overview.epics.length}: ${epicStub.title}`);

      // Fresh session for each epic — clean context, no cross-contamination
      const epicSession = await createSubAgentSession({
        taskType: 'project-plan',
        systemPrompt: PROJECT_PLANNER_PROMPT,
        cwd,
        modelRouter,
        tools: 'coding',
        uiContext: uiContext ? { input: uiContext.input, notify: uiContext.notify } : undefined,
      });

      if (uiContext?.chatMessage) {
        const chatMessage = uiContext.chatMessage;
        epicSession.subscribe((event) => {
          if (event.type === 'tool_execution_start') {
            const firstArg = event.args && typeof event.args === 'object'
              ? Object.values(event.args as Record<string, unknown>).find(v => typeof v === 'string') as string | undefined
              : undefined;
            const argHint = firstArg ? `: ${firstArg.length > 60 ? firstArg.substring(0, 60) + '…' : firstArg}` : '';
            chatMessage(`🔧 \`${event.toolName}\`${argHint}`);
          }
        });
      }

      const epicExtractText = (msg: any): string => {
        if (typeof msg.content === 'string') return msg.content;
        if (!Array.isArray(msg.content)) return '';
        return msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text as string).join('\n').trim();
      };

      const findInEpicMessages = <T>(msgs: any[], extractor: (text: string) => T): T | null => {
        const assistantMsgs = [...msgs].filter(m => m.role === 'assistant').reverse();
        for (const msg of assistantMsgs) {
          const text = epicExtractText(msg);
          if (!text) continue;
          try { return extractor(text); } catch { /* not this message */ }
        }
        return null;
      };

      let epic: Epic;
      try {
        const prompt =
          `${overviewContext}\n\n` +
          `Now return the work items JSON for epic ${i + 1}: "${epicStub.title}" (slug: "${epicStub.slug}").\n` +
          `THIS EPIC ONLY. Return ALL work item fields. No prose, no code fences — pure JSON object.`;

        await epicSession.prompt(prompt);
        dumpSessionMessages(`phase2-epic-${epicStub.slug}`);

        let result = findInEpicMessages(epicSession.messages, extractSingleEpic);
        if (!result) {
          logger.info(`[PLANNER] No JSON found for epic ${epicStub.slug} — retrying.`);
          await epicSession.prompt(
            `Your response did not contain valid JSON. Reply with ONLY a JSON object matching this shape:\n${EPIC_HINT}`
          );
          dumpSessionMessages(`phase2-epic-${epicStub.slug}-retry`);
          result = findInEpicMessages(epicSession.messages, extractSingleEpic);
          if (!result) throw new Error(`No valid JSON found for epic: ${epicStub.slug}`);
        }
        epic = result;
      } finally {
        epicSession.dispose();
      }

      // Write epic file immediately
      const filename = `epic-${epicNum}-${epic.slug}.md`;
      let epicMd = `# Epic: ${epic.title}\n\n## Summary\n${epic.description}\n\n`;
      if (epic.securityStrategy) epicMd += `## Security Strategy\n${epic.securityStrategy}\n\n`;
      if (epic.testStrategy) epicMd += `## Testing Strategy\n${epic.testStrategy}\n\n`;
      epicMd += `## Work Items\n\n`;
      epic.workItems.forEach(wi => { epicMd += formatWorkItemMarkdown(wi).join('\n'); });
      fs.writeFileSync(path.join(workItemsDir, filename), epicMd);

      completedEpics.push(epic);
      logger.info(`[PLANNER] Epic ${epicNum} written: ${filename} (${epic.workItems.length} work items)`);
      uiContext?.chatMessage?.(`✅ Epic ${i + 1}: ${epic.title} — ${epic.workItems.length} work items`);
    }

    // Assemble full plan for callers that need it
    const plan: ProjectPlan = {
      summary: overview.summary,
      architecturalDecisions: overview.architecturalDecisions,
      epics: completedEpics,
    };

    return {
      summary: `Project planning complete. Created ${completedEpics.length} epics in WorkItems/.`,
      plan,
    };
  } finally {
    // Phase 1 session already disposed above; this is a no-op safety net
    try { session.dispose(); } catch { /* already disposed */ }
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
      epicMd += formatWorkItemMarkdown(wi).join('\n');
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



import { ProjectPlanSchema, type ProjectPlan } from '../project-plan-schema.js';
import { InvalidJsonError, SchemaValidationError, NoResponseError } from '../errors/planner-errors.js';

/**
 * Scans text character-by-character to extract the outermost valid JSON object.
 * Skips invalid candidates and returns the first one that parses successfully.
 * Returns null if no valid JSON object is found.
 */
export function extractOutermostJSON(text: string): string | null {
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Not valid JSON, reset and keep scanning
          start = -1;
        }
      }
    }
  }

  return null;
}

/**
 * Extracts and validates a ProjectPlan from an agent's text response.
 */
export function extractPlanFromResponse(text: string): ProjectPlan {
  // Extract JSON from markdown blocks if available
  const blockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  let parsed: any = null;
  let lastParserError: Error | null = null;

  while ((match = blockRegex.exec(text)) !== null) {
    try {
      parsed = JSON.parse(match[1]!);
      break; // Found valid JSON block
    } catch (err) {
      lastParserError = err as Error;
    }
  }

  // Fallback: use bracket-balanced JSON extraction
  if (!parsed) {
    const jsonStr = extractOutermostJSON(text);
    if (jsonStr) {
      try {
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        lastParserError = err as Error;
      }
    }
  }

  if (!parsed) {
    throw new InvalidJsonError(
      lastParserError ? `Invalid JSON: ${lastParserError.message}` : 'No JSON object found in agent response.',
      text
    );
  }
  
  try {
    return ProjectPlanSchema.parse(parsed);
  } catch (err) {
    const zodError = err as any;
    throw new SchemaValidationError(
      `Invalid plan format: ${zodError.message}`,
      zodError.errors || []
    );
  }
}

/**
 * Gets the last assistant message from a session.
 */
export function getLastAssistantMessage(
  messages: any[]
): any {
  const assistantMessages = messages.filter((m: any) => m.role === 'assistant');
  
  if (assistantMessages.length === 0) {
    throw new NoResponseError();
  }
  
  return assistantMessages[assistantMessages.length - 1]!;
}

/**
 * Extracts text content from an assistant message.
 * Handles both string and array content formats.
 */
export function extractMessageText(message: any): string {
  const content = message.content;
  
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => (c as any).text)
      .join('\n');
  }
  
  return '';
}

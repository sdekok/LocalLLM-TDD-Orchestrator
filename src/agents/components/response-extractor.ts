import { ProjectPlanSchema, type ProjectPlan } from '../project-plan-schema.js';
import { InvalidJsonError, SchemaValidationError, NoResponseError } from '../errors/planner-errors.js';

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

  // Fallback: try to find the last large balanced JSON-like string if no blocks worked
  if (!parsed) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (err) {
        lastParserError = err as Error;
      }
    }
  }

  // Final fallback: try extracting the first object (non-greedy, but naive)
  if (!parsed) {
     const firstMatch = text.match(/\{[\s\S]*?\}/);
     if (firstMatch) {
       try { parsed = JSON.parse(firstMatch[0]); } catch(e) {}
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

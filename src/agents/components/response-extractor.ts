import { ProjectPlanSchema, EpicOverviewSchema, EpicSchema, type ProjectPlan, type EpicOverview, type Epic } from '../project-plan-schema.js';
import { InvalidJsonError, SchemaValidationError, NoResponseError } from '../errors/planner-errors.js';

/**
 * Normalizes typographic/curly quotes that models sometimes emit to their
 * ASCII equivalents so JSON.parse() doesn't choke on them.
 *
 * Handles:
 *  \u201C " → "   (LEFT DOUBLE QUOTATION MARK)
 *  \u201D " → "   (RIGHT DOUBLE QUOTATION MARK)
 *  \u2018 ' → '   (LEFT SINGLE QUOTATION MARK used as string delimiter)
 *  \u2019 ' → '   (RIGHT SINGLE QUOTATION MARK used as string delimiter)
 */
export function normalizeJsonQuotes(s: string): string {
  return s
    .replace(/\u201C/g, '"')
    .replace(/\u201D/g, '"')
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'");
}

/**
 * Scans text character-by-character to extract the outermost valid JSON object.
 * Skips invalid candidates and returns the first one that parses successfully.
 * Returns null if no valid JSON object is found.
 *
 * If the text contains an unterminated outermost JSON object (i.e. the model
 * output was truncated), throws a descriptive TruncatedJsonError so callers
 * can surface it clearly rather than silently matching an inner object.
 */
export class TruncatedJsonError extends Error {
  constructor(public readonly partial: string) {
    super(`Model output appears to have been truncated (JSON object opened but never closed). First 200 chars: ${partial.substring(0, 200)}`);
    this.name = 'TruncatedJsonError';
  }
}

export function extractOutermostJSON(text: string): string | null {
  // Normalize curly/smart quotes up-front so the internal JSON.parse
  // validation doesn't reject otherwise-valid candidates.
  const normalized = normalizeJsonQuotes(text);

  let depth = 0;
  let start = -1;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = normalized.slice(start, i + 1);
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

  // If we ended mid-object the output was truncated
  if (depth > 0 && start !== -1) {
    throw new TruncatedJsonError(normalized.slice(start));
  }

  return null;
}

/**
 * Extracts a raw parsed JSON object from agent text.
 * Tries markdown code blocks first, then bracket-balanced scan.
 * Throws InvalidJsonError or TruncatedJsonError on failure.
 */
function extractRawJson(text: string): any {
  const blockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  let parsed: any = null;
  let lastParserError: Error | null = null;

  while ((match = blockRegex.exec(text)) !== null) {
    try {
      parsed = JSON.parse(normalizeJsonQuotes(match[1]!));
      break;
    } catch (err) {
      lastParserError = err as Error;
    }
  }

  if (!parsed) {
    let jsonStr: string | null = null;
    try {
      jsonStr = extractOutermostJSON(text);
    } catch (err) {
      if (err instanceof TruncatedJsonError) throw err;
      lastParserError = err as Error;
    }
    if (jsonStr) {
      try {
        parsed = JSON.parse(normalizeJsonQuotes(jsonStr));
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

  return parsed;
}

/**
 * Extracts and validates a ProjectPlan from an agent's text response.
 */
export function extractPlanFromResponse(text: string): ProjectPlan {
  const parsed = extractRawJson(text);
  try {
    return ProjectPlanSchema.parse(parsed);
  } catch (err) {
    const zodError = err as any;
    throw new SchemaValidationError(`Invalid plan format: ${zodError.message}`, zodError.errors || []);
  }
}

/**
 * Extracts and validates an EpicOverview (Phase 1 response — no work items).
 */
export function extractEpicOverview(text: string): EpicOverview {
  const parsed = extractRawJson(text);
  try {
    return EpicOverviewSchema.parse(parsed);
  } catch (err) {
    const zodError = err as any;
    throw new SchemaValidationError(`Invalid epic overview: ${zodError.message}`, zodError.errors || []);
  }
}

/**
 * Extracts and validates a single Epic with work items (Phase 2 response).
 */
export function extractSingleEpic(text: string): Epic {
  const parsed = extractRawJson(text);
  try {
    return EpicSchema.parse(parsed);
  } catch (err) {
    const zodError = err as any;
    throw new SchemaValidationError(`Invalid epic: ${zodError.message}`, zodError.errors || []);
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

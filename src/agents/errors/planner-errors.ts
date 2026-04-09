/**
 * Custom error classes for the project planner.
 * Provides structured error handling with context.
 */

/**
 * Base error for all planner-related errors.
 */
export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    cause?: Error
  ) {
    super(message, { cause });
    this.name = 'PlannerError';
  }
}

/**
 * Thrown when the agent response doesn't contain valid JSON.
 */
export class InvalidJsonError extends PlannerError {
  constructor(
    message: string,
    public readonly rawResponse: string
  ) {
    super(message, 'INVALID_JSON');
    this.name = 'InvalidJsonError';
  }
}

/**
 * Thrown when the JSON structure doesn't match the expected schema.
 */
export class SchemaValidationError extends PlannerError {
  constructor(
    message: string,
    public readonly errors: any[]
  ) {
    super(message, 'SCHEMA_VALIDATION_ERROR');
    this.name = 'SchemaValidationError';
  }
}

/**
 * Thrown when no agent response is received.
 */
export class NoResponseError extends PlannerError {
  constructor() {
    super('Agent did not produce any response.', 'NO_RESPONSE');
    this.name = 'NoResponseError';
  }
}

/**
 * Thrown when file system operations fail.
 */
export class FileSystemError extends PlannerError {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly path?: string
  ) {
    super(message, 'FILE_SYSTEM_ERROR');
    this.name = 'FileSystemError';
  }
}

/**
 * Thrown when the plan is cancelled by the user.
 */
export class PlanCancelledError extends PlannerError {
  constructor(reason: string) {
    super(`Plan cancelled: ${reason}`, 'PLAN_CANCELLED');
    this.name = 'PlanCancelledError';
  }
}

/**
 * Factory function to create a user cancellation error.
 */
export function createUserCancelledError(action: string): PlanCancelledError {
  return new PlanCancelledError(`${action} was cancelled by the user`);
}

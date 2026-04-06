import { Type } from '@sinclair/typebox';

/**
 * TypeBox schema for the ask_user_for_clarification tool.
 */
export const AskUserForClarificationSchema = Type.Object({
  question: Type.String({ description: "The specific question you need answered from the user." }),
});

export type AskUserForClarificationArgs = {
  question: string;
};

/**
 * Creates the ask_user_for_clarification tool parameters.
 */
export function getAskUserForClarificationParams() {
  return AskUserForClarificationSchema;
}

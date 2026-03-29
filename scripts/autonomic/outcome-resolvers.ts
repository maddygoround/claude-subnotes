import type {
  InterventionRecord,
  InterventionOutcome,
} from './types.js';

export interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Determine the outcome of an advisory intervention.
 *
 * An advisory is "followed" if Claude's next action aligns with the advice.
 * It's "ignored" if Claude does exactly what was warned about.
 * It's "acknowledged" if Claude explicitly references the warning.
 */
function resolveAdvisoryOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check if Claude acknowledged the warning.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'assistant') {
      continue;
    }

    const content = entry.content.toLowerCase();
    if (
      content.includes('noted') ||
      content.includes('good point') ||
      content.includes('taking into account') ||
      content.includes('insight') ||
      content.includes('sentinel') ||
      content.includes('pattern detected') ||
      content.includes('warning')
    ) {
      return 'acknowledged';
    }
  }

  // Check if Claude's next tool call touches the same file/tool.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'system' || !entry.content.includes('<tool_event>')) {
      continue;
    }

    const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
    if (!toolNameMatch) {
      continue;
    }

    const nextTool = toolNameMatch[1];

    // Preserve original heuristic: same tool + structured prior input => ignored.
    if (
      nextTool === intervention.tool_name &&
      typeof intervention.tool_input === 'object' &&
      intervention.tool_input !== null
    ) {
      return 'ignored';
    }

    return 'followed';
  }

  // If no subsequent tool calls, assume acknowledged (Claude stopped).
  return 'acknowledged';
}

/**
 * Determine the outcome of a deny intervention.
 *
 * "redirected" if Claude tries a different approach.
 * "retried" if Claude tries the exact same thing.
 * "user_override" if the user explicitly tells Claude to proceed.
 */
function resolveDenyOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check for user override.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'user') {
      continue;
    }

    const content = entry.content.toLowerCase();
    if (
      content.includes('go ahead') ||
      content.includes('proceed') ||
      content.includes('do it anyway') ||
      content.includes('override') ||
      content.includes('ignore the warning') ||
      content.includes('just do it')
    ) {
      return 'user_override';
    }
  }

  // Check if Claude retried the same action.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'system' || !entry.content.includes('<tool_event>')) {
      continue;
    }

    const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
    if (toolNameMatch && toolNameMatch[1] === intervention.tool_name) {
      const inputStr = JSON.stringify(intervention.tool_input);
      if (entry.content.includes(inputStr.slice(1, 50))) {
        return 'retried';
      }
    }
  }

  return 'redirected';
}

/**
 * Determine the outcome of a correction intervention.
 *
 * "correction_helped" if the corrected call succeeded.
 * "correction_failed" if it failed.
 * "correction_rejected" if the user noticed and undid it.
 */
function resolveCorrectionOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check if user rejected the correction.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'user') {
      continue;
    }

    const content = entry.content.toLowerCase();
    if (
      content.includes('undo') ||
      content.includes('revert') ||
      content.includes('no, use') ||
      content.includes('wrong path') ||
      content.includes("that's not right")
    ) {
      return 'correction_rejected';
    }
  }

  // Check if the next tool call (with corrected input) succeeded.
  for (const entry of subsequentEntries) {
    if (entry.role !== 'system' || !entry.content.includes('<tool_event>')) {
      continue;
    }

    const responseMatch = entry.content.match(/<response>([\s\S]*?)<\/response>/);
    if (!responseMatch) {
      continue;
    }

    const response = responseMatch[1].toLowerCase();
    const hasError =
      response.includes('error') ||
      response.includes('failed') ||
      response.includes('enoent');
    return hasError ? 'correction_failed' : 'correction_helped';
  }

  return null;
}

/**
 * Determine the outcome of an ask intervention.
 *
 * "user_approved" if the user approved.
 * "user_denied" if the user denied.
 */
function resolveAskOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  for (const entry of subsequentEntries) {
    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
      if (toolNameMatch && toolNameMatch[1] === intervention.tool_name) {
        return 'user_approved';
      }
    }

    if (entry.role === 'user') {
      const content = entry.content.toLowerCase();
      if (
        content.includes('no') ||
        content.includes("don't") ||
        content.includes('stop') ||
        content.includes('cancel')
      ) {
        return 'user_denied';
      }
    }
  }

  return null;
}

export function resolveInterventionOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  switch (intervention.type) {
    case 'whisper':
    case 'insight':
    case 'sentinel':
      return resolveAdvisoryOutcome(intervention, subsequentEntries);
    case 'deny':
      return resolveDenyOutcome(intervention, subsequentEntries);
    case 'correct':
      return resolveCorrectionOutcome(intervention, subsequentEntries);
    case 'ask':
      return resolveAskOutcome(intervention, subsequentEntries);
    default:
      return null;
  }
}

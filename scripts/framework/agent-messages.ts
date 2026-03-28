/**
 * Agent Messages Framework
 *
 * Shared agent message store — read, write, and format
 * messages between the SubNotes agent and Claude Code.
 *
 * Used by send_worker_continuous and sync_local_memory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir, escapeXmlContent } from '../conversation_utils.js';
import { updateJsonFile } from '../state_store.js';
import type { LogFn } from './hook-io.js';

// ============================================
// Types
// ============================================

export interface AgentMessage {
  id: string;
  text: string;
  date: string;
  read?: boolean;
}

function getAgentMessagesFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'agent_messages.json');
}

function normalizeAgentMessages(data: unknown): AgentMessage[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((item): item is AgentMessage => {
      if (!item || typeof item !== 'object') {
        return false;
      }

      const candidate = item as Partial<AgentMessage>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.text === 'string' &&
        typeof candidate.date === 'string'
      );
    })
    .map((message) => ({
      ...message,
      read: Boolean(message.read),
    }));
}

// ============================================
// Write
// ============================================

/**
 * Append a message from the SubNotes agent.
 * Creates agent_messages.json if it doesn't exist.
 */
export function appendAgentMessage(
  cwd: string,
  text: string,
  log?: LogFn,
): void {
  if (!text || !text.trim()) return;

  const messagesFile = getAgentMessagesFile(cwd);

  try {
    updateJsonFile<AgentMessage[], void>(
      messagesFile,
      {
        defaultValue: [],
        log,
      },
      (currentMessages) => {
        const messages = normalizeAgentMessages(currentMessages);
        const nextMessages = [...messages];
        nextMessages.push({
          id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          text: text.trim(),
          date: new Date().toISOString(),
          read: false,
        });

        return {
          next: nextMessages,
          result: undefined,
        };
      },
    );
  } catch (error) {
    log?.(`Failed to append agent message: ${error}`);
  }
}

// ============================================
// Read
// ============================================

/**
 * Fetch unread agent messages and mark them as read.
 */
export function fetchUnreadAgentMessages(
  cwd: string,
  log?: LogFn,
): AgentMessage[] {
  const messagesFile = getAgentMessagesFile(cwd);
  if (!fs.existsSync(messagesFile)) {
    return [];
  }

  try {
    return updateJsonFile<AgentMessage[], AgentMessage[]>(
      messagesFile,
      {
        defaultValue: [],
        log,
      },
      (currentMessages) => {
        const messages = normalizeAgentMessages(currentMessages);
        const unread = messages.filter((message) => !message.read);

        if (unread.length === 0) {
          return {
            next: messages,
            result: [],
          };
        }

        const unreadIds = new Set(unread.map((message) => message.id));
        const updatedMessages = messages.map((message) =>
          unreadIds.has(message.id)
            ? { ...message, read: true }
            : message,
        );

        return {
          next: updatedMessages,
          result: unread,
        };
      },
    );
  } catch (e) {
    log?.(`Error reading agent messages: ${e}`);
    return [];
  }
}

// ============================================
// Format
// ============================================

/**
 * Format agent messages as XML for hook stdout injection.
 */
export function formatMessagesForStdout(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return `<!-- No new messages from Subconscious -->`;
  }

  return formatMessagesForHookContext(messages);
}

/**
 * Format agent messages as XML for hook context injection.
 * Unlike stdout formatter, this never emits an empty placeholder comment.
 */
export function formatMessagesForHookContext(messages: AgentMessage[]): string {
  const formattedMessages = messages.map((msg, index) => {
    const timestamp = msg.date || 'unknown';
    const escapedText = escapeXmlContent(msg.text || '');
    const sequenceAttr = messages.length > 1
      ? ` sequence="${index + 1}/${messages.length}"`
      : '';
    return `<subnotes_message from="Subconscious"${sequenceAttr} timestamp="${timestamp}">\n${escapedText}\n</subnotes_message>`;
  });

  return formattedMessages.join('\n\n');
}

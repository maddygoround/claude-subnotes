/**
 * Agent Messages Framework
 *
 * Shared agent message store — read, write, and format
 * messages between the SubNotes agent and Claude Code.
 *
 * Used by send_worker_local, send_worker_continuous, and sync_local_memory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir } from '../conversation_utils.js';
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

  const messagesFile = path.join(getDurableStateDir(cwd), 'agent_messages.json');
  let messages: AgentMessage[] = [];

  if (fs.existsSync(messagesFile)) {
    try {
      messages = JSON.parse(fs.readFileSync(messagesFile, 'utf-8'));
    } catch (e) {
      log?.(`Failed to read agent_messages.json: ${e}`);
    }
  }

  messages.push({
    id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    text: text.trim(),
    date: new Date().toISOString(),
    read: false,
  });

  fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
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
  const messagesFile = path.join(getDurableStateDir(cwd), 'agent_messages.json');
  if (!fs.existsSync(messagesFile)) {
    return [];
  }

  try {
    const messages: AgentMessage[] = JSON.parse(
      fs.readFileSync(messagesFile, 'utf-8'),
    );
    const unread = messages.filter((m) => !m.read);

    if (unread.length > 0) {
      const updatedMessages = messages.map((m) => ({ ...m, read: true }));
      fs.writeFileSync(
        messagesFile,
        JSON.stringify(updatedMessages, null, 2),
      );
    }

    return unread;
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
  const agentName = 'SubNotes';

  if (messages.length === 0) {
    return `<!-- No new messages from ${agentName} -->`;
  }

  const formattedMessages = messages.map((msg, index) => {
    const timestamp = msg.date || 'unknown';
    const msgNum =
      messages.length > 1 ? ` (${index + 1}/${messages.length})` : '';
    return `<subnotes_message from="${agentName}"${msgNum} timestamp="${timestamp}">\n${msg.text}\n</subnotes_message>`;
  });

  return formattedMessages.join('\n\n');
}

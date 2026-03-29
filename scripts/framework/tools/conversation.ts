import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir } from '../../conversation_utils.js';
import { truncateText } from '../utils/text.js';
import {
  boundarySignal,
  clarificationSignal,
  createToolResult,
  defineTool,
  type ToolExecutionResult,
  type ToolHandler,
} from './types.js';

interface TranscriptEntry {
  timestamp?: string;
  role?: string;
  content?: string;
}

interface SearchHit {
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  timestamp: string;
  content: string;
  score: number;
}

function parseDateBoundary(value: unknown, endOfDay: boolean): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const t = Date.parse(`${trimmed}${suffix}`);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? null : t;
}

function detectRole(entry: TranscriptEntry): 'user' | 'assistant' | 'tool' {
  if (entry.role === 'user') return 'user';
  if (entry.role === 'assistant') return 'assistant';
  if (typeof entry.content === 'string' && entry.content.includes('<tool_event>')) {
    return 'tool';
  }
  return 'tool';
}

function extractSessionIdFromTranscriptFile(filename: string): string {
  const trimmed = filename.replace(/^transcript-/, '').replace(/\.jsonl$/, '');
  const firstDash = trimmed.indexOf('-');
  if (firstDash < 0) return trimmed;
  return trimmed.slice(firstDash + 1);
}

function scoreContent(content: string, query: string): number {
  if (!query) return 1;
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  if (!lower.includes(target)) return 0;
  let score = 0;
  let idx = lower.indexOf(target);
  while (idx >= 0) {
    score++;
    idx = lower.indexOf(target, idx + target.length);
  }
  return score;
}

function executeConversationSearch(
  input: Record<string, unknown>,
  cwd: string,
): ToolExecutionResult {
  const query = String(input.query ?? '').trim();
  const limitRaw = Number(input.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, limitRaw), 100)
    : 20;
  const roleFilter = Array.isArray(input.roles)
    ? new Set(input.roles.map((r) => String(r)))
    : null;
  const startTs = parseDateBoundary(input.start_date, false);
  const endTs = parseDateBoundary(input.end_date, true);
  const exploratorySearchSignals =
    !query && !roleFilter && startTs === null && endTs === null
      ? [
          clarificationSignal(
            'Conversation search is running without a query or filters, so recall may be noisy.',
            'What prior decision, file, or topic should Claude Code recover?',
            'Treat broad transcript recall as exploratory rather than decisive evidence.',
            {
              confidence: 'medium',
              priority: 'low',
            },
          ),
        ]
      : [];

  const durableDir = getDurableStateDir(cwd);
  if (!fs.existsSync(durableDir)) {
    return createToolResult({
      result: '<conversation_search_result>No conversation history found.</conversation_search_result>',
      summary: 'No conversation history is available yet',
      signals: [
        ...exploratorySearchSignals,
        boundarySignal('Conversation search has no local transcript history to inspect.', {
          confidence: 'high',
          priority: 'low',
          recommendedAction: 'Rely on the current transcript or external sources instead.',
        }),
      ],
    });
  }

  const transcriptFiles = fs
    .readdirSync(durableDir)
    .filter((name) => /^transcript-.*\.jsonl$/.test(name));

  const hits: SearchHit[] = [];

  for (const filename of transcriptFiles) {
    const fullPath = path.join(durableDir, filename);
    const sessionId = extractSessionIdFromTranscriptFile(filename);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: TranscriptEntry;
      try {
        parsed = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }

      const role = detectRole(parsed);
      if (roleFilter && !roleFilter.has(role)) {
        continue;
      }

      const timestamp = String(parsed.timestamp || '');
      const ts = Date.parse(timestamp);
      if (startTs !== null && (!Number.isFinite(ts) || ts < startTs)) {
        continue;
      }
      if (endTs !== null && (!Number.isFinite(ts) || ts > endTs)) {
        continue;
      }

      const entryText = String(parsed.content || '').replace(/\s+/g, ' ').trim();
      const score = scoreContent(entryText, query);
      if (score <= 0) {
        continue;
      }

      hits.push({
        sessionId,
        role,
        timestamp: timestamp || 'unknown',
        content: entryText,
        score,
      });
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.timestamp.localeCompare(a.timestamp);
  });

  const topHits = hits.slice(0, limit);
  if (topHits.length === 0) {
    return createToolResult({
      result: '<conversation_search_result>No matches found.</conversation_search_result>',
      summary: query
        ? `No prior conversation matches for ${query}`
        : 'No conversation entries matched the provided filters',
      signals: query
        ? [
            ...exploratorySearchSignals,
            boundarySignal(`No prior transcript evidence was found for "${query}".`, {
              confidence: 'medium',
              priority: 'low',
            }),
          ]
        : exploratorySearchSignals,
      metadata: {
        totalMatches: 0,
        query,
        limit,
      },
    });
  }

  const rendered = topHits
    .map((hit, idx) => {
      return (
        `${idx + 1}. [${hit.timestamp}] session=${hit.sessionId} role=${hit.role} score=${hit.score}\n` +
        `${truncateText(hit.content, { maxChars: 320 })}`
      );
    })
    .join('\n\n');

  return createToolResult({
    result:
      `<conversation_search_result total_matches="${hits.length}" returned="${topHits.length}">\n` +
      `${rendered}\n` +
      `</conversation_search_result>`,
    summary: `Found ${topHits.length} conversation hits (${hits.length} total matches)`,
    signals: exploratorySearchSignals,
    metadata: {
      totalMatches: hits.length,
      returned: topHits.length,
      query,
      limit,
    },
  });
}

const conversationSearchDefinition = defineTool({
  name: 'conversation_search',
  domain: 'conversation',
  description:
    'Search prior local transcript history across sessions with optional filters.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      roles: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['assistant', 'user', 'tool'],
        },
      },
      limit: { type: 'integer' },
      start_date: { type: 'string' },
      end_date: { type: 'string' },
    },
    required: [],
  },
  execute: (input, ctx) => executeConversationSearch(input, ctx.cwd),
});

export function getConversationToolHandlers(): ToolHandler[] {
  return [conversationSearchDefinition];
}

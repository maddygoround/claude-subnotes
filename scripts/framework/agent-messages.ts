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
import { getDurableStateDir } from '../conversation_utils.js';
import { escapeXmlContent } from './utils/xml.js';
import { updateJsonFile } from '../state_store.js';
import type { InterventionRecord } from '../autonomic/types.js';
import type { LogFn } from './hook-io.js';

// ============================================
// Types
// ============================================

export type AgentMessageType = 'reflect' | 'steer' | 'insight';

export interface AgentMessage {
  id: string;
  type?: AgentMessageType;
  text: string;
  date: string;
  read?: boolean;
  foreground_score?: number;
  surface_threshold?: number;
  decision_reasons?: string[];
}

export interface ForegroundTranscriptEntry {
  timestamp?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ForegroundCandidate {
  type: AgentMessageType;
  text: string;
}

export interface ForegroundEvaluationContext {
  recentTranscriptEntries?: ForegroundTranscriptEntry[];
  recentInterventions?: InterventionRecord[];
  history?: AgentMessage[];
}

export interface ForegroundDecision {
  shouldSurface: boolean;
  score: number;
  threshold: number;
  reasons: string[];
  urgency: number;
  actionability: number;
  relevance: number;
  novelty: number;
  durability: number;
  momentum: number;
  typeBias: number;
  metaPenalty: number;
}

const MAX_FOREGROUND_MESSAGES_PER_SYNC = 1;
export const BASE_SURFACE_THRESHOLD = 56;
const MIN_SCORE_TO_KEEP_UNREAD = 42;
const MAX_PENDING_MESSAGE_AGE_MS = 20 * 60 * 1000;
const MESSAGE_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const REFLECT_COOLDOWN_MS = 5 * 60 * 1000;
const MESSAGE_SIMILARITY_THRESHOLD = 0.78;
const TRUNCATION_NOTICE = '[Trimmed to protect foreground context.]';
const MAX_MESSAGE_CHARS: Record<AgentMessageType, number> = {
  reflect: 500,
  steer: 700,
  insight: 900,
};
const NO_OP_PATTERNS = [
  /\bno guidance needed\b/i,
  /\bnothing needs guidance\b/i,
  /\bno direct guidance needed\b/i,
  /\bnothing new to act on\b/i,
  /\bno issues to flag\b/i,
  /\bno intervention needed\b/i,
  /\bnot enough signal\b/i,
  /\bno corrections\b/i,
  /\bi'?ll stay quiet\b/i,
  /\bstay quiet and watch\b/i,
  /\bjust stay quiet\b/i,
];
const URGENCY_PATTERNS = [
  /\bloop(?:ing)?\b/i,
  /\bstuck\b/i,
  /\bblocked\b/i,
  /\bfail(?:ed|ing|ure)?s?\b/i,
  /\berror(?:s)?\b/i,
  /\bimpossible\b/i,
  /\bwrong root cause\b/i,
  /\bdead end\b/i,
  /\bthrash(?:ing)?\b/i,
  /\bcascade\b/i,
  /\bregression\b/i,
  /\brisk\b/i,
  /\boverwrite\b/i,
  /\bretry(?:ing)?\b/i,
];
const ACTION_PATTERNS = [
  /\bshould\b/i,
  /\bneed to\b/i,
  /\bmust\b/i,
  /\btry\b/i,
  /\bcheck\b/i,
  /\binspect\b/i,
  /\bcompare\b/i,
  /\bswitch\b/i,
  /\buse\b/i,
  /\bavoid\b/i,
  /\bstop\b/i,
  /\bpivot\b/i,
  /\bfocus on\b/i,
  /\bpreserve\b/i,
  /\bkeep\b/i,
  /\bupdate\b/i,
  /\bfix\b/i,
  /\bmerge\b/i,
  /\bprefer\b/i,
  /\bregenerate\b/i,
  /\bread\b/i,
  /\blook at\b/i,
];
const DURABILITY_PATTERNS = [
  /\buser (?:wants|prefers|expects)\b/i,
  /\bproject (?:convention|constraint|policy|expectation)\b/i,
  /\bsource of truth\b/i,
  /\bcanonical\b/i,
  /\bremember\b/i,
  /\bhistory\b/i,
  /\bpast behavior\b/i,
  /\bpattern\b/i,
  /\bnext time\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\brepo-wide\b/i,
  /\bacross sessions\b/i,
];
const META_OBSERVATION_PATTERNS = [
  /\bthis session\b/i,
  /\bclaude code is\b/i,
  /\blooks like\b/i,
  /\bjust reading\b/i,
  /\borientation\b/i,
  /\bfamiliarization\b/i,
  /\bchecking in casually\b/i,
  /\bnatural checkpoint\b/i,
  /\bi should wait\b/i,
  /\bwatch for the next\b/i,
  /\bno visible struggle\b/i,
  /\bsmooth session start\b/i,
  /\binteresting snapshot\b/i,
];
const CONCRETE_REFERENCE_PATTERNS = [
  /\bBash\b/,
  /\bEdit\b/,
  /\bWrite\b/,
  /\bRead\b/,
  /\bGlob\b/,
  /\bGrep\b/,
  /\bMultiEdit\b/,
  /\bTask\b/,
  /\bTodoWrite\b/,
];
const POSITIVE_OUTCOMES = new Set([
  'followed',
  'acknowledged',
  'redirected',
  'correction_helped',
  'user_approved',
]);
const NEGATIVE_OUTCOMES = new Set([
  'ignored',
  'retried',
  'user_override',
  'correction_failed',
  'correction_rejected',
  'user_denied',
]);
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'here',
  'how',
  'if',
  'into',
  'is',
  'it',
  'its',
  'just',
  'now',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'there',
  'they',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'while',
  'with',
  'would',
  'you',
  'your',
]);

function getAgentMessagesFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'conversation.json');
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
      type: ['reflect', 'steer', 'insight'].includes(message.type as string)
        ? message.type
        : 'reflect',
      read: Boolean(message.read),
      foreground_score:
        typeof message.foreground_score === 'number' &&
        Number.isFinite(message.foreground_score)
          ? message.foreground_score
          : undefined,
      surface_threshold:
        typeof message.surface_threshold === 'number' &&
        Number.isFinite(message.surface_threshold)
          ? message.surface_threshold
          : undefined,
      decision_reasons: Array.isArray(message.decision_reasons)
        ? message.decision_reasons.filter(
            (reason): reason is string => typeof reason === 'string' && reason.trim().length > 0,
          )
        : undefined,
    }));
}

export function loadAgentMessageHistory(
  cwd: string,
  log?: LogFn,
): AgentMessage[] {
  const messagesFile = getAgentMessagesFile(cwd);
  if (!fs.existsSync(messagesFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(messagesFile, 'utf-8');
    return normalizeAgentMessages(JSON.parse(raw));
  } catch (error) {
    log?.(`Error loading agent message history: ${error}`);
    return [];
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateMessageText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const safeLimit = Math.max(80, maxChars - TRUNCATION_NOTICE.length - 2);
  const sliced = text.slice(0, safeLimit).trimEnd();
  const lastWordBoundary = sliced.lastIndexOf(' ');
  const truncated = lastWordBoundary > safeLimit * 0.6
    ? sliced.slice(0, lastWordBoundary)
    : sliced;
  return `${truncated}\n\n${TRUNCATION_NOTICE}`;
}

function prepareMessageText(type: AgentMessageType, text: string): string {
  return truncateMessageText(text.trim(), MAX_MESSAGE_CHARS[type]);
}

function shouldSuppressMessageText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  return NO_OP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeForSimilarity(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    normalizeForSimilarity(text)
      .split(' ')
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function computeTokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared += 1;
    }
  }

  const unionSize = a.size + b.size - shared;
  return unionSize === 0 ? 0 : shared / unionSize;
}

function areNearDuplicateMessages(
  a: Pick<AgentMessage, 'text'>,
  b: Pick<AgentMessage, 'text'>,
): boolean {
  const normalizedA = normalizeForSimilarity(a.text);
  const normalizedB = normalizeForSimilarity(b.text);
  if (!normalizedA || !normalizedB) {
    return false;
  }
  if (normalizedA === normalizedB) {
    return true;
  }

  const similarity = computeTokenSimilarity(
    tokenizeForSimilarity(a.text),
    tokenizeForSimilarity(b.text),
  );
  return similarity >= MESSAGE_SIMILARITY_THRESHOLD;
}

function getTypePriority(type: AgentMessageType): number {
  switch (type) {
    case 'insight':
      return 3;
    case 'steer':
      return 2;
    case 'reflect':
    default:
      return 1;
  }
}

function getFallbackScore(type: AgentMessageType): number {
  switch (type) {
    case 'insight':
      return 62;
    case 'steer':
      return 54;
    case 'reflect':
    default:
      return 46;
  }
}

function getMessageScore(
  message: Pick<AgentMessage, 'type' | 'foreground_score'>,
): number {
  if (
    typeof message.foreground_score === 'number' &&
    Number.isFinite(message.foreground_score)
  ) {
    return message.foreground_score;
  }
  return getFallbackScore(message.type ?? 'reflect');
}

function parseDateMs(date: string): number {
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countPatternHits(text: string, patterns: readonly RegExp[]): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      hits += 1;
    }
  }
  return hits;
}

function extractCodeReferences(text: string): string[] {
  const refs = new Set<string>();

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    if (match[1]) {
      refs.add(match[1].trim().toLowerCase());
    }
  }

  for (const match of text.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/g)) {
    refs.add(match[0].trim().toLowerCase());
  }

  return [...refs];
}

function buildTranscriptContext(entries: ForegroundTranscriptEntry[]): string {
  return entries
    .slice(-6)
    .map((entry) => normalizeWhitespace(entry.content))
    .filter(Boolean)
    .join(' ');
}

function scoreUrgency(
  candidate: ForegroundCandidate,
  transcriptText: string,
  recentInterventions: InterventionRecord[],
): { score: number; reason?: string } {
  const thoughtHits = countPatternHits(candidate.text, URGENCY_PATTERNS);
  const transcriptHits = countPatternHits(transcriptText, URGENCY_PATTERNS);
  const unresolvedSentinelCount = recentInterventions
    .slice(-6)
    .filter(
      (intervention) =>
        intervention.type === 'sentinel' &&
        intervention.outcome !== 'followed' &&
        intervention.outcome !== 'redirected',
    ).length;

  let score =
    thoughtHits * 6 +
    Math.min(8, transcriptHits * 3) +
    Math.min(4, unresolvedSentinelCount * 2);

  if (candidate.type === 'insight') {
    score += 4;
  } else if (candidate.type === 'steer') {
    score += 2;
  }

  score = clamp(score, 0, 24);

  if (score >= 18) {
    return { score, reason: 'urgent loop or failure risk' };
  }
  if (score >= 10) {
    return { score, reason: 'elevated immediate risk' };
  }
  return { score };
}

function scoreActionability(text: string): { score: number; reason?: string } {
  const actionHits = countPatternHits(text, ACTION_PATTERNS);
  const hasConcreteReference =
    extractCodeReferences(text).length > 0 ||
    CONCRETE_REFERENCE_PATTERNS.some((pattern) => pattern.test(text));
  const hasCausalBridge = /\b(because|root cause|instead of|rather than|so that|to avoid)\b/i.test(
    text,
  );

  let score = actionHits * 4;
  if (hasConcreteReference) {
    score += 4;
  }
  if (hasCausalBridge) {
    score += 2;
  }

  score = clamp(score, 0, 20);

  if (score >= 12) {
    return { score, reason: 'clear next action' };
  }
  if (score >= 6) {
    return { score, reason: 'some actionable guidance' };
  }
  return { score };
}

function scoreRelevance(
  text: string,
  entries: ForegroundTranscriptEntry[],
): { score: number; reason?: string } {
  if (entries.length === 0) {
    return { score: 0 };
  }

  const contextText = buildTranscriptContext(entries);
  if (!contextText) {
    return { score: 0 };
  }

  const similarity = computeTokenSimilarity(
    tokenizeForSimilarity(text),
    tokenizeForSimilarity(contextText),
  );
  const latestText = normalizeWhitespace(entries[entries.length - 1]?.content ?? '');
  const latestSimilarity = latestText
    ? computeTokenSimilarity(
        tokenizeForSimilarity(text),
        tokenizeForSimilarity(latestText),
      )
    : 0;
  const lowerContext = contextText.toLowerCase();
  const referenceHits = extractCodeReferences(text).filter((ref) =>
    lowerContext.includes(ref),
  ).length;

  let score =
    Math.round(similarity * 40) +
    Math.round(latestSimilarity * 24) +
    Math.min(4, referenceHits * 2);

  score = clamp(score, 0, 18);

  if (score >= 12) {
    return { score, reason: 'grounded in the current turn' };
  }
  if (score >= 6) {
    return { score, reason: 'related to the current turn' };
  }
  return { score };
}

function scoreNovelty(
  text: string,
  history: AgentMessage[],
): { score: number; reason?: string } {
  const recentHistory = history.slice(-12);
  if (recentHistory.length === 0) {
    return { score: 12, reason: 'novel relative to recent foreground thoughts' };
  }

  let maxSimilarity = 0;
  for (const message of recentHistory) {
    const similarity = computeTokenSimilarity(
      tokenizeForSimilarity(text),
      tokenizeForSimilarity(message.text),
    );
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }

  const score =
    maxSimilarity >= 0.72
      ? 0
      : clamp(Math.round((1 - maxSimilarity) * 12), 0, 12);

  if (score >= 8) {
    return { score, reason: 'novel relative to recent foreground thoughts' };
  }
  return { score };
}

function scoreDurability(text: string): { score: number; reason?: string } {
  const hits = countPatternHits(text, DURABILITY_PATTERNS);
  const score = clamp(hits * 3 + (/\b(distilled|foreground|working context)\b/i.test(text) ? 1 : 0), 0, 10);

  if (score >= 6) {
    return { score, reason: 'captures a durable constraint or pattern' };
  }
  return { score };
}

export function scoreOutcomeMomentum(
  recentInterventions: InterventionRecord[],
): { score: number; thresholdAdjustment: number; reason?: string } {
  const recentResolved = recentInterventions
    .filter((intervention) => intervention.outcome)
    .slice(-8);

  let positive = 0;
  let negative = 0;
  for (const intervention of recentResolved) {
    const outcome = intervention.outcome;
    if (!outcome) continue;
    if (POSITIVE_OUTCOMES.has(outcome)) {
      positive += 1;
    } else if (NEGATIVE_OUTCOMES.has(outcome)) {
      negative += 1;
    }
  }

  const delta = positive - negative;
  const score = clamp(delta * 2, -6, 6);
  const thresholdAdjustment =
    delta >= 0
      ? -Math.min(4, delta)
      : Math.min(8, Math.abs(delta) * 2);

  if (delta >= 2) {
    return {
      score,
      thresholdAdjustment,
      reason: 'recent subconscious interventions have been landing',
    };
  }
  if (delta <= -1) {
    return {
      score,
      thresholdAdjustment,
      reason: 'recent interventions were noisy or ignored, so the bar is higher',
    };
  }
  return { score, thresholdAdjustment };
}

function scoreMetaPenalty(
  text: string,
  actionability: number,
  urgency: number,
): { score: number; reason?: string } {
  const metaHits = countPatternHits(text, META_OBSERVATION_PATTERNS);
  let penalty = metaHits * -6;

  if (metaHits > 0 && actionability < 8) {
    penalty -= 6;
  }
  if (actionability === 0 && urgency < 8 && extractCodeReferences(text).length === 0) {
    penalty -= 4;
  }

  penalty = clamp(penalty, -28, 0);

  if (penalty <= -12) {
    return { score: penalty, reason: 'mostly meta commentary instead of a needed intervention' };
  }
  return { score: penalty };
}

export function evaluateForegroundCandidate(
  cwd: string,
  candidate: ForegroundCandidate,
  context: ForegroundEvaluationContext = {},
  log?: LogFn,
): ForegroundDecision {
  const normalizedText = normalizeWhitespace(candidate.text);
  if (!normalizedText || shouldSuppressMessageText(normalizedText)) {
    return {
      shouldSurface: false,
      score: 0,
      threshold: 100,
      reasons: ['self-negating or no-action thought'],
      urgency: 0,
      actionability: 0,
      relevance: 0,
      novelty: 0,
      durability: 0,
      momentum: 0,
      typeBias: 0,
      metaPenalty: 0,
    };
  }

  const history = context.history ?? loadAgentMessageHistory(cwd, log);
  const recentTranscriptEntries = context.recentTranscriptEntries ?? [];
  const recentInterventions = context.recentInterventions ?? [];
  const transcriptText = buildTranscriptContext(recentTranscriptEntries);

  const urgencySignal = scoreUrgency(candidate, transcriptText, recentInterventions);
  const actionabilitySignal = scoreActionability(normalizedText);
  const relevanceSignal = scoreRelevance(normalizedText, recentTranscriptEntries);
  const noveltySignal = scoreNovelty(normalizedText, history);
  const durabilitySignal = scoreDurability(normalizedText);
  const outcomeSignal = scoreOutcomeMomentum(recentInterventions);
  const metaPenaltySignal = scoreMetaPenalty(
    normalizedText,
    actionabilitySignal.score,
    urgencySignal.score,
  );

  const typeBias =
    candidate.type === 'insight' ? 4 : candidate.type === 'steer' ? 2 : -4;

  const score = clamp(
    Math.round(
      8 +
      urgencySignal.score +
      actionabilitySignal.score +
      relevanceSignal.score +
      noveltySignal.score +
      durabilitySignal.score +
      outcomeSignal.score +
      typeBias +
      metaPenaltySignal.score,
    ),
    0,
    100,
  );

  const threshold = clamp(
    BASE_SURFACE_THRESHOLD +
      outcomeSignal.thresholdAdjustment +
      (candidate.type === 'reflect' ? 4 : 0),
    48,
    70,
  );

  const reasons: string[] = [];
  for (const reason of [
    urgencySignal.reason,
    actionabilitySignal.reason,
    relevanceSignal.reason,
    noveltySignal.reason,
    durabilitySignal.reason,
    outcomeSignal.reason,
  ]) {
    if (reason) {
      reasons.push(reason);
    }
  }
  if (metaPenaltySignal.reason) {
    reasons.push(metaPenaltySignal.reason);
  }

  const immediateNeed =
    urgencySignal.score >= 18 &&
    actionabilitySignal.score >= 12 &&
    relevanceSignal.score >= 6;

  return {
    shouldSurface: score >= threshold || immediateNeed,
    score,
    threshold,
    reasons,
    urgency: urgencySignal.score,
    actionability: actionabilitySignal.score,
    relevance: relevanceSignal.score,
    novelty: noveltySignal.score,
    durability: durabilitySignal.score,
    momentum: outcomeSignal.score,
    typeBias,
    metaPenalty: metaPenaltySignal.score,
  };
}

function isPendingMessageFresh(message: AgentMessage, nowMs: number): boolean {
  const timestampMs = parseDateMs(message.date);
  if (timestampMs <= 0) {
    return false;
  }
  return nowMs - timestampMs <= MAX_PENDING_MESSAGE_AGE_MS;
}

function hasUnreadBlockingMessage(
  messages: AgentMessage[],
  candidate: Pick<AgentMessage, 'type' | 'foreground_score' | 'date'>,
): boolean {
  const candidateScore = getMessageScore(candidate);
  const nowMs = parseDateMs(candidate.date);

  return messages.some((message) => {
    if (message.read || !isPendingMessageFresh(message, nowMs)) {
      return false;
    }
    return getMessageScore(message) >= candidateScore + 2;
  });
}

function hasRecentDuplicate(
  messages: AgentMessage[],
  candidate: Pick<AgentMessage, 'text' | 'date'>,
): boolean {
  const nowMs = parseDateMs(candidate.date);
  return messages.some((message) => {
    const ageMs = nowMs - parseDateMs(message.date);
    if (ageMs < 0 || ageMs > MESSAGE_DEDUPE_WINDOW_MS) {
      return false;
    }
    return areNearDuplicateMessages(candidate, message);
  });
}

function hasReflectCooldown(
  messages: AgentMessage[],
  candidateDate: string,
): boolean {
  const nowMs = parseDateMs(candidateDate);
  return messages.some((message) => {
    if ((message.type ?? 'reflect') !== 'reflect') {
      return false;
    }
    const ageMs = nowMs - parseDateMs(message.date);
    return ageMs >= 0 && ageMs <= REFLECT_COOLDOWN_MS;
  });
}

function rankMessagesForForeground(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort((a, b) => {
    const scoreDelta = getMessageScore(b) - getMessageScore(a);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const typeDelta =
      getTypePriority(b.type ?? 'reflect') - getTypePriority(a.type ?? 'reflect');
    if (typeDelta !== 0) {
      return typeDelta;
    }
    return parseDateMs(b.date) - parseDateMs(a.date);
  });
}

function selectForegroundMessages(
  messages: AgentMessage[],
  nowMs: number = Date.now(),
): AgentMessage[] {
  const deliverable = rankMessagesForForeground(
    messages.filter(
      (message) =>
        !shouldSuppressMessageText(message.text) &&
        isPendingMessageFresh(message, nowMs) &&
        getMessageScore(message) >= MIN_SCORE_TO_KEEP_UNREAD,
    ),
  );

  const selected: AgentMessage[] = [];

  for (const message of deliverable) {
    if (selected.some((existing) => areNearDuplicateMessages(existing, message))) {
      continue;
    }
    selected.push(message);
    if (selected.length >= MAX_FOREGROUND_MESSAGES_PER_SYNC) {
      break;
    }
  }

  return selected;
}

function shouldRetirePendingMessage(
  message: AgentMessage,
  selected: AgentMessage | null,
  nowMs: number,
): boolean {
  if (message.read) {
    return false;
  }
  if (shouldSuppressMessageText(message.text)) {
    return true;
  }
  if (!isPendingMessageFresh(message, nowMs)) {
    return true;
  }
  if (getMessageScore(message) < MIN_SCORE_TO_KEEP_UNREAD) {
    return true;
  }
  if (!selected || message.id === selected.id) {
    return Boolean(selected && message.id === selected.id);
  }
  if (areNearDuplicateMessages(message, selected)) {
    return true;
  }
  const messageScore = getMessageScore(message);
  const selectedScore = getMessageScore(selected);
  return (
    parseDateMs(message.date) <= parseDateMs(selected.date) &&
    messageScore + 10 <= selectedScore
  );
}

// ============================================
// Write
// ============================================

/**
 * Append a message from the SubNotes agent.
 * Creates conversation.json if it doesn't exist.
 */
export function appendAgentMessage(
  cwd: string,
  text: string,
  log?: LogFn,
  type: AgentMessageType = 'reflect',
  decision?: ForegroundDecision,
): void {
  if (!text || !text.trim()) return;

  const preparedText = prepareMessageText(type, text);
  if (shouldSuppressMessageText(preparedText)) {
    log?.(`Skipped ${type} message with no-action wording`);
    return;
  }
  if (decision && !decision.shouldSurface) {
    log?.(
      `Skipped ${type} message because foreground scorer rejected it (${decision.score}/${decision.threshold})`,
    );
    return;
  }

  const messagesFile = getAgentMessagesFile(cwd);

  try {
    const now = new Date().toISOString();
    const candidateScore = decision?.score ?? getFallbackScore(type);
    const outcome = updateJsonFile<
      AgentMessage[],
      | 'appended'
      | 'suppressed-unread'
      | 'suppressed-duplicate'
      | 'suppressed-cooldown'
      | 'suppressed-not-needed'
    >(
      messagesFile,
      {
        defaultValue: [],
        log,
      },
      (currentMessages) => {
        const messages = normalizeAgentMessages(currentMessages);
        const candidate: AgentMessage = {
          id: `msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          type,
          text: preparedText,
          date: now,
          read: false,
          foreground_score: candidateScore,
          surface_threshold: decision?.threshold,
          decision_reasons: decision?.reasons?.slice(0, 6),
        };

        if (candidateScore < MIN_SCORE_TO_KEEP_UNREAD) {
          return {
            next: messages,
            result: 'suppressed-not-needed',
          };
        }

        if (hasUnreadBlockingMessage(messages, candidate)) {
          return {
            next: messages,
            result: 'suppressed-unread',
          };
        }

        if (hasRecentDuplicate(messages, candidate)) {
          return {
            next: messages,
            result: 'suppressed-duplicate',
          };
        }

        if (type === 'reflect' && hasReflectCooldown(messages, now)) {
          return {
            next: messages,
            result: 'suppressed-cooldown',
          };
        }

        return {
          next: [...messages, candidate],
          result: 'appended',
        };
      },
    );
    if (outcome !== 'appended') {
      log?.(`Skipped ${type} message (${outcome})`);
    }
  } catch (error) {
    log?.(`Failed to append agent message: ${error}`);
  }
}

// ============================================
// Read
// ============================================

/**
 * Fetch the best unread foreground messages and mark only delivered or obsolete
 * pending thoughts as read.
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

        const nowMs = Date.now();
        const selected = selectForegroundMessages(unread, nowMs);
        const primarySelected = selected[0] ?? null;
        const selectedIds = new Set(selected.map((message) => message.id));

        const updatedMessages = messages.map((message) =>
          selectedIds.has(message.id) ||
          shouldRetirePendingMessage(message, primarySelected, nowMs)
            ? { ...message, read: true }
            : message,
        );

        return {
          next: updatedMessages,
          result: selected,
        };
      },
    );
  } catch (e) {
    log?.(`Error reading agent messages: ${e}`);
    return [];
  }
}

/**
 * Inspect the current deliverable unread foreground messages without marking them as read.
 */
export function peekUnreadAgentMessages(
  cwd: string,
  log?: LogFn,
): AgentMessage[] {
  const messagesFile = getAgentMessagesFile(cwd);
  if (!fs.existsSync(messagesFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(messagesFile, 'utf-8');
    const messages = normalizeAgentMessages(JSON.parse(raw));
    return selectForegroundMessages(messages.filter((message) => !message.read));
  } catch (error) {
    log?.(`Error peeking agent messages: ${error}`);
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
    const typeLabel = msg.type || 'reflect';
    const escapedText = escapeXmlContent(msg.text || '');
    const sequenceAttr = messages.length > 1
      ? ` sequence="${index + 1}/${messages.length}"`
      : '';
    return `<subnotes_message from="Notes" type="${typeLabel}"${sequenceAttr} timestamp="${timestamp}">\n${escapedText}\n</subnotes_message>`;
  });

  return formattedMessages.join('\n\n');
}

/**
 * Generates the specific foreground instruction based on the message type.
 * This instructs Claude Code to render the thought prominently.
 */
export function generateForegroundInstruction(messages: AgentMessage[]): string {
  if (messages.length === 0) return '';

  let highestType: AgentMessageType = 'reflect';
  if (messages.some((message) => message.type === 'insight')) {
    highestType = 'insight';
  } else if (messages.some((message) => message.type === 'steer')) {
    highestType = 'steer';
  }

  let prefix = '**Notes reflect**';
  let description = '[observation]';

  if (highestType === 'insight') {
    prefix = '**Notes insight**';
    description = '[Identify the loop/issue] -> [Suggested pivot]';
  } else if (highestType === 'steer') {
    prefix = '**Notes steer**';
    description = '[direction]';
  }

  return `<instruction>Notes sent you a thought above. Render it visibly in your response BEFORE answering, using this format:\n\n---\n\n${prefix} — ${description}\n\nThis makes the context visible to the user. Keep it to one line — just the signal, not the full message.</instruction>`;
}

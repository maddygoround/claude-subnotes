import * as fs from 'fs';
import * as path from 'path';
import { withProcessLock } from '../state_store.js';
import { escapeRegex, escapeXmlAttribute, escapeXmlContent } from '../framework/utils/xml.js';
import { loadConfig } from './config.js';
import { getDurableStateDir } from './state-paths.js';

export interface ClaudeMdMemoryBlock {
  label: string;
  description: string;
  value: string;
}

// CLAUDE.md constants
export const ROOT_CLAUDE_MD_PATH = 'CLAUDE.md';
export const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
export const SUBNOTES_SECTION_START = '<subnotes>';
export const SUBNOTES_SECTION_END = '</subnotes>';
const SUBNOTES_CONTEXT_START = '<subnotes_context>';
const SUBNOTES_CONTEXT_END = '</subnotes_context>';
const SUBNOTES_MEMORY_START = '<subnotes_memory_blocks>';
const SUBNOTES_MEMORY_END = '</subnotes_memory_blocks>';
const DISTILLED_CLAUDE_MD_COMMENT =
  '<!-- SubNotes distilled context is automatically synced below -->';
const DISTILLED_CLAUDE_MD_MAX_CHARS = 5000;
const DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET = 160;
const DISTILLED_CLAUDE_MD_TRUNCATION_NOTICE =
  '[Truncated in CLAUDE.md. Full canonical state lives in .subnotes.]';
const DISTILLED_CLAUDE_MD_OMISSION_NOTICE =
  '[Additional subconscious state omitted here to protect CLAUDE.md context budget. Canonical state lives in .subnotes.]';

interface DistilledClaudeSectionConfig {
  label: string;
  title: string;
  maxChars: number;
  fallback?: string;
}

interface ClaudeMdTargetResolution {
  baseDir: string;
  canonicalPath: string;
  canonicalExisted: boolean;
  alternatePath: string | null;
}

const DISTILLED_CLAUDE_SECTIONS: DistilledClaudeSectionConfig[] = [
  {
    label: 'guidance',
    title: 'Active Guidance',
    maxChars: 1200,
    fallback: 'No active guidance right now.',
  },
  {
    label: 'pending_items',
    title: 'Pending Items',
    maxChars: 1200,
  },
  {
    label: 'project_context',
    title: 'Project Context',
    maxChars: 1800,
  },
  {
    label: 'user_preferences',
    title: 'User Preferences',
    maxChars: 1200,
  },
  {
    label: 'session_patterns',
    title: 'Relevant Patterns',
    maxChars: 1200,
  },
];

function formatContextSection(): string {
  return `${SUBNOTES_CONTEXT_START}
**Notes**

This is your persistent notes layer. It observes conversations asynchronously, updates memory blocks, and surfaces thoughts via <subnotes_message>. You can address it directly — it sees everything and may respond on the next sync.

Memory blocks below are the agent's long-term storage. Reference as needed.
${SUBNOTES_CONTEXT_END}`;
}

function isPlaceholderMemoryValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return /^\(No [^)]+\)$/.test(trimmed);
}

function trimDistilledSectionContent(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (maxChars <= 0) {
    return '';
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const notice = `\n\n${DISTILLED_CLAUDE_MD_TRUNCATION_NOTICE}`;
  if (maxChars <= notice.length + 40) {
    return trimmed.slice(0, maxChars).trimEnd();
  }

  const availableChars = Math.max(0, maxChars - notice.length);
  return `${trimmed.slice(0, availableChars).trimEnd()}${notice}`;
}

function hasMeaningfulDistilledValue(
  blockMap: Map<string, ClaudeMdMemoryBlock>,
  sectionConfig: DistilledClaudeSectionConfig,
): boolean {
  const block = blockMap.get(sectionConfig.label);
  if (!block) {
    return Boolean(sectionConfig.fallback);
  }

  return !isPlaceholderMemoryValue(block.value);
}

function renderDistilledSection(
  sectionConfig: DistilledClaudeSectionConfig,
  block: ClaudeMdMemoryBlock | undefined,
  remainingBudget: number,
): string {
  const sectionHeader = `## ${sectionConfig.title}\n`;
  const availableBodyBudget = remainingBudget - sectionHeader.length;
  if (availableBodyBudget <= 0) {
    return '';
  }

  const rawValue = block?.value || '';
  let sectionBody = '';

  if (!block || isPlaceholderMemoryValue(rawValue)) {
    if (!sectionConfig.fallback) {
      return '';
    }
    sectionBody = trimDistilledSectionContent(
      sectionConfig.fallback,
      availableBodyBudget,
    );
  } else {
    sectionBody = trimDistilledSectionContent(
      rawValue,
      Math.min(sectionConfig.maxChars, availableBodyBudget),
    );
  }

  if (!sectionBody.trim()) {
    return '';
  }

  return `${sectionHeader}${sectionBody}`;
}

export function formatMemoryBlocksAsXml(blocks: ClaudeMdMemoryBlock[]): string {
  const contextSection = formatContextSection();

  if (!blocks || blocks.length === 0) {
    return `${SUBNOTES_SECTION_START}
${contextSection}

${SUBNOTES_MEMORY_START}
<!-- No memory blocks found -->
${SUBNOTES_MEMORY_END}
${SUBNOTES_SECTION_END}`;
  }

  const formattedBlocks = blocks.map((block) => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${SUBNOTES_SECTION_START}
${contextSection}

${SUBNOTES_MEMORY_START}
${formattedBlocks}
${SUBNOTES_MEMORY_END}
${SUBNOTES_SECTION_END}`;
}

export function formatDistilledClaudeMd(blocks: ClaudeMdMemoryBlock[]): string {
  const blockMap = new Map(blocks.map((block) => [block.label, block]));
  const contextSection =
    `${SUBNOTES_CONTEXT_START}\n` +
    `This section is auto-generated from \`.subnotes\` and is a distilled foreground view for Claude.\n` +
    `Canonical memory, transcripts, rules, and history live under \`.subnotes\`.\n` +
    `Do not treat this section as the source of truth.\n` +
    `${SUBNOTES_CONTEXT_END}`;
  const prefix = `${SUBNOTES_SECTION_START}\n${contextSection}\n\n`;
  const suffix = `\n${SUBNOTES_SECTION_END}`;
  let remainingBudget =
    DISTILLED_CLAUDE_MD_MAX_CHARS - prefix.length - suffix.length;
  const renderedSections: string[] = [];
  let omittedDueToBudget = false;

  for (const sectionConfig of DISTILLED_CLAUDE_SECTIONS) {
    if (!hasMeaningfulDistilledValue(blockMap, sectionConfig)) {
      continue;
    }

    const separatorLength = renderedSections.length > 0 ? 2 : 0;
    const sectionBudget = remainingBudget - separatorLength;
    if (sectionBudget < DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET) {
      omittedDueToBudget = true;
      continue;
    }

    const renderedSection = renderDistilledSection(
      sectionConfig,
      blockMap.get(sectionConfig.label),
      sectionBudget,
    );
    if (!renderedSection) {
      omittedDueToBudget = true;
      continue;
    }

    renderedSections.push(renderedSection);
    remainingBudget -= renderedSection.length + separatorLength;
  }

  if (renderedSections.length === 0) {
    const fallbackSection = renderDistilledSection(
      DISTILLED_CLAUDE_SECTIONS[0],
      blockMap.get(DISTILLED_CLAUDE_SECTIONS[0].label),
      remainingBudget,
    );
    if (fallbackSection) {
      renderedSections.push(fallbackSection);
      remainingBudget -= fallbackSection.length;
    }
  }

  if (
    omittedDueToBudget &&
    remainingBudget > DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET
  ) {
    const omissionSection = renderDistilledSection(
      {
        label: '__budget_notice__',
        title: 'Additional Context',
        maxChars: DISTILLED_CLAUDE_MD_OMISSION_NOTICE.length,
        fallback: DISTILLED_CLAUDE_MD_OMISSION_NOTICE,
      },
      undefined,
      remainingBudget - (renderedSections.length > 0 ? 2 : 0),
    );

    if (omissionSection) {
      renderedSections.push(omissionSection);
      remainingBudget -= omissionSection.length + (renderedSections.length > 1 ? 2 : 0);
    }
  }

  const distilledBody =
    renderedSections.length > 0
      ? renderedSections.join('\n\n')
      : '## Active Guidance\nNo distilled subconscious context yet.';

  return `${prefix}${distilledBody}${suffix}`;
}

function resolveClaudeMdBaseDir(projectDir: string): string {
  const config = loadConfig(projectDir);
  return config.projectDir || projectDir;
}

function resolveClaudeMdTargets(projectDir: string): ClaudeMdTargetResolution {
  const baseDir = resolveClaudeMdBaseDir(projectDir);
  const rootClaudeMdPath = path.join(baseDir, ROOT_CLAUDE_MD_PATH);
  const scopedClaudeMdPath = path.join(baseDir, CLAUDE_MD_PATH);
  const rootExists = fs.existsSync(rootClaudeMdPath);
  const scopedExists = fs.existsSync(scopedClaudeMdPath);

  if (rootExists) {
    return {
      baseDir,
      canonicalPath: rootClaudeMdPath,
      canonicalExisted: true,
      alternatePath: scopedExists ? scopedClaudeMdPath : null,
    };
  }

  if (scopedExists) {
    return {
      baseDir,
      canonicalPath: scopedClaudeMdPath,
      canonicalExisted: true,
      alternatePath: null,
    };
  }

  return {
    baseDir,
    canonicalPath: scopedClaudeMdPath,
    canonicalExisted: false,
    alternatePath: null,
  };
}

function getClaudeMdBootstrapContent(): string {
  return `# Project Context\n\n${DISTILLED_CLAUDE_MD_COMMENT}\n`;
}

function upsertGeneratedSubnotesSection(
  existingContent: string,
  subnotesContent: string,
): string {
  const subnotesPattern =
    `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}$`;
  const subnotesRegex = new RegExp(subnotesPattern, 'gm');

  let updatedContent: string;

  if (subnotesRegex.test(existingContent)) {
    subnotesRegex.lastIndex = 0;
    updatedContent = existingContent.replace(subnotesRegex, subnotesContent);
  } else {
    updatedContent =
      existingContent.trimEnd() + '\n\n' + subnotesContent + '\n';
  }

  const messagePattern = /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');
  return updatedContent.trimEnd() + '\n';
}

function stripGeneratedSubnotesContent(existingContent: string): string {
  const patterns = [
    `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}\\n*`,
  ];

  let cleaned = existingContent;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, 'gm');
    cleaned = cleaned.replace(regex, '');
  }

  const messagePatterns = [
    /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm,
  ];

  for (const pattern of messagePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(
    /<!-- (Subconscious|SubNotes) (agent memory|distilled context) is automatically synced below -->\n*/g,
    '',
  );

  const trimmed = cleaned.trim();
  if (!trimmed || trimmed === '# Project Context') {
    return '';
  }

  return `${trimmed}\n`;
}

function cleanGeneratedSubnotesFromClaudeMdFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const existingContent = fs.readFileSync(filePath, 'utf-8');
  const cleanedContent = stripGeneratedSubnotesContent(existingContent);

  if (!cleanedContent) {
    fs.unlinkSync(filePath);
    return;
  }

  if (cleanedContent !== existingContent) {
    fs.writeFileSync(filePath, cleanedContent, 'utf-8');
  }
}

export function updateClaudeMd(projectDir: string, subnotesContent: string): void {
  const claudeMdLockPath = path.join(
    getDurableStateDir(projectDir),
    'claude-md-sync.lock',
  );

  withProcessLock(claudeMdLockPath, () => {
    const targets = resolveClaudeMdTargets(projectDir);
    let existingContent = '';

    if (targets.canonicalExisted) {
      existingContent = fs.readFileSync(targets.canonicalPath, 'utf-8');
    } else {
      const claudeDir = path.dirname(targets.canonicalPath);
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      existingContent = getClaudeMdBootstrapContent();
    }

    const updatedContent = upsertGeneratedSubnotesSection(
      existingContent,
      subnotesContent,
    );

    if (updatedContent === existingContent) {
      if (targets.alternatePath) {
        cleanGeneratedSubnotesFromClaudeMdFile(targets.alternatePath);
      }
      return;
    }

    fs.writeFileSync(targets.canonicalPath, updatedContent, 'utf-8');

    if (targets.alternatePath) {
      cleanGeneratedSubnotesFromClaudeMdFile(targets.alternatePath);
    }
  });
}

export function cleanSubNotesFromClaudeMd(projectDir: string): void {
  const baseDir = resolveClaudeMdBaseDir(projectDir);
  const candidatePaths = [
    path.join(baseDir, ROOT_CLAUDE_MD_PATH),
    path.join(baseDir, CLAUDE_MD_PATH),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      cleanGeneratedSubnotesFromClaudeMdFile(candidatePath);
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  createToolResult,
  defineTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolHandler,
} from './types.js';

const MAX_READ_LINES = 400;
const MAX_OUTPUT_CHARS = 12000;
const MAX_MATCHES = 200;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.subnotes']);
let rgAvailableCache: boolean | null = null;

function truncate(text: string, maxChars: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function hasRipgrep(): boolean {
  if (rgAvailableCache !== null) {
    return rgAvailableCache;
  }
  try {
    const result = spawnSync('rg', ['--version'], { stdio: 'ignore' });
    rgAvailableCache = result.status === 0;
  } catch {
    rgAvailableCache = false;
  }
  return rgAvailableCache;
}

function resolvePathWithinCwd(cwd: string, providedPath: string): string {
  const root = path.resolve(cwd);
  const candidate = path.resolve(
    path.isAbsolute(providedPath) ? providedPath : path.join(root, providedPath),
  );
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path outside cwd is not allowed: ${providedPath}`);
  }
  return candidate;
}

function readFileWithWindow(
  filePath: string,
  offset: number,
  limit: number,
): string {
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('\0')) {
    return 'Binary file detected; cannot render as text.';
  }
  const lines = content.split('\n');
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, limit);
  const window = lines.slice(safeOffset, safeOffset + safeLimit);
  const numbered = window.map((line, idx) => `${safeOffset + idx + 1}: ${line}`);
  return truncate(numbered.join('\n'));
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function listFilesRecursive(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function executeRead(input: Record<string, unknown>, ctx: ToolExecutionContext): ToolExecutionResult {
  const filePathRaw = String(input.file_path ?? input.path ?? '');
  if (!filePathRaw) {
    throw new Error('Read requires file_path');
  }
  const offset = Number.isFinite(Number(input.offset)) ? Number(input.offset) : 0;
  const limit = Number.isFinite(Number(input.limit))
    ? Math.min(Number(input.limit), MAX_READ_LINES)
    : MAX_READ_LINES;
  const fullPath = resolvePathWithinCwd(ctx.cwd, filePathRaw);
  const rendered = readFileWithWindow(fullPath, offset, limit);
  const relPath = path.relative(ctx.cwd, fullPath) || path.basename(fullPath);
  return createToolResult({
    result: `<read_result file="${relPath}" offset="${offset}" limit="${limit}">\n${rendered}\n</read_result>`,
    summary: `Read ${relPath} starting at line ${offset + 1}`,
    metadata: {
      filePath: relPath,
      offset,
      limit,
    },
  });
}

function executeGlob(input: Record<string, unknown>, ctx: ToolExecutionContext): ToolExecutionResult {
  const pattern = String(input.pattern ?? '').trim();
  if (!pattern) {
    throw new Error('Glob requires pattern');
  }
  const basePathRaw = String(input.path ?? '.');
  const basePath = resolvePathWithinCwd(ctx.cwd, basePathRaw);
  let matches: string[] = [];

  if (hasRipgrep()) {
    const rg = spawnSync('rg', ['--files', '-g', pattern, basePath], {
      encoding: 'utf8',
      cwd: ctx.cwd,
    });
    if (rg.status === 0 || rg.status === 1) {
      matches = rg.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_MATCHES);
    } else {
      throw new Error((rg.stderr || 'rg failed').trim());
    }
  } else {
    const regex = globToRegex(pattern.replace(/\\/g, '/'));
    const files = listFilesRecursive(basePath);
    matches = files
      .map((f) => path.relative(ctx.cwd, f).replace(/\\/g, '/'))
      .filter((rel) => regex.test(rel))
      .slice(0, MAX_MATCHES);
  }

  if (matches.length === 0) {
    return createToolResult({
      result: '<glob_result>No files matched.</glob_result>',
      summary: `No files matched ${pattern}`,
      metadata: {
        pattern,
        path: path.relative(ctx.cwd, basePath) || '.',
      },
    });
  }

  return createToolResult({
    result: `<glob_result count="${matches.length}">\n${matches.join('\n')}\n</glob_result>`,
    summary: `Found ${matches.length} files for ${pattern}`,
    metadata: {
      pattern,
      path: path.relative(ctx.cwd, basePath) || '.',
      matchCount: matches.length,
    },
  });
}

function executeGrep(input: Record<string, unknown>, ctx: ToolExecutionContext): ToolExecutionResult {
  const pattern = String(input.pattern ?? '').trim();
  if (!pattern) {
    throw new Error('Grep requires pattern');
  }
  const basePathRaw = String(input.path ?? '.');
  const basePath = resolvePathWithinCwd(ctx.cwd, basePathRaw);
  const glob = typeof input.glob === 'string' ? input.glob.trim() : '';

  if (hasRipgrep()) {
    const args = [
      '-n',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(MAX_MATCHES),
    ];
    if (glob) {
      args.push('-g', glob);
    }
    args.push(pattern, basePath);

    const rg = spawnSync('rg', args, { encoding: 'utf8', cwd: ctx.cwd });
    if (rg.status !== 0 && rg.status !== 1) {
      throw new Error((rg.stderr || 'rg failed').trim());
    }
    const output = rg.stdout.trim();
    const matchCount = output ? output.split('\n').filter(Boolean).length : 0;
    return createToolResult({
      result: output
        ? `<grep_result>\n${truncate(output)}\n</grep_result>`
        : '<grep_result>No matches found.</grep_result>',
      summary: output
        ? `Found ${matchCount} matches for ${pattern}`
        : `No matches found for ${pattern}`,
      metadata: {
        pattern,
        glob,
        path: path.relative(ctx.cwd, basePath) || '.',
        matchCount,
      },
    });
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid regex: ${String(error)}`);
  }

  const files = listFilesRecursive(basePath);
  const globRegex = glob ? globToRegex(glob.replace(/\\/g, '/')) : null;
  const matches: string[] = [];

  for (const filePath of files) {
    const rel = path.relative(ctx.cwd, filePath).replace(/\\/g, '/');
    if (globRegex && !globRegex.test(rel)) {
      continue;
    }

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${rel}:${i + 1}:${lines[i]}`);
        if (matches.length >= MAX_MATCHES) break;
      }
    }
    if (matches.length >= MAX_MATCHES) break;
  }

  return createToolResult({
    result:
      matches.length > 0
        ? `<grep_result>\n${truncate(matches.join('\n'))}\n</grep_result>`
        : '<grep_result>No matches found.</grep_result>',
    summary:
      matches.length > 0
        ? `Found ${matches.length} matches for ${pattern}`
        : `No matches found for ${pattern}`,
    metadata: {
      pattern,
      glob,
      path: path.relative(ctx.cwd, basePath) || '.',
      matchCount: matches.length,
    },
  });
}

const readDefinition = defineTool({
  name: 'Read',
  domain: 'filesystem',
  description: 'Read a file from the repository.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    required: ['file_path'],
  },
  execute: (input, ctx) => executeRead(input, ctx),
});

const readFileAliasDefinition = defineTool({
  name: 'read_file',
  domain: 'filesystem',
  description: 'Legacy alias for reading a file from the repository.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    required: ['path'],
  },
  execute: (input, ctx) => executeRead(input, ctx),
});

const globDefinition = defineTool({
  name: 'Glob',
  domain: 'filesystem',
  description: 'Find files by glob pattern.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['pattern'],
  },
  execute: (input, ctx) => executeGlob(input, ctx),
});

const grepDefinition = defineTool({
  name: 'Grep',
  domain: 'filesystem',
  description: 'Search file contents with regex pattern.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string' },
    },
    required: ['pattern'],
  },
  execute: (input, ctx) => executeGrep(input, ctx),
});

export function getFileToolHandlers(): ToolHandler[] {
  return [
    readDefinition,
    readFileAliasDefinition,
    globDefinition,
    grepDefinition,
  ];
}

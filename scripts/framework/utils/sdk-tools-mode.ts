/**
 * Shared helpers for mode parsing and capability text selection.
 *
 * Keeping these helpers in one file avoids duplicated branching logic
 * across worker prompts, stdout context rendering, and config parsing.
 */

export type ParsedSubNotesMode = 'whisper' | 'full' | 'off';
export type ParsedSdkToolsMode = 'read-only' | 'full' | 'off';

export function parseSubNotesMode(value: unknown): ParsedSubNotesMode {
  if (typeof value !== 'string') {
    return 'whisper';
  }

  switch (value.toLowerCase()) {
    case 'full':
      return 'full';
    case 'off':
      return 'off';
    default:
      return 'whisper';
  }
}

export function parseSdkToolsMode(value: unknown): ParsedSdkToolsMode {
  if (typeof value !== 'string') {
    return 'read-only';
  }

  switch (value.toLowerCase()) {
    case 'full':
      return 'full';
    case 'off':
      return 'off';
    default:
      return 'read-only';
  }
}

export function getWorkerSdkToolsCapabilityLine(
  sdkToolsMode: ParsedSdkToolsMode,
): string {
  switch (sdkToolsMode) {
    case 'full':
      return 'Tool access mode: full (memory tools + local file reading tools).';
    case 'off':
      return 'Tool access mode: off (no file-reading tools; memory tools only).';
    case 'read-only':
    default:
      return 'Tool access mode: read-only (memory tools + safe local file reading tools).';
  }
}

export function getStdoutSdkToolsCapabilityLine(
  sdkToolsMode: ParsedSdkToolsMode,
): string {
  switch (sdkToolsMode) {
    case 'full':
      return 'It can read files, search the web, and make changes to your codebase.';
    case 'off':
      return 'It operates in listen-only mode (memory updates only).';
    case 'read-only':
    default:
      return 'It can read files, search your codebase, and browse the web (read-only).';
  }
}

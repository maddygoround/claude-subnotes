/**
 * Shared helpers for extracting file path fields from tool inputs.
 *
 * Several modules inspect tool payloads for file-oriented routing or
 * heuristics. Centralizing this keeps field-name drift from creating
 * inconsistent behavior.
 */

export const STANDARD_FILE_PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'TargetFile',
  'AbsolutePath',
] as const;

export const EXTENDED_FILE_PATH_FIELDS = [
  ...STANDARD_FILE_PATH_FIELDS,
  'SearchPath',
] as const;

export function extractFilePathsFromToolInput(
  toolInput: unknown,
  fields: readonly string[] = STANDARD_FILE_PATH_FIELDS,
): string[] {
  if (!toolInput || typeof toolInput !== 'object') {
    return [];
  }

  const input = toolInput as Record<string, unknown>;
  const paths: string[] = [];

  for (const field of fields) {
    if (typeof input[field] === 'string') {
      paths.push(input[field] as string);
    }
  }

  return paths;
}

/**
 * Shared text formatting helpers.
 */

export interface TruncateOptions {
  maxChars: number;
  suffix?: string;
}

export function truncateText(
  text: string,
  options: TruncateOptions,
): string {
  const { maxChars, suffix = '...' } = options;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}${suffix}`;
}

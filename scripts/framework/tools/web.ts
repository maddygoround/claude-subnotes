import {
  boundarySignal,
  createToolResult,
  defineTool,
  type ToolExecutionResult,
  type ToolHandler,
} from './types.js';
import { loadConfig } from '../../conversation_utils.js';

interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

function truncate(text: string, maxChars: number = 400): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchViaExa(input: Record<string, unknown>, cwd: string): Promise<WebSearchItem[]> {
  const config = loadConfig(cwd);
  const apiKey = config.exaApiKey;
  if (!apiKey) return [];

  const numResultsRaw = Number(input.num_results ?? 5);
  const numResults = Number.isFinite(numResultsRaw)
    ? Math.min(Math.max(1, numResultsRaw), 10)
    : 5;
  const body = {
    query: String(input.query || ''),
    numResults,
    category: typeof input.category === 'string' ? input.category : undefined,
    includeDomains: Array.isArray(input.include_domains)
      ? input.include_domains.map((d) => String(d))
      : undefined,
    excludeDomains: Array.isArray(input.exclude_domains)
      ? input.exclude_domains.map((d) => String(d))
      : undefined,
    startPublishedDate:
      typeof input.start_date === 'string' ? input.start_date : undefined,
    endPublishedDate:
      typeof input.end_date === 'string' ? input.end_date : undefined,
  };

  const response = await fetchWithTimeout(
    'https://api.exa.ai/search',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    },
    15000,
  );

  if (!response.ok) {
    throw new Error(`Exa search failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; text?: string }>;
  };
  const results = json.results || [];
  return results
    .map((r) => ({
      title: String(r.title || r.url || 'Untitled'),
      url: String(r.url || ''),
      snippet: truncate(String(r.text || '').replace(/\s+/g, ' ').trim()),
    }))
    .filter((r) => r.url);
}

function flattenDuckTopics(topics: unknown[]): Array<{ Text?: string; FirstURL?: string }> {
  const out: Array<{ Text?: string; FirstURL?: string }> = [];
  for (const topic of topics) {
    if (!topic || typeof topic !== 'object') continue;
    const t = topic as {
      Text?: string;
      FirstURL?: string;
      Topics?: unknown[];
    };
    if (t.Text || t.FirstURL) {
      out.push({ Text: t.Text, FirstURL: t.FirstURL });
    }
    if (Array.isArray(t.Topics)) {
      out.push(...flattenDuckTopics(t.Topics));
    }
  }
  return out;
}

async function searchViaDuckDuckGo(
  query: string,
  limit: number,
): Promise<WebSearchItem[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
    query,
  )}&format=json&no_html=1&skip_disambig=0`;
  const response = await fetchWithTimeout(url, { method: 'GET' }, 12000);
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: unknown[];
  };

  const items: WebSearchItem[] = [];
  if (json.AbstractURL) {
    items.push({
      title: json.Heading || 'DuckDuckGo Result',
      url: json.AbstractURL,
      snippet: truncate(String(json.AbstractText || '')),
    });
  }

  const related = Array.isArray(json.RelatedTopics)
    ? flattenDuckTopics(json.RelatedTopics)
    : [];

  for (const topic of related) {
    if (!topic.FirstURL) continue;
    items.push({
      title: String(topic.Text || topic.FirstURL),
      url: topic.FirstURL,
      snippet: truncate(String(topic.Text || '')),
    });
    if (items.length >= limit) break;
  }

  return items.slice(0, limit);
}

async function executeWebSearch(input: Record<string, unknown>, cwd: string): Promise<ToolExecutionResult> {
  const query = String(input.query || '').trim();
  if (!query) {
    throw new Error('web_search requires query');
  }

  const numResultsRaw = Number(input.num_results ?? 5);
  const numResults = Number.isFinite(numResultsRaw)
    ? Math.min(Math.max(1, numResultsRaw), 10)
    : 5;

  let results: WebSearchItem[] = [];
  let backend: 'exa' | 'duckduckgo' = 'exa';
  let fallbackReason = '';
  try {
    results = await searchViaExa(input, cwd);
  } catch {
    fallbackReason = 'Exa search failed';
  }
  if (results.length === 0) {
    backend = 'duckduckgo';
    if (!fallbackReason) {
      const config = loadConfig(cwd);
      fallbackReason = config.exaApiKey
        ? 'Exa returned no results'
        : 'EXA_API_KEY is not configured';
    }
    results = await searchViaDuckDuckGo(query, numResults);
  }

  if (results.length === 0) {
    return createToolResult({
      result: '<web_search_result>No search results found.</web_search_result>',
      summary: `No web results found for ${query}`,
      signals:
        backend === 'duckduckgo'
          ? [
              boundarySignal(`${fallbackReason}; web coverage may be incomplete.`, {
                confidence: 'medium',
                priority: 'medium',
              }),
            ]
          : [],
      metadata: {
        backend,
        query,
        resultCount: 0,
      },
    });
  }

  const rendered = results
    .slice(0, numResults)
    .map((item, idx) => {
      return `${idx + 1}. ${item.title}\nURL: ${item.url}\nSnippet: ${item.snippet}`;
    })
    .join('\n\n');

  return createToolResult({
    result:
      `<web_search_result query="${query.replace(/"/g, '&quot;')}" count="${Math.min(
        results.length,
        numResults,
      )}">\n` +
      `${rendered}\n` +
      `</web_search_result>`,
    summary: `Returned ${Math.min(results.length, numResults)} web results via ${backend}`,
    signals:
      backend === 'duckduckgo'
        ? [
            boundarySignal(`${fallbackReason}; using DuckDuckGo fallback results.`, {
              confidence: 'medium',
              priority: 'medium',
              recommendedAction:
                'Treat the results as useful leads, but verify key claims before storing durable memory.',
            }),
          ]
        : [],
    metadata: {
      backend,
      query,
      resultCount: Math.min(results.length, numResults),
    },
  });
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
}

function stripHtml(html: string): string {
  const title = extractTitle(html);
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  text = truncate(text, 12000);
  if (title) {
    return `Title: ${title}\n\n${text}`;
  }
  return text;
}

async function executeFetchWebpage(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  const urlRaw = String(input.url || '').trim();
  if (!urlRaw) {
    throw new Error('fetch_webpage requires url');
  }

  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    throw new Error(`Invalid URL: ${urlRaw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const response = await fetchWithTimeout(
    parsed.toString(),
    {
      method: 'GET',
      headers: {
        'user-agent': 'claude-reflect/2.0',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    },
    15000,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch URL (${response.status})`);
  }

  const body = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const title = body.includes('<html') ? extractTitle(body) : '';
  const rendered =
    contentType.includes('text/html') || body.includes('<html')
      ? stripHtml(body)
      : truncate(body, 12000);

  return createToolResult({
    result:
      `<fetch_webpage_result url="${parsed.toString().replace(/"/g, '&quot;')}">\n` +
      `${rendered}\n` +
      `</fetch_webpage_result>`,
    summary: title
      ? `Fetched ${title} from ${parsed.hostname}`
      : `Fetched ${parsed.hostname}`,
    metadata: {
      url: parsed.toString(),
      hostname: parsed.hostname,
      contentType,
      title,
    },
  });
}

const webSearchDefinition = defineTool({
  name: 'web_search',
  domain: 'web',
  description: 'Search the web and return concise ranked results.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      num_results: { type: 'integer' },
      category: { type: 'string' },
      include_domains: { type: 'array', items: { type: 'string' } },
      exclude_domains: { type: 'array', items: { type: 'string' } },
      start_date: { type: 'string' },
      end_date: { type: 'string' },
    },
    required: ['query'],
  },
  execute: (input, context) => executeWebSearch(input, context.cwd),
});

const fetchWebpageDefinition = defineTool({
  name: 'fetch_webpage',
  domain: 'web',
  description: 'Fetch a webpage URL and return cleaned textual content.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  },
  execute: (input) => executeFetchWebpage(input),
});

export function getWebToolHandlers(): ToolHandler[] {
  return [webSearchDefinition, fetchWebpageDefinition];
}

/**
 * Exa — anonymous hosted MCP endpoint (`https://mcp.exa.ai/mcp`), no key.
 *
 * The tool answers with a plain-text block, one result per group, shaped as:
 *
 *   Title: <title>
 *   URL: <url>
 *   Published: <date|N/A>
 *   Author: <name|N/A>
 *   Highlights:
 *   <highlight lines…>
 *
 * The parser is line-oriented against that shape rather than a single
 * all-or-nothing regex, so a result missing its `Published` line still
 * yields a source. `N/A` placeholders are treated as absent — carrying them
 * through would put a literal "N/A" in front of the user as a publish date.
 *
 * @module @dsh-app/plugin-websearch/engines/exa
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine, EngineRequest } from './types.ts'
import { callMcpTool } from './mcp.ts'
import { dedupeSources, source } from './types.ts'

const ENDPOINT = 'https://mcp.exa.ai/mcp'
const TOOL = 'web_search_exa'

/** True for a real ISO-ish date; filters Exa's `N/A` and free-text placeholders. */
function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value)
}

/**
 * Parse Exa's text block into sources. Exported for parser tests.
 * Groups start at each `Title:` line; a group without a `URL:` is skipped.
 */
export function parseExa(text: string, limit: number): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const block of text.split(/\n(?=Title:)/)) {
    const url = /^URL: (\S+)$/m.exec(block)?.[1]
    if (url === undefined) continue
    const title = /^Title: (.+)$/m.exec(block)?.[1]?.trim()
    const published = /^Published: (.+)$/m.exec(block)?.[1]?.trim()
    // Highlights run until the next section or the end; `...` is Exa's
    // elision marker and carries no information.
    const highlight = block
      .split(/^Highlights:$/m)[1]
      ?.split('\n')
      .filter(line => line.trim() !== '' && !line.trim().startsWith('...'))
      .slice(0, 3)
      .join(' ')
      .trim()
    sources.push(source(
      url,
      title,
      highlight === undefined || highlight === '' ? undefined : highlight.slice(0, 300),
      published !== undefined && isDate(published) ? published : undefined,
    ))
  }
  return dedupeSources(sources, limit)
}

/** The Exa engine. */
export function exaEngine(): Engine {
  return {
    id: 'exa',
    async run({ query, maxResults, signal }: EngineRequest): Promise<WebSearchSource[]> {
      const text = await callMcpTool(ENDPOINT, TOOL, { query, numResults: maxResults }, signal)
      return parseExa(text, maxResults)
    },
  }
}

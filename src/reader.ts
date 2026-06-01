import * as fs from 'fs'
import * as path from 'path'
import type { LogFormat } from './types.js'

// ─── Format detection ─────────────────────────────────────────────────────────
// Sniff the file extension and first few bytes to determine format.
// This saves the user from having to pass a --format flag.

export function detectFormat(filePath: string, content: string): LogFormat {
    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.json') {
        try {
            // CloudWatch JSON exports are arrays of { timestamp, message } objects
            const sample = JSON.parse(content.slice(0, 1000))
            if (Array.isArray(sample)) {
                const first = sample[0]
                if (first?.timestamp && first?.message) return 'cloudwatch-json'
                // Loki query_range API returns { data: { result: [...] } }
                if (first?.stream && first?.values) return 'loki-json'
            }
        } catch {
            // Not valid JSON — treat as raw
        }
    }

    return 'raw'
}

// ─── Format normalizers ───────────────────────────────────────────────────────
// All formats get normalized to plain text lines:
//   [ISO timestamp] service: message
// The LLM doesn't need structured data — it reads natural language better
// than it reads CSV columns or nested JSON.

function normalizeCloudWatchJSON(content: string): string {
    try {
        const events: Array<{ timestamp: number | string; message: string }> =
            JSON.parse(content)

        return events
            .map(e => {
                // CloudWatch timestamps can be ms epoch (number) or ISO string
                const ts =
                    typeof e.timestamp === 'number'
                        ? new Date(e.timestamp).toISOString()
                        : e.timestamp
                return `[${ts}] ${e.message}`
            })
            .join('\n')
    } catch {
        return content
    }
}

function normalizeLokiJSON(content: string): string {
    try {
        // Loki query_range response shape:
        // { data: { result: [{ stream: { service: "..." }, values: [["ns_timestamp", "line"]] }] } }
        const parsed = JSON.parse(content)
        const result = parsed?.data?.result ?? parsed // handle both wrapped and unwrapped

        if (!Array.isArray(result)) return content

        return result
            .flatMap((stream: { stream: Record<string, string>; values: [string, string][] }) => {
                const labels = Object.entries(stream.stream ?? {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' ')

                return stream.values.map(([nanoTs, line]: [string, string]) => {
                    // Loki timestamps are nanoseconds — convert to ms for Date
                    const ms = Math.floor(Number(nanoTs) / 1_000_000)
                    const ts = new Date(ms).toISOString()
                    return `[${ts}] {${labels}} ${line}`
                })
            })
            .join('\n')
    } catch {
        return content
    }
}

// ─── Main read function ───────────────────────────────────────────────────────

export function readLogFile(filePath: string): {
    content: string
    format: LogFormat
    lineCount: number
} {
    const resolved = path.resolve(filePath)

    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`)
    }

    const stat = fs.statSync(resolved)
    const sizeMB = stat.size / (1024 * 1024)

    // Warn on large files — chunking handles it but user should know
    if (sizeMB > 100) {
        console.warn(
            `Warning: file is ${sizeMB.toFixed(1)}MB. Large files will take longer to analyze.`
        )
    }

    const raw = fs.readFileSync(resolved, 'utf-8')
    const format = detectFormat(filePath, raw)

    let content: string

    switch (format) {
        case 'cloudwatch-json':
            content = normalizeCloudWatchJSON(raw)
            break
        case 'loki-json':
            content = normalizeLokiJSON(raw)
            break
        default:
            content = raw
    }

    const lineCount = content.split('\n').filter(Boolean).length

    return { content, format, lineCount }
}

// ─── Fetch logs from Loki HTTP API ───────────────────────────────────────────
// Stretch goal from the guide — query live logs instead of reading a file.
// Loki's query_range endpoint accepts LogQL and time ranges.

export async function fetchFromLoki(
    lokiUrl: string,
    query: string,
    hours = 1,
    limit = 2000
): Promise<{ content: string; lineCount: number }> {
    const end = Date.now() * 1_000_000          // current time in nanoseconds
    const start = end - hours * 3_600_000_000_000  // N hours ago in nanoseconds

    const url = new URL(`${lokiUrl}/loki/api/v1/query_range`)
    url.searchParams.set('query', query)
    url.searchParams.set('start', String(start))
    url.searchParams.set('end', String(end))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('direction', 'forward')  // oldest first

    const response = await fetch(url.toString())

    if (!response.ok) {
        throw new Error(`Loki API error ${response.status}: ${await response.text()}`)
    }

    type LokiApiResponse = { data: { result: any } };
    const data = await response.json() as LokiApiResponse

    // Normalize Loki's response to plain text lines
    const content = normalizeLokiJSON(JSON.stringify(data.data.result))
    const lineCount = content.split('\n').filter(Boolean).length

    return { content, lineCount }
}
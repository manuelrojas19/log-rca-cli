// ─── Why chunking exists ──────────────────────────────────────────────────────
// LLMs have a fixed context window (max tokens they can "see" at once).
// qwen3:8b = 32k tokens, llama4 = 128k tokens.
// One log line ≈ 100 chars ≈ 25 tokens.
// 200 lines × 25 tokens = 5k tokens — safe with plenty of room for prompt + response.
//
// The tradeoff: smaller chunks = more LLM calls = slower + more cost.
//               bigger chunks = fewer calls but risk hitting context limit.
// 200 lines is a good default. Adjust with --chunk-size.

// ─── Basic line chunker ───────────────────────────────────────────────────────

export function chunkByLines(
    content: string,
    linesPerChunk = 200
): string[] {
    const lines = content.split('\n').filter(line => line.trim().length > 0)

    if (lines.length === 0) {
        throw new Error('Log file is empty or contains only whitespace')
    }

    const chunks: string[] = []

    for (let i = 0; i < lines.length; i += linesPerChunk) {
        const slice = lines.slice(i, i + linesPerChunk)
        chunks.push(slice.join('\n'))
    }

    return chunks
}

// ─── Smart chunker (error-aware) ─────────────────────────────────────────────
// The basic chunker may cut a chunk right in the middle of an error burst,
// sending half the stack trace to chunk 3 and half to chunk 4.
// This smarter version tries to keep error clusters together.
//
// Strategy:
// 1. Scan lines for ERROR/WARN markers
// 2. When we find one, extend the current chunk until the burst ends
// 3. Cap at maxLines to avoid huge chunks

export function chunkSmart(
    content: string,
    targetLines = 200,
    maxLines = 400
): string[] {
    const lines = content.split('\n').filter(line => line.trim().length > 0)
    const chunks: string[] = []
    let current: string[] = []

    const isErrorLine = (line: string) =>
        /\b(ERROR|FATAL|CRITICAL|EXCEPTION|STACKTRACE|at\s+\w+\.\w+)\b/i.test(line)

    for (let i = 0; i < lines.length; i++) {
        current.push(lines[i])

        const reachedTarget = current.length >= targetLines
        const reachedMax = current.length >= maxLines
        const isLast = i === lines.length - 1

        if (isLast) {
            // Always flush whatever remains at end of file
            chunks.push(current.join('\n'))
            break
        }

        if (reachedMax) {
            // Hard cap — flush regardless of error context
            chunks.push(current.join('\n'))
            current = []
            continue
        }

        if (reachedTarget) {
            // At target: only flush if next line is NOT part of an error burst
            const nextLine = lines[i + 1] ?? ''
            const inErrorBurst = isErrorLine(lines[i]) || isErrorLine(nextLine)

            if (!inErrorBurst) {
                chunks.push(current.join('\n'))
                current = []
            }
            // If in error burst: keep going until burst ends or maxLines hit
        }
    }

    return chunks.filter(c => c.trim().length > 0)
}

// ─── Chunk stats (useful for verbose logging) ─────────────────────────────────

export function getChunkStats(chunks: string[]): {
    total: number
    avgLines: number
    minLines: number
    maxLines: number
} {
    const lineCounts = chunks.map(c => c.split('\n').filter(Boolean).length)

    return {
        total: chunks.length,
        avgLines: Math.round(lineCounts.reduce((a, b) => a + b, 0) / lineCounts.length),
        minLines: Math.min(...lineCounts),
        maxLines: Math.max(...lineCounts)
    }
}
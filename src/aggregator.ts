import { z } from 'zod'
import { RCAReportLLMSchema } from './types'
import { stripFences } from './analyzer'
import type { ChunkAnalysis, RCAReport } from './types'

// ─── Severity ranking ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3
}

interface OllamaResponse {
    message: {
        role: string
        content: string
    }
    done: boolean
    total_duration?: number
}

function highestSeverity(
    chunks: ChunkAnalysis[]
): 'critical' | 'high' | 'medium' | 'low' {
    return chunks.reduce(
        (worst, chunk) =>
            SEVERITY_RANK[chunk.severity] > SEVERITY_RANK[worst]
                ? chunk.severity
                : worst,
        'low' as 'critical' | 'high' | 'medium' | 'low'
    )
}

// ─── Dedup while preserving order ────────────────────────────────────────────

function dedup(items: string[]): string[] {
    return [...new Set(items.filter(Boolean))]
}

// ─── Weighted confidence ──────────────────────────────────────────────────────
// Average confidence across chunks, weighted so higher-severity chunks count more.
// A critical chunk at 0.9 confidence matters more than a low chunk at 0.5.

function weightedConfidence(chunks: ChunkAnalysis[]): number {
    if (chunks.length === 0) return 0

    const weighted = chunks.map(c => c.confidence * (SEVERITY_RANK[c.severity] + 1))
    const weights = chunks.map(c => SEVERITY_RANK[c.severity] + 1)
    const sum = weighted.reduce((a, b) => a + b, 0)
    const totalWeight = weights.reduce((a, b) => a + b, 0)

    return Math.round((sum / totalWeight) * 100) / 100
}

// ─── System prompt ────────────────────────────────────────────────────────────

const AGGREGATION_SYSTEM_PROMPT = `
You are a principal SRE engineer conducting a post-incident review for a distributed system.

You have received multiple partial analyses — each covering a different segment of the same incident logs.
Your job is to synthesize them into ONE coherent Root Cause Analysis.

Reasoning steps (think through these before writing JSON):
1. Find the EARLIEST error across all chunks — that is usually the root cause
2. Identify causal chains: what triggered what across services
3. Build a timeline from the timestamps in the evidence
4. Merge duplicate services, evidence, and actions — remove noise
5. Assign overall severity (worst of all chunks)
6. Be honest with confidence — if chunks contradict each other, lower it

Rules:
- rootCause must be ONE sentence, specific and actionable
- evidence must be actual log lines from the chunk analyses, not paraphrases
- timeline must be chronological (oldest event first)
- confidence reflects your certainty about the root cause (0.0 = guessing, 1.0 = certain)
- If all chunks are severity "low" with no real errors, say so honestly

Respond ONLY with valid JSON. No markdown. No backticks. No explanation.
{
  "overallSeverity": "critical | high | medium | low",
  "affectedServices": ["string"],
  "rootCause": "One specific sentence describing the root cause.",
  "evidence": ["direct log line 1", "direct log line 2"],
  "recommendedActions": ["Concrete action 1", "Concrete action 2"],
  "confidence": 0.0,
  "timeline": [
    { "timestamp": "ISO string or relative", "event": "what happened" }
  ]
}
`

// ─── Fallback: build report from chunks without LLM ──────────────────────────
// If Ollama fails completely, synthesize a report deterministically.
// Less insightful but always works — critical for production reliability.

function buildFallbackReport(
    chunks: ChunkAnalysis[],
    sourceFile: string,
    totalLines: number
): RCAReport {
    // Pick highest-confidence chunk as the primary root cause
    const bestChunk = chunks.reduce(
        (best, c) => (c.confidence > best.confidence ? c : best),
        chunks[0]
    )

    // Build a simple timeline from error patterns across chunks
    const timeline = chunks
        .flatMap(c =>
            c.errorPatterns.map(p => ({
                timestamp: p.firstSeen,
                event: `${p.pattern} (${p.count}x)`
            }))
        )
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    return {
        generatedAt: new Date().toISOString(),
        sourceFile,
        totalLines,
        chunksAnalyzed: chunks.length,
        overallSeverity: highestSeverity(chunks),
        affectedServices: dedup(chunks.flatMap(c => c.affectedServices)),
        rootCause: bestChunk?.rootCause ?? 'Could not determine root cause',
        evidence: dedup(chunks.flatMap(c => c.evidence)).slice(0, 10),
        recommendedActions: dedup(chunks.flatMap(c => c.recommendedActions)),
        confidence: 0,   // explicitly 0 — this is fallback, not real analysis
        timeline,
        rawChunks: chunks
    }
}

// ─── Main aggregator ──────────────────────────────────────────────────────────

export async function aggregateChunks(
    chunks: ChunkAnalysis[],
    sourceFile: string,
    totalLines: number,
    model = 'qwen3',
    ollamaUrl = 'http://localhost:11434',
    verbose = false
): Promise<RCAReport> {

    // Edge case: only one chunk — skip aggregation LLM call, promote it directly
    if (chunks.length === 1) {
        const c = chunks[0]
        return {
            generatedAt: new Date().toISOString(),
            sourceFile,
            totalLines,
            chunksAnalyzed: 1,
            overallSeverity: c.severity,
            affectedServices: c.affectedServices,
            rootCause: c.rootCause,
            evidence: c.evidence,
            recommendedActions: c.recommendedActions,
            confidence: c.confidence,
            timeline: c.errorPatterns.map(p => ({
                timestamp: p.firstSeen,
                event: `${p.pattern} detected (${p.count} occurrences)`
            })),
            rawChunks: chunks
        }
    }

    // Serialize chunk analyses — we send summaries, not raw logs
    // This keeps the aggregation prompt small regardless of how many chunks there are
    const summary = chunks
        .map(
            (c, i) =>
                `=== Chunk ${i + 1} (severity: ${c.severity}, confidence: ${c.confidence}) ===\n` +
                JSON.stringify(c, null, 2)
        )
        .join('\n\n')

    if (verbose) {
        console.log(`  Aggregating ${chunks.length} chunk analyses...`)
    }

    const maxRetries = 3
    let lastError: unknown

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(`${ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    stream: false,
                    options: {
                        temperature: 0.1,
                        num_predict: 2048   // aggregation may produce more text than per-chunk
                    },
                    messages: [
                        { role: 'system', content: AGGREGATION_SYSTEM_PROMPT },
                        {
                            role: 'user',
                            content:
                                `Here are the analyses of ${chunks.length} log chunks from the same incident:\n\n` +
                                summary +
                                '\n\nSynthesize these into a single RCA report.'
                        }
                    ]
                })
            })

            if (!response.ok) {
                throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`)
            }

            const data = await response.json()
            const raw: string = (data as OllamaResponse).message?.content ?? ''

            if (!raw.trim()) {
                throw new Error('Ollama returned empty content')
            }

            const cleaned = stripFences(raw)
            const parsed = JSON.parse(cleaned)
            const validated = RCAReportLLMSchema.parse(parsed)

            // Assemble final report — merge LLM reasoning with our own computed fields
            const report: RCAReport = {
                // Metadata we compute — never trust LLM for these
                generatedAt: new Date().toISOString(),
                sourceFile,
                totalLines,
                chunksAnalyzed: chunks.length,

                // From the LLM
                overallSeverity: validated.overallSeverity,
                rootCause: validated.rootCause,
                confidence: validated.confidence,
                timeline: validated.timeline,

                // Union LLM output with chunk data + dedup
                // LLM might miss some services that individual chunks caught
                affectedServices: dedup([
                    ...validated.affectedServices,
                    ...chunks.flatMap(c => c.affectedServices)
                ]),
                evidence: dedup([
                    ...validated.evidence,
                    ...chunks.flatMap(c => c.evidence)
                ]).slice(0, 10), // cap at 10 — reports become unreadable beyond this

                recommendedActions: dedup([
                    ...validated.recommendedActions,
                    ...chunks.flatMap(c => c.recommendedActions)
                ]),

                // Always keep raw chunks — useful for debugging low-confidence reports
                rawChunks: chunks
            }

            return report

        } catch (err) {
            lastError = err

            if (verbose || attempt === maxRetries) {
                console.warn(`  Aggregation attempt ${attempt}/${maxRetries} failed:`)

                if (err instanceof SyntaxError) {
                    console.warn(`    JSON parse error: ${err.message}`)
                } else if (err instanceof z.ZodError) {
                    console.warn(`    Schema errors:`)
                    err.errors.forEach(e =>
                        console.warn(`      ${e.path.join('.')}: ${e.message}`)
                    )
                } else if (err instanceof Error) {
                    console.warn(`    ${err.message}`)
                }
            }

            if (attempt < maxRetries) {
                await new Promise(res => setTimeout(res, 2000 * attempt))
            }
        }
    }

    console.warn(`  All aggregation attempts failed — using heuristic fallback`)
    void lastError
    return buildFallbackReport(chunks, sourceFile, totalLines)
}
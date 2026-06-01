import { z } from 'zod'

// ─── Zod Schemas (single source of truth) ─────────────────────────────────────
// Define schemas with Zod first, then derive TypeScript types from them.
// This means you never have a mismatch between your type and your validator.

export const ChunkAnalysisSchema = z.object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    affectedServices: z.array(z.string()),
    errorPatterns: z.array(
        z.object({
            pattern: z.string(),
            count: z.number(),
            firstSeen: z.string()
        })
    ),
    rootCause: z.string(),
    evidence: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    recommendedActions: z.array(z.string())
})

export const RCAReportLLMSchema = z.object({
    overallSeverity: z.enum(['critical', 'high', 'medium', 'low']),
    affectedServices: z.array(z.string()),
    rootCause: z.string(),
    evidence: z.array(z.string()),
    recommendedActions: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    timeline: z.array(
        z.object({
            timestamp: z.string(),
            event: z.string()
        })
    )
})

// ─── TypeScript Types (derived from Zod — never duplicated) ──────────────────

export type ChunkAnalysis = z.infer<typeof ChunkAnalysisSchema>
export type RCAReportLLM = z.infer<typeof RCAReportLLMSchema>

// RCAReport extends the LLM output with metadata we compute ourselves
export interface RCAReport extends RCAReportLLM {
    generatedAt: string
    sourceFile: string
    totalLines: number
    chunksAnalyzed: number
    rawChunks: ChunkAnalysis[]
}

// ─── CLI Options ──────────────────────────────────────────────────────────────

export interface CLIOptions {
    file: string
    format: 'markdown' | 'json'
    model: string
    chunkSize: number   // lines per chunk
    output?: string     // if set, write to file instead of stdout
    verbose: boolean
    lokiQuery?: string  // optional: fetch logs from Loki instead of a file
    lokiUrl?: string
    lokiHours?: number
}

// ─── Log formats we can handle ────────────────────────────────────────────────
export type LogFormat = 'raw' | 'cloudwatch-json' | 'loki-json'
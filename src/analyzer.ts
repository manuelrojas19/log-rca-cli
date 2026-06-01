import { z } from 'zod'
import { ChunkAnalysisSchema } from './types'
import type { ChunkAnalysis } from './types'

// ─── Ollama API types ─────────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaRequest {
  model: string
  stream: boolean
  options: {
    temperature: number
    num_predict: number
  }
  messages: OllamaMessage[]
}

interface OllamaResponse {
  message: {
    role: string
    content: string
  }
  done: boolean
  total_duration?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function stripFences(raw: string): string {
  // Models sometimes wrap JSON in ```json ... ``` even when told not to
  return raw
    .replace(/^```json\s*/gim, '')
    .replace(/^```\s*/gim, '')
    .trim()
}

function buildFallbackChunk(chunkIndex: number, raw: string): ChunkAnalysis {
  // Called when all retries fail. Returns a safe neutral result
  // so the pipeline can continue rather than crash.
  return {
    severity: 'low',
    affectedServices: [],
    errorPatterns: [],
    rootCause: `Failed to analyze chunk ${chunkIndex + 1} — review manually`,
    evidence: [raw.slice(0, 300)],
    confidence: 0,
    recommendedActions: ['Review this log section manually']
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
// The prompt is the most important engineering artifact in this project.
// Rules encoded here:
// 1. Role: senior SRE — gives the model context on what kind of analysis to produce
// 2. Explicit reasoning steps — forces chain-of-thought before outputting JSON
// 3. Strict JSON schema — copy-pasted so model knows exact field names/types
// 4. "No markdown" instruction repeated twice — models forget this

const CHUNK_SYSTEM_PROMPT = `
You are a senior SRE engineer specializing in root cause analysis for distributed backend systems.
You have deep expertise in microservices, Kubernetes, AWS, and cloud-native observability.

Analyze the provided log chunk and identify operational issues.

Think through these steps before writing JSON:
1. Scan for ERROR, WARN, FATAL, EXCEPTION keywords
2. Count how many times each error pattern appears
3. Find the EARLIEST error — this is often the root cause, not the latest
4. Identify which services are affected
5. Determine if errors are cascading (service A fails → service B fails)
6. Assess severity: critical=system down, high=major degradation, medium=partial failure, low=warnings only

Rules:
- Base conclusions ONLY on evidence in these logs. Never guess or invent.
- If uncertain, lower your confidence score — do not fake confidence.
- Distinguish root cause from symptoms (e.g. "HTTP 503" = symptom, "connection pool exhausted" = cause).
- evidence[] must contain ACTUAL log lines copied verbatim, not paraphrases.
- If no errors are found, return severity "low" and rootCause "No errors detected in this chunk".

Respond ONLY with a valid JSON object. No markdown. No backticks. No explanation before or after.
Exactly this shape:
{
  "severity": "critical",
  "affectedServices": ["service-name"],
  "errorPatterns": [
    { "pattern": "Connection pool exhausted", "count": 12, "firstSeen": "2024-01-15T10:23:01Z" }
  ],
  "rootCause": "One sentence describing the actual cause, not the symptoms.",
  "evidence": ["exact log line 1", "exact log line 2"],
  "confidence": 0.85,
  "recommendedActions": ["Increase DB connection pool size", "Add circuit breaker"]
}
`

// ─── Single chunk analyzer ────────────────────────────────────────────────────

export async function analyzeChunk(
  chunk: string,
  chunkIndex: number,
  model = 'qwen3',
  ollamaUrl = 'http://localhost:11434',
  verbose = false
): Promise<ChunkAnalysis> {
  const maxRetries = 3

  if (verbose) {
    const lineCount = chunk.split('\n').filter(Boolean).length
    console.log(`  [chunk ${chunkIndex + 1}] ${lineCount} lines → calling ${model}...`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const body: OllamaRequest = {
        model,
        stream: false,
        options: {
          temperature: 0.1,    // low = deterministic JSON, not creative prose
          num_predict: 1024,   // max tokens for the response
        },
        messages: [
          { role: 'system', content: CHUNK_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Analyze this log chunk (chunk ${chunkIndex + 1}):\n\n<logs>\n${chunk}\n</logs>`
          }
        ]
      }

      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`)
      }

      const data = await response.json() as OllamaResponse
      const raw = data.message?.content ?? ''

      if (!raw.trim()) {
        throw new Error('Ollama returned empty content')
      }

      if (verbose) {
        const duration = data.total_duration
          ? `${(data.total_duration / 1e9).toFixed(1)}s`
          : 'unknown'
        console.log(`  [chunk ${chunkIndex + 1}] response in ${duration}`)
      }

      // Strip markdown fences, then parse + validate
      const cleaned = stripFences(raw)
      const parsed = JSON.parse(cleaned)

      // Zod validates every field — throws ZodError with field-level detail if wrong
      const validated = ChunkAnalysisSchema.parse(parsed)

      return validated

    } catch (err) {
      lastError = err

      if (verbose || attempt === maxRetries) {
        console.warn(`  [chunk ${chunkIndex + 1}] attempt ${attempt}/${maxRetries} failed:`)

        if (err instanceof SyntaxError) {
          console.warn(`    JSON parse error: ${err.message}`)
        } else if (err instanceof z.ZodError) {
          console.warn(`    Schema validation errors:`)
          err.errors.forEach(e =>
            console.warn(`      ${e.path.join('.')}: ${e.message}`)
          )
        } else if (err instanceof Error) {
          console.warn(`    ${err.message}`)
        }
      }

      if (attempt < maxRetries) {
        // Wait before retry — model may still be loading or rate-limited
        await new Promise(res => setTimeout(res, 1500 * attempt))
      }
    }
  }

  // All retries exhausted — return fallback so pipeline continues
  console.warn(`  [chunk ${chunkIndex + 1}] all retries failed, using fallback`)
  return buildFallbackChunk(chunkIndex, String(lastError))
}

// ─── Batch analyzer ───────────────────────────────────────────────────────────
// Processes all chunks sequentially (not parallel).
// Why sequential? Ollama runs one model instance — parallel requests queue anyway,
// and sequential is easier to debug and gives cleaner progress output.

export async function analyzeAllChunks(
  chunks: string[],
  model = 'qwen3',
  ollamaUrl = 'http://localhost:11434',
  verbose = false,
  onProgress?: (completed: number, total: number) => void
): Promise<ChunkAnalysis[]> {
  const results: ChunkAnalysis[] = []

  for (let i = 0; i < chunks.length; i++) {
    const analysis = await analyzeChunk(chunks[i], i, model, ollamaUrl, verbose)
    results.push(analysis)
    onProgress?.(i + 1, chunks.length)
  }

  return results
}
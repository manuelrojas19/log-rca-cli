#!/usr/bin/env node
// ─── CLI entry point ──────────────────────────────────────────────────────────
// Orchestrates the full pipeline:
//   parse args → read logs → chunk → analyze → aggregate → format → output
//
// Usage:
//   ts-node src/cli.ts --file ./logs/app.log
//   ts-node src/cli.ts --file ./logs/app.log --format json --output ./output/rca.json
//   ts-node src/cli.ts --file ./logs/app.log --model llama4 --chunk-size 300 --verbose
//   ts-node src/cli.ts --loki-query '{job="app-logs"} |= "ERROR"' --loki-hours 2

import * as fs from 'fs'
import * as path from 'path'
import { readLogFile, fetchFromLoki } from './reader'
import { chunkByLines, chunkSmart, getChunkStats } from './chunker'
import { analyzeAllChunks } from './analyzer'
import { aggregateChunks } from './aggregator'
import { formatAsMarkdown, formatAsJSON, formatSummary } from './formatter'
import type { CLIOptions } from './types'

// ─── Argument parser ──────────────────────────────────────────────────────────
// Simple manual parser — avoids needing the 'commander' package.
// Supports: --flag value   and   --flag (boolean)

function parseArgs(argv: string[]): CLIOptions {
    const args = argv.slice(2)
    const get = (flag: string): string | undefined => {
        const i = args.indexOf(flag)
        return i !== -1 ? args[i + 1] : undefined
    }
    const has = (flag: string): boolean => args.includes(flag)

    // Validate required args
    const file = get('--file')
    const lokiQuery = get('--loki-query')

    if (!file && !lokiQuery) {
        printUsage()
        process.exit(1)
    }

    const format = (get('--format') ?? 'markdown') as 'markdown' | 'json'
    if (!['markdown', 'json'].includes(format)) {
        console.error(`Error: --format must be "markdown" or "json"`)
        process.exit(1)
    }

    return {
        file: file ?? '',
        format,
        model: get('--model') ?? 'qwen3',
        chunkSize: parseInt(get('--chunk-size') ?? '200', 10),
        output: get('--output'),
        verbose: has('--verbose') || has('-v'),
        lokiQuery,
        lokiUrl: get('--loki-url') ?? 'http://localhost:3100',
        lokiHours: parseInt(get('--loki-hours') ?? '1', 10)
    }
}

function printUsage(): void {
    console.log(`
Usage:
  ts-node src/cli.ts [options]

Required (one of):
  --file <path>           Path to log file (.log, .json, CloudWatch JSON, Loki JSON)
  --loki-query <logql>    LogQL query to fetch logs from Loki

Options:
  --format markdown|json  Output format (default: markdown)
  --output <path>         Write report to file (default: stdout)
  --model <name>          Ollama model to use (default: qwen3)
  --chunk-size <n>        Lines per chunk (default: 200)
  --loki-url <url>        Loki base URL (default: http://localhost:3100)
  --loki-hours <n>        Hours to look back for Loki query (default: 1)
  --verbose / -v          Show detailed progress

Examples:
  ts-node src/cli.ts --file ./logs/app.log
  ts-node src/cli.ts --file ./logs/app.log --format json --output ./output/rca.json
  ts-node src/cli.ts --file ./logs/app.log --model llama4 --chunk-size 300 --verbose
  ts-node src/cli.ts --loki-query '{job="app-logs"} |= "ERROR"' --loki-hours 2
`)
}

// ─── Progress indicator ───────────────────────────────────────────────────────
// Simple text progress — no external dependency needed.

function printProgress(completed: number, total: number): void {
    const pct = Math.round((completed / total) * 100)
    const filled = Math.round(pct / 5)
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)
    process.stdout.write(`\r  Analyzing chunks: [${bar}] ${completed}/${total} (${pct}%)`)
    if (completed === total) process.stdout.write('\n')
}

// ─── Verify Ollama is running ─────────────────────────────────────────────────

async function checkOllama(ollamaUrl: string, model: string): Promise<void> {
    try {
        const response = await fetch(`${ollamaUrl}/api/tags`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        // Parse response JSON with proper typing to avoid 'unknown' errors
        const json = await response.json() as { models?: { name: string }[] }
        const models: string[] = (json.models ?? []).map(m => m.name)

        // Model names in Ollama can have tags like "qwen3:latest"
        const modelInstalled = models.some(m => m.startsWith(model))

        if (!modelInstalled) {
            console.error(`\nError: model "${model}" is not installed in Ollama.`)
            console.error(`Available models: ${models.join(', ') || 'none'}`)
            console.error(`\nInstall it with:\n  ollama pull ${model}\n`)
            process.exit(1)
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes('fetch')) {
            console.error(`\nError: Cannot connect to Ollama at ${ollamaUrl}`)
            console.error(`Make sure Ollama is running:\n  ollama serve\n`)
        } else {
            console.error(`\nOllama check failed:`, err)
        }
        process.exit(1)
    }
}

// ─── Ensure output directory exists ──────────────────────────────────────────

function ensureOutputDir(outputPath: string): void {
    const dir = path.dirname(outputPath)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const opts = parseArgs(process.argv)
    const ollamaUrl = 'http://localhost:11434'

    console.log('\n🔍 Log RCA — AI-powered Root Cause Analysis')
    console.log('─'.repeat(45))
    console.log(`  Model:  ${opts.model}`)
    console.log(`  Format: ${opts.format}`)
    if (opts.lokiQuery) {
        console.log(`  Source: Loki query — ${opts.lokiQuery}`)
        console.log(`  Window: last ${opts.lokiHours} hour(s)`)
    } else {
        console.log(`  Source: ${opts.file}`)
    }
    console.log('')

    // ── Step 0: verify Ollama ────────────────────────────────────────────────
    process.stdout.write('Checking Ollama...')
    await checkOllama(ollamaUrl, opts.model)
    console.log(' ✓')

    // ── Step 1: read logs ─────────────────────────────────────────────────────
    process.stdout.write('Reading logs...')
    let content: string
    let totalLines: number
    let sourceFile: string

    if (opts.lokiQuery) {
        const result = await fetchFromLoki(
            opts.lokiUrl!,
            opts.lokiQuery,
            opts.lokiHours,
        )
        content = result.content
        totalLines = result.lineCount
        sourceFile = `loki:${opts.lokiQuery}`
    } else {
        const result = readLogFile(opts.file)
        content = result.content
        totalLines = result.lineCount
        sourceFile = opts.file
        if (opts.verbose) {
            console.log(` ✓ (format: ${result.format})`)
        }
    }
    console.log(` ✓ ${totalLines.toLocaleString()} lines`)

    if (totalLines === 0) {
        console.error('Error: No log lines found. Is the file empty?')
        process.exit(1)
    }

    // ── Step 2: chunk ─────────────────────────────────────────────────────────
    process.stdout.write('Chunking logs...')
    // Use smart chunker to keep error bursts together
    const chunks = chunkSmart(content, opts.chunkSize, opts.chunkSize * 2)
    const stats = getChunkStats(chunks)
    console.log(` ✓ ${stats.total} chunks (avg ${stats.avgLines} lines each)`)

    if (opts.verbose) {
        console.log(`  min: ${stats.minLines} lines, max: ${stats.maxLines} lines`)
    }

    // ── Step 3: analyze each chunk ────────────────────────────────────────────
    console.log('Analyzing chunks with LLM...')
    const chunkAnalyses = await analyzeAllChunks(
        chunks,
        opts.model,
        ollamaUrl,
        opts.verbose,
        printProgress
    )

    // ── Step 4: aggregate ─────────────────────────────────────────────────────
    console.log('Aggregating results...')
    const report = await aggregateChunks(
        chunkAnalyses,
        sourceFile,
        totalLines,
        opts.model,
        ollamaUrl,
        opts.verbose
    )

    // ── Step 5: format & output ───────────────────────────────────────────────
    const formatted =
        opts.format === 'json'
            ? formatAsJSON(report)
            : formatAsMarkdown(report)

    if (opts.output) {
        ensureOutputDir(opts.output)
        fs.writeFileSync(opts.output, formatted, 'utf-8')
        console.log(formatSummary(report))
        console.log(`\n✅ Full report written to: ${path.resolve(opts.output)}\n`)
    } else {
        // No output file — print full report to stdout
        console.log('\n' + formatted)
    }
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
})
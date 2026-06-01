// scripts/generate-logs.ts
// Generates realistic incident logs for testing the RCA CLI
//
// Run with:
//   ts-node scripts/generate-logs.ts
//   ts-node scripts/generate-logs.ts --scenario db-exhaustion
//   ts-node scripts/generate-logs.ts --scenario memory-leak
//   ts-node scripts/generate-logs.ts --scenario network-partition
//   ts-node scripts/generate-logs.ts --lines 500

import * as fs from 'fs'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts(offsetMs = 0): string {
    return new Date(Date.now() - offsetMs).toISOString()
}

function rand<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]
}

function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

// ─── Scenarios ────────────────────────────────────────────────────────────────
// Each scenario simulates a real-world incident with a clear root cause
// and cascading downstream effects — exactly what good RCA should find.

function dbExhaustionScenario(): string[] {
    // Root cause: DB connection pool exhausted
    // Symptoms: payment failures → 503s → circuit breaker opens
    return [
        `${ts(310000)} INFO  db-proxy      - Connection pool initialized: max=50`,
        `${ts(300000)} WARN  db-proxy      - Connection pool usage high: active=45/50`,
        `${ts(295000)} ERROR db-proxy      - Connection pool exhausted: active=50 waiting=12`,
        `${ts(294500)} ERROR db-proxy      - Connection pool exhausted: active=50 waiting=18`,
        `${ts(294000)} ERROR db-proxy      - Connection pool exhausted: active=50 waiting=23`,
        `${ts(293000)} WARN  db-proxy      - Connection wait time exceeded: 5000ms threshold`,
        `${ts(292000)} ERROR payment-svc   - Failed to acquire DB connection after 3 retries`,
        `${ts(291500)} ERROR payment-svc   - Transaction rollback: timeout waiting for connection`,
        `${ts(291000)} ERROR payment-svc   - Failed to acquire DB connection after 3 retries`,
        `${ts(290000)} ERROR payment-svc   - HTTP 500 returned for POST /api/payments/charge`,
        `${ts(289000)} ERROR api-gateway   - Upstream payment-svc returned 500 (attempt 1/3)`,
        `${ts(288500)} ERROR api-gateway   - Upstream payment-svc returned 500 (attempt 2/3)`,
        `${ts(288000)} ERROR api-gateway   - Upstream payment-svc returned 500 (attempt 3/3)`,
        `${ts(287000)} WARN  api-gateway   - Error rate for payment-svc: 89% over last 60s`,
        `${ts(286000)} ERROR api-gateway   - Circuit breaker OPEN for payment-svc`,
        `${ts(285000)} WARN  auth-svc      - Elevated error rate detected: 42% of sessions failing`,
        `${ts(284000)} ERROR auth-svc      - Session validation failed: dependency payment-svc unavailable`,
        `${ts(283000)} ERROR api-gateway   - 847 requests queued, dropping oldest (queue full)`,
        `${ts(282000)} ERROR api-gateway   - HTTP 503 returned to 1203 clients in last 60s`,
        `${ts(281000)} ERROR monitoring    - SLA breach: payment success rate below 95% threshold`,
    ]
}

function memoryLeakScenario(): string[] {
    // Root cause: memory leak in order-processor causing OOMKill → pod restarts
    return [
        `${ts(400000)} INFO  order-processor - Pod started: memory=512Mi limit=2Gi`,
        `${ts(350000)} INFO  order-processor - Memory usage: 650Mi (32%)`,
        `${ts(300000)} WARN  order-processor - Memory usage: 1.2Gi (60%) — exceeding baseline`,
        `${ts(250000)} WARN  order-processor - Memory usage: 1.6Gi (80%) — GC pressure increasing`,
        `${ts(200000)} WARN  order-processor - Memory usage: 1.85Gi (92%) — critical threshold`,
        `${ts(180000)} ERROR order-processor - GC overhead limit exceeded — JVM spending >90% in GC`,
        `${ts(170000)} ERROR order-processor - OutOfMemoryError: Java heap space`,
        `${ts(165000)} ERROR order-processor - OutOfMemoryError: Java heap space`,
        `${ts(160000)} ERROR kubernetes      - Container order-processor OOMKilled: exit code 137`,
        `${ts(159000)} INFO  kubernetes      - Pod order-processor restarting (restart #1)`,
        `${ts(158000)} ERROR order-queue     - Consumer group lag increasing: 2400 messages pending`,
        `${ts(157000)} WARN  order-queue     - Consumer order-processor is down — messages accumulating`,
        `${ts(120000)} INFO  order-processor - Pod started after restart (memory=512Mi)`,
        `${ts(90000)}  WARN  order-processor - Memory usage: 1.4Gi (70%) — leak persists after restart`,
        `${ts(60000)}  ERROR kubernetes      - Container order-processor OOMKilled: exit code 137`,
        `${ts(59000)}  INFO  kubernetes      - Pod order-processor restarting (restart #2)`,
        `${ts(58000)}  ERROR order-queue     - Consumer group lag critical: 8900 messages pending`,
        `${ts(57000)}  ERROR alerting        - PagerDuty: order processing SLA breach — lag > 5 min`,
    ]
}

function networkPartitionScenario(): string[] {
    // Root cause: network partition between AZ-1 and AZ-2
    // Causes: split-brain in cache, stale reads, eventual data inconsistency
    return [
        `${ts(300000)} INFO  network       - All availability zones healthy`,
        `${ts(250000)} WARN  network       - Increased packet loss detected: az-1 → az-2: 8%`,
        `${ts(240000)} ERROR network       - Network partition detected between az-1 and az-2`,
        `${ts(239000)} ERROR redis-cluster - Node redis-az2-primary unreachable from redis-az1`,
        `${ts(238000)} ERROR redis-cluster - Split-brain detected: two primaries elected`,
        `${ts(237000)} WARN  cache-svc-az1 - Falling back to local cache — cross-AZ sync unavailable`,
        `${ts(236000)} WARN  cache-svc-az2 - Falling back to local cache — cross-AZ sync unavailable`,
        `${ts(230000)} ERROR user-svc      - Stale session data returned: token valid in az-1 but not az-2`,
        `${ts(225000)} ERROR user-svc      - Authentication inconsistency: user logged in on az-1, rejected on az-2`,
        `${ts(220000)} WARN  load-balancer - Session affinity failing: requests routing across AZs`,
        `${ts(215000)} ERROR user-svc      - 403 Forbidden: session token mismatch (cross-AZ)`,
        `${ts(210000)} ERROR data-svc      - Inconsistent reads: record 9921 has different values in az-1 and az-2`,
        `${ts(200000)} ERROR data-svc      - Write conflict detected: concurrent updates from both AZs`,
        `${ts(190000)} WARN  alerting      - Data consistency check failing: 3% of records diverged`,
        `${ts(180000)} ERROR monitoring    - SLA breach: error rate 12% (threshold: 1%)`,
    ]
}

// ─── Background noise generator ───────────────────────────────────────────────
// Real logs are 90% boring INFO traffic. This makes the incident harder to find
// and tests whether the LLM can separate signal from noise.

function generateNoise(count: number): string[] {
    const services = ['api-gateway', 'auth-svc', 'user-svc', 'payment-svc', 'order-processor']
    const methods = ['GET', 'POST', 'PUT', 'DELETE']
    const paths = ['/api/users', '/api/orders', '/api/products', '/api/health', '/api/metrics']
    const statuses = [200, 200, 200, 200, 201, 204]  // weighted toward success

    return Array.from({ length: count }, () => {
        const service = rand(services)
        const method = rand(methods)
        const path = rand(paths)
        const status = rand(statuses)
        const latency = randInt(5, 250)
        const offset = randInt(0, 400000)

        return `${ts(offset)} INFO  ${service.padEnd(15)} - ${method} ${path} → ${status} (${latency}ms) requestId=${Math.random().toString(36).slice(2, 10)}`
    })
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const scenario = args.find(a => a.startsWith('--scenario='))?.split('=')?.[1]
    ?? (args[args.indexOf('--scenario') + 1])
    ?? 'db-exhaustion'
const noiseCount = parseInt(
    args.find(a => a.startsWith('--lines='))?.split('=')?.[1]
    ?? (args[args.indexOf('--lines') + 1])
    ?? '300',
    10
)

const scenarios: Record<string, () => string[]> = {
    'db-exhaustion': dbExhaustionScenario,
    'memory-leak': memoryLeakScenario,
    'network-partition': networkPartitionScenario,
}

if (!scenarios[scenario]) {
    console.error(`Unknown scenario: "${scenario}"`)
    console.error(`Available: ${Object.keys(scenarios).join(', ')}`)
    process.exit(1)
}

const incidentLines = scenarios[scenario]()
const noiseLines = generateNoise(noiseCount)

// Mix incident lines into noise (sorted by timestamp)
const allLines = [...incidentLines, ...noiseLines].sort((a, b) => {
    const tsA = a.match(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/)?.[0] ?? ''
    const tsB = b.match(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/)?.[0] ?? ''
    return tsA.localeCompare(tsB)
})

const outputPath = `./logs/${scenario}.log`
fs.mkdirSync('./logs', { recursive: true })
fs.writeFileSync(outputPath, allLines.join('\n') + '\n', 'utf-8')

console.log(`✅ Generated ${outputPath}`)
console.log(`   Total lines:    ${allLines.length}`)
console.log(`   Incident lines: ${incidentLines.length}`)
console.log(`   Noise lines:    ${noiseLines.length}`)
console.log(`   Scenario:       ${scenario}`)
console.log('')
console.log(`Run analysis:`)
console.log(`  ts-node src/cli.ts --file ${outputPath} --output ./output/${scenario}-rca.md --verbose`)
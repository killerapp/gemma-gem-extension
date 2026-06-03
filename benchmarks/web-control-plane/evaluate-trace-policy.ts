import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANDIDATE_TOOL_NAMES, scoreRecord, type ScoredRecord, type TraceRecord } from './trace-policy-scoring'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.training.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'trace-policy-baseline.md')

type PairwiseStats = {
  correct: number
  total: number
  accuracy: number
  minMargin: number
}

type PolicyResult = {
  name: string
  records: ScoredRecord[]
  pairwise: PairwiseStats
  candidatePairwise: PairwiseStats
  best: { threshold: number; accuracy: number }
}

type PolicyCheckConfig = {
  requireBestPolicy?: string
  minRecords?: number
  minPositive?: number
  minNegative?: number
  minTasks?: number
  minPairwise?: number
  minCandidatePairwise?: number
  minPairwisePairs?: number
  minCandidatePairs?: number
  minCandidateBuckets?: number
  minPairedCandidateBuckets?: number
  minTargetSelectorCandidatePairwise?: number
  minTargetSelectorCandidatePairs?: number
  minTargetSelectorCandidateMargin?: number
  minPairwiseMargin?: number
  minCandidateMargin?: number
  minThresholdAccuracy?: number
  checkOnly: boolean
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): { input: string; output: string; check: PolicyCheckConfig } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_POLICY_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_POLICY_OUTPUT) : DEFAULT_OUTPUT
  const check: PolicyCheckConfig = {
    requireBestPolicy: process.env.GEMMA_GEM_TRACE_POLICY_REQUIRE_BEST,
    minRecords: process.env.GEMMA_GEM_TRACE_POLICY_MIN_RECORDS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_RECORDS, 'GEMMA_GEM_TRACE_POLICY_MIN_RECORDS') : undefined,
    minPositive: process.env.GEMMA_GEM_TRACE_POLICY_MIN_POSITIVE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_POSITIVE, 'GEMMA_GEM_TRACE_POLICY_MIN_POSITIVE') : undefined,
    minNegative: process.env.GEMMA_GEM_TRACE_POLICY_MIN_NEGATIVE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_NEGATIVE, 'GEMMA_GEM_TRACE_POLICY_MIN_NEGATIVE') : undefined,
    minTasks: process.env.GEMMA_GEM_TRACE_POLICY_MIN_TASKS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_TASKS, 'GEMMA_GEM_TRACE_POLICY_MIN_TASKS') : undefined,
    minPairwise: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE') : undefined,
    minCandidatePairwise: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE') : undefined,
    minPairwisePairs: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS') : undefined,
    minCandidatePairs: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS') : undefined,
    minCandidateBuckets: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_BUCKETS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_BUCKETS, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_BUCKETS') : undefined,
    minPairedCandidateBuckets: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRED_CANDIDATE_BUCKETS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRED_CANDIDATE_BUCKETS, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRED_CANDIDATE_BUCKETS') : undefined,
    minTargetSelectorCandidatePairwise: process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRWISE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRWISE, 'GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRWISE') : undefined,
    minTargetSelectorCandidatePairs: process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRS, 'GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_PAIRS') : undefined,
    minTargetSelectorCandidateMargin: process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_MARGIN ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_MARGIN, 'GEMMA_GEM_TRACE_POLICY_MIN_TARGET_SELECTOR_CANDIDATE_MARGIN') : undefined,
    minPairwiseMargin: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_MARGIN ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_MARGIN, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_MARGIN') : undefined,
    minCandidateMargin: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_MARGIN ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_MARGIN, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_MARGIN') : undefined,
    minThresholdAccuracy: process.env.GEMMA_GEM_TRACE_POLICY_MIN_THRESHOLD_ACCURACY ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_THRESHOLD_ACCURACY, 'GEMMA_GEM_TRACE_POLICY_MIN_THRESHOLD_ACCURACY') : undefined,
    checkOnly: false,
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--input') {
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--output') {
      if (!value) throw new Error('--output requires a path')
      output = resolve(value)
      i += 1
    } else if (arg.startsWith('--output=')) {
      output = resolve(arg.slice('--output='.length))
    } else if (arg === '--check-only') {
      check.checkOnly = true
    } else if (arg === '--require-best-policy') {
      if (!value) throw new Error('--require-best-policy requires a policy name')
      check.requireBestPolicy = value
      i += 1
    } else if (arg.startsWith('--require-best-policy=')) {
      check.requireBestPolicy = arg.slice('--require-best-policy='.length)
    } else if (arg === '--min-records') {
      check.minRecords = parseNumber(value, '--min-records')
      i += 1
    } else if (arg.startsWith('--min-records=')) {
      check.minRecords = parseNumber(arg.slice('--min-records='.length), '--min-records')
    } else if (arg === '--min-positive') {
      check.minPositive = parseNumber(value, '--min-positive')
      i += 1
    } else if (arg.startsWith('--min-positive=')) {
      check.minPositive = parseNumber(arg.slice('--min-positive='.length), '--min-positive')
    } else if (arg === '--min-negative') {
      check.minNegative = parseNumber(value, '--min-negative')
      i += 1
    } else if (arg.startsWith('--min-negative=')) {
      check.minNegative = parseNumber(arg.slice('--min-negative='.length), '--min-negative')
    } else if (arg === '--min-tasks') {
      check.minTasks = parseNumber(value, '--min-tasks')
      i += 1
    } else if (arg.startsWith('--min-tasks=')) {
      check.minTasks = parseNumber(arg.slice('--min-tasks='.length), '--min-tasks')
    } else if (arg === '--min-pairwise') {
      check.minPairwise = parseNumber(value, '--min-pairwise')
      i += 1
    } else if (arg.startsWith('--min-pairwise=')) {
      check.minPairwise = parseNumber(arg.slice('--min-pairwise='.length), '--min-pairwise')
    } else if (arg === '--min-candidate-pairwise') {
      check.minCandidatePairwise = parseNumber(value, '--min-candidate-pairwise')
      i += 1
    } else if (arg.startsWith('--min-candidate-pairwise=')) {
      check.minCandidatePairwise = parseNumber(arg.slice('--min-candidate-pairwise='.length), '--min-candidate-pairwise')
    } else if (arg === '--min-pairwise-pairs') {
      check.minPairwisePairs = parseNumber(value, '--min-pairwise-pairs')
      i += 1
    } else if (arg.startsWith('--min-pairwise-pairs=')) {
      check.minPairwisePairs = parseNumber(arg.slice('--min-pairwise-pairs='.length), '--min-pairwise-pairs')
    } else if (arg === '--min-candidate-pairs') {
      check.minCandidatePairs = parseNumber(value, '--min-candidate-pairs')
      i += 1
    } else if (arg.startsWith('--min-candidate-pairs=')) {
      check.minCandidatePairs = parseNumber(arg.slice('--min-candidate-pairs='.length), '--min-candidate-pairs')
    } else if (arg === '--min-candidate-buckets') {
      check.minCandidateBuckets = parseNumber(value, '--min-candidate-buckets')
      i += 1
    } else if (arg.startsWith('--min-candidate-buckets=')) {
      check.minCandidateBuckets = parseNumber(arg.slice('--min-candidate-buckets='.length), '--min-candidate-buckets')
    } else if (arg === '--min-paired-candidate-buckets') {
      check.minPairedCandidateBuckets = parseNumber(value, '--min-paired-candidate-buckets')
      i += 1
    } else if (arg.startsWith('--min-paired-candidate-buckets=')) {
      check.minPairedCandidateBuckets = parseNumber(arg.slice('--min-paired-candidate-buckets='.length), '--min-paired-candidate-buckets')
    } else if (arg === '--min-target-selector-candidate-pairwise') {
      check.minTargetSelectorCandidatePairwise = parseNumber(value, '--min-target-selector-candidate-pairwise')
      i += 1
    } else if (arg.startsWith('--min-target-selector-candidate-pairwise=')) {
      check.minTargetSelectorCandidatePairwise = parseNumber(arg.slice('--min-target-selector-candidate-pairwise='.length), '--min-target-selector-candidate-pairwise')
    } else if (arg === '--min-target-selector-candidate-pairs') {
      check.minTargetSelectorCandidatePairs = parseNumber(value, '--min-target-selector-candidate-pairs')
      i += 1
    } else if (arg.startsWith('--min-target-selector-candidate-pairs=')) {
      check.minTargetSelectorCandidatePairs = parseNumber(arg.slice('--min-target-selector-candidate-pairs='.length), '--min-target-selector-candidate-pairs')
    } else if (arg === '--min-target-selector-candidate-margin') {
      check.minTargetSelectorCandidateMargin = parseNumber(value, '--min-target-selector-candidate-margin')
      i += 1
    } else if (arg.startsWith('--min-target-selector-candidate-margin=')) {
      check.minTargetSelectorCandidateMargin = parseNumber(arg.slice('--min-target-selector-candidate-margin='.length), '--min-target-selector-candidate-margin')
    } else if (arg === '--min-pairwise-margin') {
      check.minPairwiseMargin = parseNumber(value, '--min-pairwise-margin')
      i += 1
    } else if (arg.startsWith('--min-pairwise-margin=')) {
      check.minPairwiseMargin = parseNumber(arg.slice('--min-pairwise-margin='.length), '--min-pairwise-margin')
    } else if (arg === '--min-candidate-margin') {
      check.minCandidateMargin = parseNumber(value, '--min-candidate-margin')
      i += 1
    } else if (arg.startsWith('--min-candidate-margin=')) {
      check.minCandidateMargin = parseNumber(arg.slice('--min-candidate-margin='.length), '--min-candidate-margin')
    } else if (arg === '--min-threshold-accuracy') {
      check.minThresholdAccuracy = parseNumber(value, '--min-threshold-accuracy')
      i += 1
    } else if (arg.startsWith('--min-threshold-accuracy=')) {
      check.minThresholdAccuracy = parseNumber(arg.slice('--min-threshold-accuracy='.length), '--min-threshold-accuracy')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path>, --output <path>, --check-only, and metric threshold options.`)
    }
  }

  return { input, output, check }
}

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

function pairwiseStats(records: ScoredRecord[]): PairwiseStats {
  const positives = records.filter(record => record.label === 'positive')
  const negatives = records.filter(record => record.label === 'negative')
  if (positives.length === 0 || negatives.length === 0) return { correct: 0, total: 0, accuracy: 0, minMargin: 0 }

  let correct = 0
  let total = 0
  let minMargin = Number.POSITIVE_INFINITY
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.task.id !== negative.task.id) continue
      total += 1
      const margin = positive.score - negative.score
      minMargin = Math.min(minMargin, margin)
      if (margin > 0) correct += 1
      else if (margin === 0) correct += 0.5
    }
  }

  return { correct, total, accuracy: total ? correct / total : 0, minMargin: total ? minMargin : 0 }
}

function candidatePairwiseStats(records: ScoredRecord[]): PairwiseStats {
  return pairwiseStats(records.filter(record =>
    Boolean(record.action.selector && record.action.toolName && CANDIDATE_TOOL_NAMES.has(record.action.toolName))
  ))
}

function targetSelectorCandidatePairwiseStats(records: ScoredRecord[]): PairwiseStats {
  return pairwiseStats(records.filter(record =>
    Boolean(
      record.task.targetSelector &&
      record.action.selector &&
      record.action.toolName &&
      CANDIDATE_TOOL_NAMES.has(record.action.toolName),
    )
  ))
}

function candidateBucketKey(record: TraceRecord): string | null {
  if (!record.action.toolName || !CANDIDATE_TOOL_NAMES.has(record.action.toolName)) return null
  if (!record.action.selector) return null
  return `${record.task.id}:${record.action.toolName}`
}

function candidateBucketLabels(records: TraceRecord[]): Map<string, Set<TraceRecord['label']>> {
  const buckets = new Map<string, Set<TraceRecord['label']>>()
  for (const record of records) {
    const key = candidateBucketKey(record)
    if (!key) continue
    const labels = buckets.get(key) ?? new Set<TraceRecord['label']>()
    labels.add(record.label)
    buckets.set(key, labels)
  }
  return buckets
}

function pairedCandidateBuckets(buckets: Map<string, Set<TraceRecord['label']>>): number {
  return [...buckets.values()].filter(labels => labels.has('positive') && labels.has('negative')).length
}

function thresholdAccuracy(records: ScoredRecord[], threshold: number): number {
  if (records.length === 0) return 0
  const correct = records.filter(record => {
    const predicted = record.score >= threshold ? 'positive' : 'negative'
    return predicted === record.label
  }).length
  return correct / records.length
}

function bestThreshold(records: ScoredRecord[]): { threshold: number; accuracy: number } {
  const candidates = [...new Set(records.map(record => record.score))]
    .flatMap(score => [score, score + 0.001])
    .sort((a, b) => a - b)
  let best = { threshold: candidates[0] ?? 0, accuracy: 0 }
  for (const threshold of candidates) {
    const accuracy = thresholdAccuracy(records, threshold)
    if (accuracy > best.accuracy) best = { threshold, accuracy }
  }
  return best
}

function byTask(records: ScoredRecord[]): Map<string, ScoredRecord[]> {
  const result = new Map<string, ScoredRecord[]>()
  for (const record of records) {
    result.set(record.task.id, [...(result.get(record.task.id) ?? []), record])
  }
  return result
}

function evaluatePolicy(name: string, records: TraceRecord[]): PolicyResult {
  const scored = records.map(record => scoreRecord(record, name))
  return {
    name,
    records: scored,
    pairwise: pairwiseStats(scored),
    candidatePairwise: candidatePairwiseStats(scored),
    best: bestThreshold(scored),
  }
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  if (actual + Number.EPSILON < minimum) {
    throw new Error(`${label} ${actual.toFixed(4)} is below required floor ${minimum.toFixed(4)}`)
  }
}

function checkPolicyResult(bestPolicy: PolicyResult, check: PolicyCheckConfig, coverage: {
  records: number
  positives: number
  negatives: number
  tasks: number
  candidateBuckets: number
  pairedCandidateBuckets: number
}): void {
  if (check.requireBestPolicy && bestPolicy.name !== check.requireBestPolicy) {
    throw new Error(`best_policy ${bestPolicy.name} does not match required policy ${check.requireBestPolicy}`)
  }
  assertAtLeast(coverage.records, check.minRecords, 'records')
  assertAtLeast(coverage.positives, check.minPositive, 'positive_records')
  assertAtLeast(coverage.negatives, check.minNegative, 'negative_records')
  assertAtLeast(coverage.tasks, check.minTasks, 'trace_tasks')
  assertAtLeast(bestPolicy.pairwise.accuracy, check.minPairwise, 'pairwise_task_accuracy')
  assertAtLeast(bestPolicy.candidatePairwise.accuracy, check.minCandidatePairwise, 'candidate_pairwise_accuracy')
  assertAtLeast(bestPolicy.pairwise.total, check.minPairwisePairs, 'pairwise_task_pairs')
  assertAtLeast(bestPolicy.candidatePairwise.total, check.minCandidatePairs, 'candidate_pairwise_pairs')
  assertAtLeast(coverage.candidateBuckets, check.minCandidateBuckets, 'candidate_buckets')
  assertAtLeast(coverage.pairedCandidateBuckets, check.minPairedCandidateBuckets, 'paired_candidate_buckets')
  const targetSelectorCandidatePairwise = targetSelectorCandidatePairwiseStats(bestPolicy.records)
  assertAtLeast(targetSelectorCandidatePairwise.accuracy, check.minTargetSelectorCandidatePairwise, 'target_selector_candidate_pairwise_accuracy')
  assertAtLeast(targetSelectorCandidatePairwise.total, check.minTargetSelectorCandidatePairs, 'target_selector_candidate_pairwise_pairs')
  assertAtLeast(targetSelectorCandidatePairwise.minMargin, check.minTargetSelectorCandidateMargin, 'target_selector_candidate_min_margin')
  assertAtLeast(bestPolicy.pairwise.minMargin, check.minPairwiseMargin, 'pairwise_min_margin')
  assertAtLeast(bestPolicy.candidatePairwise.minMargin, check.minCandidateMargin, 'candidate_min_margin')
  assertAtLeast(bestPolicy.best.accuracy, check.minThresholdAccuracy, 'best_threshold_accuracy')
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map(cell => String(cell)).join(' | ')} |`
}

async function main(): Promise<void> {
  const { input, output, check } = parseArgs()
  if (!existsSync(input)) throw new Error(`Training trace source not found: ${input}`)

  const traceRecords = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as TraceRecord)
  const policyResults = [
    evaluatePolicy('lexical', traceRecords),
    evaluatePolicy('semantic_keyword', traceRecords),
  ]
  const bestPolicy = [...policyResults].sort((a, b) =>
    b.candidatePairwise.accuracy - a.candidatePairwise.accuracy ||
    b.pairwise.accuracy - a.pairwise.accuracy ||
    a.name.localeCompare(b.name)
  )[0]

  const positives = traceRecords.filter(record => record.label === 'positive').length
  const negatives = traceRecords.filter(record => record.label === 'negative').length
  const tasks = new Set(traceRecords.map(record => record.task.id))
  const candidateBuckets = candidateBucketLabels(traceRecords)
  const pairedBuckets = pairedCandidateBuckets(candidateBuckets)
  const grouped = byTask(bestPolicy.records)

  const lines: string[] = []
  lines.push('# Trace Policy Baseline')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:policy\` from \`${sourcePath(input)}\`.`)
  lines.push('')
  lines.push('## Metrics')
  lines.push('')
  lines.push(`- records: ${traceRecords.length}`)
  lines.push(`- positive_records: ${positives}`)
  lines.push(`- negative_records: ${negatives}`)
  lines.push(`- trace_tasks: ${tasks.size}`)
  lines.push(`- candidate_buckets: ${candidateBuckets.size}`)
  lines.push(`- paired_candidate_buckets: ${pairedBuckets}`)
  lines.push(`- best_policy: ${bestPolicy.name}`)
  lines.push(`- best_pairwise_task_accuracy: ${bestPolicy.pairwise.accuracy.toFixed(4)}`)
  lines.push(`- best_pairwise_task_pairs: ${bestPolicy.pairwise.total}`)
  lines.push(`- best_pairwise_min_margin: ${bestPolicy.pairwise.minMargin.toFixed(3)}`)
  lines.push(`- best_candidate_pairwise_accuracy: ${bestPolicy.candidatePairwise.accuracy.toFixed(4)}`)
  lines.push(`- best_candidate_pairwise_pairs: ${bestPolicy.candidatePairwise.total}`)
  lines.push(`- best_candidate_min_margin: ${bestPolicy.candidatePairwise.minMargin.toFixed(3)}`)
  const targetSelectorCandidatePairwise = targetSelectorCandidatePairwiseStats(bestPolicy.records)
  lines.push(`- best_target_selector_candidate_pairwise_accuracy: ${targetSelectorCandidatePairwise.accuracy.toFixed(4)}`)
  lines.push(`- best_target_selector_candidate_pairwise_pairs: ${targetSelectorCandidatePairwise.total}`)
  lines.push(`- best_target_selector_candidate_min_margin: ${targetSelectorCandidatePairwise.minMargin.toFixed(3)}`)
  lines.push('')
  lines.push('## Policy Comparison')
  lines.push('')
  lines.push(tableRow(['policy', 'pairwise_task_accuracy', 'pairwise_pairs', 'pairwise_min_margin', 'candidate_pairwise_accuracy', 'candidate_pairs', 'candidate_min_margin', 'best_threshold', 'best_threshold_accuracy']))
  lines.push(tableRow(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:']))
  for (const result of policyResults) {
    lines.push(tableRow([
      result.name,
      result.pairwise.accuracy.toFixed(4),
      result.pairwise.total,
      result.pairwise.minMargin.toFixed(3),
      result.candidatePairwise.accuracy.toFixed(4),
      result.candidatePairwise.total,
      result.candidatePairwise.minMargin.toFixed(3),
      result.best.threshold.toFixed(3),
      result.best.accuracy.toFixed(4),
    ]))
  }
  lines.push('')
  lines.push(`## Task Rankings (${bestPolicy.name})`)
  lines.push('')
  lines.push(tableRow(['task', 'label', 'score', 'tool', 'selector', 'reason']))
  lines.push(tableRow(['---', '---', '---:', '---', '---', '---']))
  for (const [taskId, taskRecords] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const record of [...taskRecords].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))) {
      lines.push(tableRow([
        taskId,
        record.label,
        record.score.toFixed(3),
        record.action.toolName ?? record.action.status,
        record.action.selector ?? '',
        record.reasons.join(', '),
      ]))
    }
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('- These are deterministic policy baselines, not learned rerankers.')
  lines.push('- `pairwise_task_accuracy` scores all trace events, including context reads and planning starts.')
  lines.push('- `candidate_pairwise_accuracy` scores selector-bearing read/click/type candidate actions and is the primary selector/action ranking baseline.')
  lines.push('- Future selector/action policy experiments should beat `candidate_pairwise_accuracy` while preserving benchmark task success.')

  checkPolicyResult(bestPolicy, check, {
    records: traceRecords.length,
    positives,
    negatives,
    tasks: tasks.size,
    candidateBuckets: candidateBuckets.size,
    pairedCandidateBuckets: pairedBuckets,
  })

  if (!check.checkOnly) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${lines.join('\n')}\n`)
  }

  if (!check.checkOnly) console.log(`Wrote trace policy baseline: ${sourcePath(output)}`)
  console.log(`Best policy: ${bestPolicy.name}`)
  console.log(`Records: ${traceRecords.length}`)
  console.log(`Positive records: ${positives}`)
  console.log(`Negative records: ${negatives}`)
  console.log(`Trace tasks: ${tasks.size}`)
  console.log(`Candidate buckets: ${candidateBuckets.size}`)
  console.log(`Paired candidate buckets: ${pairedBuckets}`)
  console.log(`Pairwise task accuracy: ${bestPolicy.pairwise.accuracy.toFixed(4)} (${bestPolicy.pairwise.total} pairs)`)
  console.log(`Pairwise min margin: ${bestPolicy.pairwise.minMargin.toFixed(3)}`)
  console.log(`Candidate pairwise accuracy: ${bestPolicy.candidatePairwise.accuracy.toFixed(4)} (${bestPolicy.candidatePairwise.total} pairs)`)
  console.log(`Candidate min margin: ${bestPolicy.candidatePairwise.minMargin.toFixed(3)}`)
  console.log(`Target selector candidate pairwise accuracy: ${targetSelectorCandidatePairwise.accuracy.toFixed(4)} (${targetSelectorCandidatePairwise.total} pairs)`)
  console.log(`Target selector candidate min margin: ${targetSelectorCandidatePairwise.minMargin.toFixed(3)}`)
  console.log(`Best threshold accuracy: ${bestPolicy.best.accuracy.toFixed(4)}`)
  if (check.checkOnly) console.log('Trace policy gates passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

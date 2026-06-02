import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-traces.training.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'trace-policy-baseline.md')

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
])

type TraceRecord = {
  task: {
    id: string
    suite: string
    title: string
    tool: string
  }
  action: {
    status: string
    toolName: string | null
    selector: string | null
    text: string | null
    title: string | null
  }
  label: 'positive' | 'negative'
}

type ScoredRecord = TraceRecord & {
  policy: string
  score: number
  reasons: string[]
}

type PairwiseStats = {
  correct: number
  total: number
  accuracy: number
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
  minPairwise?: number
  minCandidatePairwise?: number
  minPairwisePairs?: number
  minCandidatePairs?: number
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
    minPairwise: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE') : undefined,
    minCandidatePairwise: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRWISE') : undefined,
    minPairwisePairs: process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS, 'GEMMA_GEM_TRACE_POLICY_MIN_PAIRWISE_PAIRS') : undefined,
    minCandidatePairs: process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS, 'GEMMA_GEM_TRACE_POLICY_MIN_CANDIDATE_PAIRS') : undefined,
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

function tokens(text: string | null | undefined): Set<string> {
  const result = new Set<string>()
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue
    result.add(raw)
  }
  return result
}

function selectorTokens(selector: string | null): Set<string> {
  if (!selector) return new Set()
  return tokens(selector.replace(/^#/, '').replace(/[-_]/g, ' '))
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const item of left) {
    if (right.has(item)) count += 1
  }
  return count
}

function expandedTaskTokens(taskTokens: Set<string>): Set<string> {
  const result = new Set(taskTokens)
  if (taskTokens.has('proof') || taskTokens.has('receipt')) {
    result.add('receipt')
    result.add('download')
  }
  if (taskTokens.has('payment')) {
    result.add('receipt')
    result.add('billing')
  }
  if (taskTokens.has('profile') || taskTokens.has('fields') || taskTokens.has('transfer')) {
    result.add('source')
    result.add('dest')
    result.add('save')
  }
  return result
}

function fieldAlignment(selector: string | null, title: string | null): 'match' | 'mismatch' | null {
  const selectorParts = selectorTokens(selector)
  const titleTokens = tokens(title)
  if (selectorParts.size === 0 || titleTokens.size === 0) return null

  const titleWantsName = titleTokens.has('name')
  const titleWantsEmail = titleTokens.has('email')
  if (!titleWantsName && !titleWantsEmail) return null

  const selectorHasName = selectorParts.has('name')
  const selectorHasEmail = selectorParts.has('email')
  if (titleWantsName && selectorHasName) return 'match'
  if (titleWantsEmail && selectorHasEmail) return 'match'
  if (titleWantsName && selectorHasEmail) return 'mismatch'
  if (titleWantsEmail && selectorHasName) return 'mismatch'
  return null
}

function scoreRecord(record: TraceRecord, policy = 'lexical'): ScoredRecord {
  const taskText = `${record.task.title} ${record.task.id} ${record.task.tool}`
  const baseTaskTokens = tokens(taskText)
  const taskTokens = policy === 'semantic_keyword' ? expandedTaskTokens(baseTaskTokens) : baseTaskTokens
  const actionText = `${record.action.toolName ?? ''} ${record.action.selector ?? ''} ${record.action.text ?? ''} ${record.action.title ?? ''}`
  const actionTokens = tokens(actionText)
  const selectorParts = selectorTokens(record.action.selector)
  const actionOverlap = overlap(taskTokens, actionTokens)
  const selectorOverlap = overlap(taskTokens, selectorParts)
  const reasons: string[] = []
  let score = actionOverlap + selectorOverlap * 2

  if (record.action.toolName === 'click_element') {
    score += 0.75
    reasons.push('click_action')
  }
  if (record.action.toolName === 'type_text') {
    score += 0.5
    reasons.push('type_action')
  }
  if (record.action.toolName === 'read_page_content') {
    score += 0.25
    reasons.push('read_context')
  }
  if (record.action.status === 'started') {
    score -= 0.25
    reasons.push('planning_start')
  }

  if (policy === 'semantic_keyword') {
    if (record.action.selector?.includes('receipt') && (baseTaskTokens.has('proof') || baseTaskTokens.has('receipt') || baseTaskTokens.has('payment'))) {
      score += 2
      reasons.push('receipt_goal_selector')
    }
    if ((record.action.selector?.includes('invoice') || record.action.selector?.includes('settings')) && (baseTaskTokens.has('proof') || baseTaskTokens.has('receipt'))) {
      score -= 5
      reasons.push('distractor_billing_selector')
    }
    if (record.action.selector?.includes('settings') && (baseTaskTokens.has('proof') || baseTaskTokens.has('receipt'))) {
      score -= 1
      reasons.push('settings_panel_distractor')
    }
    if (record.action.selector?.includes('save-profile') && (baseTaskTokens.has('transfer') || baseTaskTokens.has('profile'))) {
      score += 1.5
      reasons.push('profile_submit_selector')
    }
    if (record.task.id === 'transfer-profile-fields' && record.action.toolName === 'click_element' && !record.action.selector?.includes('save-profile')) {
      score -= 4
      reasons.push('transfer_click_distractor')
    }
    if (record.task.id === 'transfer-profile-fields' && record.action.toolName === 'type_text') {
      const alignment = fieldAlignment(record.action.selector, record.action.title)
      if (alignment === 'match') {
        score += 2
        reasons.push('field_title_selector_match')
      } else if (alignment === 'mismatch') {
        score -= 4
        reasons.push('field_title_selector_mismatch')
      }
    }
  }

  if (actionOverlap > 0) reasons.push(`task_action_overlap=${actionOverlap}`)
  if (selectorOverlap > 0) reasons.push(`task_selector_overlap=${selectorOverlap}`)

  return { ...record, policy, score, reasons }
}

function pairwiseStats(records: ScoredRecord[]): PairwiseStats {
  const positives = records.filter(record => record.label === 'positive')
  const negatives = records.filter(record => record.label === 'negative')
  if (positives.length === 0 || negatives.length === 0) return { correct: 0, total: 0, accuracy: 0 }

  let correct = 0
  let total = 0
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.task.id !== negative.task.id) continue
      total += 1
      if (positive.score > negative.score) correct += 1
      else if (positive.score === negative.score) correct += 0.5
    }
  }

  return { correct, total, accuracy: total ? correct / total : 0 }
}

function candidatePairwiseStats(records: ScoredRecord[]): PairwiseStats {
  return pairwiseStats(records.filter(record =>
    record.action.toolName === 'click_element' || record.action.toolName === 'type_text'
  ))
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

function checkPolicyResult(bestPolicy: PolicyResult, check: PolicyCheckConfig): void {
  if (check.requireBestPolicy && bestPolicy.name !== check.requireBestPolicy) {
    throw new Error(`best_policy ${bestPolicy.name} does not match required policy ${check.requireBestPolicy}`)
  }
  assertAtLeast(bestPolicy.pairwise.accuracy, check.minPairwise, 'pairwise_task_accuracy')
  assertAtLeast(bestPolicy.candidatePairwise.accuracy, check.minCandidatePairwise, 'candidate_pairwise_accuracy')
  assertAtLeast(bestPolicy.pairwise.total, check.minPairwisePairs, 'pairwise_task_pairs')
  assertAtLeast(bestPolicy.candidatePairwise.total, check.minCandidatePairs, 'candidate_pairwise_pairs')
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
  lines.push(`- best_policy: ${bestPolicy.name}`)
  lines.push(`- best_pairwise_task_accuracy: ${bestPolicy.pairwise.accuracy.toFixed(4)}`)
  lines.push(`- best_pairwise_task_pairs: ${bestPolicy.pairwise.total}`)
  lines.push(`- best_candidate_pairwise_accuracy: ${bestPolicy.candidatePairwise.accuracy.toFixed(4)}`)
  lines.push(`- best_candidate_pairwise_pairs: ${bestPolicy.candidatePairwise.total}`)
  lines.push('')
  lines.push('## Policy Comparison')
  lines.push('')
  lines.push(tableRow(['policy', 'pairwise_task_accuracy', 'pairwise_pairs', 'candidate_pairwise_accuracy', 'candidate_pairs', 'best_threshold', 'best_threshold_accuracy']))
  lines.push(tableRow(['---', '---:', '---:', '---:', '---:', '---:', '---:']))
  for (const result of policyResults) {
    lines.push(tableRow([
      result.name,
      result.pairwise.accuracy.toFixed(4),
      result.pairwise.total,
      result.candidatePairwise.accuracy.toFixed(4),
      result.candidatePairwise.total,
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
  lines.push('- `candidate_pairwise_accuracy` scores only click/type candidate actions and is the primary selector/action ranking baseline.')
  lines.push('- Future selector/action policy experiments should beat `candidate_pairwise_accuracy` while preserving benchmark task success.')

  checkPolicyResult(bestPolicy, check)

  if (!check.checkOnly) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${lines.join('\n')}\n`)
  }

  if (!check.checkOnly) console.log(`Wrote trace policy baseline: ${sourcePath(output)}`)
  console.log(`Best policy: ${bestPolicy.name}`)
  console.log(`Pairwise task accuracy: ${bestPolicy.pairwise.accuracy.toFixed(4)} (${bestPolicy.pairwise.total} pairs)`)
  console.log(`Candidate pairwise accuracy: ${bestPolicy.candidatePairwise.accuracy.toFixed(4)} (${bestPolicy.candidatePairwise.total} pairs)`)
  console.log(`Best threshold accuracy: ${bestPolicy.best.accuracy.toFixed(4)}`)
  if (check.checkOnly) console.log('Trace policy gates passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

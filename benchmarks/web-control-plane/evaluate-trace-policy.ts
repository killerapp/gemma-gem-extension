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
  score: number
  reasons: string[]
}

function parseArgs(): { input: string; output: string } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_TRAINING_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_POLICY_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_POLICY_OUTPUT) : DEFAULT_OUTPUT

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
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path> and --output <path>.`)
    }
  }

  return { input, output }
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

function scoreRecord(record: TraceRecord): ScoredRecord {
  const taskText = `${record.task.title} ${record.task.id} ${record.task.tool}`
  const taskTokens = tokens(taskText)
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
  if (actionOverlap > 0) reasons.push(`task_action_overlap=${actionOverlap}`)
  if (selectorOverlap > 0) reasons.push(`task_selector_overlap=${selectorOverlap}`)

  return { ...record, score, reasons }
}

function pairwiseAccuracy(records: ScoredRecord[]): number {
  const positives = records.filter(record => record.label === 'positive')
  const negatives = records.filter(record => record.label === 'negative')
  if (positives.length === 0 || negatives.length === 0) return 0

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

  return total ? correct / total : 0
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

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map(cell => String(cell)).join(' | ')} |`
}

async function main(): Promise<void> {
  const { input, output } = parseArgs()
  if (!existsSync(input)) throw new Error(`Training trace source not found: ${input}`)

  const records = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as TraceRecord)
    .map(scoreRecord)

  const positives = records.filter(record => record.label === 'positive').length
  const negatives = records.filter(record => record.label === 'negative').length
  const pairwise = pairwiseAccuracy(records)
  const best = bestThreshold(records)
  const grouped = byTask(records)

  const lines: string[] = []
  lines.push('# Trace Policy Baseline')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:policy\` from \`${sourcePath(input)}\`.`)
  lines.push('')
  lines.push('## Metrics')
  lines.push('')
  lines.push(`- records: ${records.length}`)
  lines.push(`- positive_records: ${positives}`)
  lines.push(`- negative_records: ${negatives}`)
  lines.push(`- pairwise_task_accuracy: ${pairwise.toFixed(4)}`)
  lines.push(`- best_threshold: ${best.threshold.toFixed(3)}`)
  lines.push(`- best_threshold_accuracy: ${best.accuracy.toFixed(4)}`)
  lines.push('')
  lines.push('## Task Rankings')
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
  lines.push('- This is a deterministic lexical baseline, not a learned reranker.')
  lines.push('- Future selector/action policy experiments should beat `pairwise_task_accuracy` while preserving benchmark task success.')

  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${lines.join('\n')}\n`)

  console.log(`Wrote trace policy baseline: ${sourcePath(output)}`)
  console.log(`Pairwise task accuracy: ${pairwise.toFixed(4)}`)
  console.log(`Best threshold accuracy: ${best.accuracy.toFixed(4)}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

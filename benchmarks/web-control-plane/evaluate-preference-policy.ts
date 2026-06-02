import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreRecord, type TraceRecord } from './trace-policy-scoring'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-preferences.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-preferences.policy.md')

type PreferenceAction = {
  sourceFile: string
  index: number
  status: string
  toolName: string
  selector: string
  text: string | null
  title: string | null
}

type PreferenceRecord = {
  recordType: 'web-control-action-preference'
  pairIndex: number
  bucket: {
    taskId: string
    toolName: string
  }
  task: TraceRecord['task']
  preferred: PreferenceAction
  rejected: PreferenceAction
}

type PairScore = {
  pairIndex: number
  taskId: string
  toolName: string
  preferredSelector: string
  rejectedSelector: string
  preferredScore: number
  rejectedScore: number
  margin: number
  correct: number
  preferredReasons: string[]
  rejectedReasons: string[]
}

type PreferencePolicyResult = {
  name: string
  pairs: PairScore[]
  accuracy: number
  minMargin: number
}

type PreferencePolicyCheckConfig = {
  requireBestPolicy?: string
  minAccuracy?: number
  minPairs?: number
  minMargin?: number
  checkOnly: boolean
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): { input: string; output: string; check: PreferencePolicyCheckConfig } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_OUTPUT ? resolve(process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_OUTPUT) : DEFAULT_OUTPUT
  const check: PreferencePolicyCheckConfig = {
    requireBestPolicy: process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_REQUIRE_BEST,
    minAccuracy: process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_ACCURACY ? parseNumber(process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_ACCURACY, 'GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_ACCURACY') : undefined,
    minPairs: process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_PAIRS ? parseNumber(process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_PAIRS, 'GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_PAIRS') : undefined,
    minMargin: process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_MARGIN ? parseNumber(process.env.GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_MARGIN, 'GEMMA_GEM_TRACE_PREFERENCES_POLICY_MIN_MARGIN') : undefined,
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
    } else if (arg === '--min-accuracy') {
      check.minAccuracy = parseNumber(value, '--min-accuracy')
      i += 1
    } else if (arg.startsWith('--min-accuracy=')) {
      check.minAccuracy = parseNumber(arg.slice('--min-accuracy='.length), '--min-accuracy')
    } else if (arg === '--min-pairs') {
      check.minPairs = parseNumber(value, '--min-pairs')
      i += 1
    } else if (arg.startsWith('--min-pairs=')) {
      check.minPairs = parseNumber(arg.slice('--min-pairs='.length), '--min-pairs')
    } else if (arg === '--min-margin') {
      check.minMargin = parseNumber(value, '--min-margin')
      i += 1
    } else if (arg.startsWith('--min-margin=')) {
      check.minMargin = parseNumber(arg.slice('--min-margin='.length), '--min-margin')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path>, --output <path>, --check-only, and metric threshold options.`)
    }
  }

  return { input, output, check }
}

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

function actionRecord(pair: PreferenceRecord, action: PreferenceAction, label: 'positive' | 'negative'): TraceRecord {
  return {
    task: pair.task,
    action: {
      status: action.status,
      toolName: action.toolName,
      selector: action.selector,
      text: action.text,
      title: action.title,
    },
    label,
  }
}

function evaluatePolicy(name: string, preferences: PreferenceRecord[]): PreferencePolicyResult {
  const pairs = preferences.map(pair => {
    const preferred = scoreRecord(actionRecord(pair, pair.preferred, 'positive'), name)
    const rejected = scoreRecord(actionRecord(pair, pair.rejected, 'negative'), name)
    const margin = preferred.score - rejected.score
    return {
      pairIndex: pair.pairIndex,
      taskId: pair.bucket.taskId,
      toolName: pair.bucket.toolName,
      preferredSelector: pair.preferred.selector,
      rejectedSelector: pair.rejected.selector,
      preferredScore: preferred.score,
      rejectedScore: rejected.score,
      margin,
      correct: margin > 0 ? 1 : margin === 0 ? 0.5 : 0,
      preferredReasons: preferred.reasons,
      rejectedReasons: rejected.reasons,
    }
  })
  const correct = pairs.reduce((sum, pair) => sum + pair.correct, 0)
  return {
    name,
    pairs,
    accuracy: pairs.length ? correct / pairs.length : 0,
    minMargin: pairs.length ? Math.min(...pairs.map(pair => pair.margin)) : 0,
  }
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  if (actual + Number.EPSILON < minimum) {
    throw new Error(`${label} ${actual.toFixed(4)} is below required floor ${minimum.toFixed(4)}`)
  }
}

function checkPolicyResult(bestPolicy: PreferencePolicyResult, check: PreferencePolicyCheckConfig): void {
  if (check.requireBestPolicy && bestPolicy.name !== check.requireBestPolicy) {
    throw new Error(`best_policy ${bestPolicy.name} does not match required policy ${check.requireBestPolicy}`)
  }
  assertAtLeast(bestPolicy.accuracy, check.minAccuracy, 'preference_accuracy')
  assertAtLeast(bestPolicy.pairs.length, check.minPairs, 'preference_pairs')
  assertAtLeast(bestPolicy.minMargin, check.minMargin, 'preference_min_margin')
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map(cell => String(cell)).join(' | ')} |`
}

async function main(): Promise<void> {
  const { input, output, check } = parseArgs()
  if (!existsSync(input)) throw new Error(`Preference source not found: ${input}`)

  const preferences = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as PreferenceRecord)
  const policyResults = [
    evaluatePolicy('lexical', preferences),
    evaluatePolicy('semantic_keyword', preferences),
  ]
  const bestPolicy = [...policyResults].sort((a, b) =>
    b.accuracy - a.accuracy ||
    b.minMargin - a.minMargin ||
    a.name.localeCompare(b.name)
  )[0]

  const buckets = new Set(preferences.map(pair => `${pair.bucket.taskId}:${pair.bucket.toolName}`))
  const tasks = new Set(preferences.map(pair => pair.bucket.taskId))

  const lines: string[] = []
  lines.push('# Preference Policy Baseline')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:preferences:policy\` from \`${sourcePath(input)}\`.`)
  lines.push('')
  lines.push('## Metrics')
  lines.push('')
  lines.push(`- preference_pairs: ${preferences.length}`)
  lines.push(`- preference_buckets: ${buckets.size}`)
  lines.push(`- preference_tasks: ${tasks.size}`)
  lines.push(`- best_policy: ${bestPolicy.name}`)
  lines.push(`- best_preference_accuracy: ${bestPolicy.accuracy.toFixed(4)}`)
  lines.push(`- best_preference_min_margin: ${bestPolicy.minMargin.toFixed(3)}`)
  lines.push('')
  lines.push('## Policy Comparison')
  lines.push('')
  lines.push(tableRow(['policy', 'preference_accuracy', 'preference_pairs', 'preference_min_margin']))
  lines.push(tableRow(['---', '---:', '---:', '---:']))
  for (const result of policyResults) {
    lines.push(tableRow([
      result.name,
      result.accuracy.toFixed(4),
      result.pairs.length,
      result.minMargin.toFixed(3),
    ]))
  }
  lines.push('')
  lines.push(`## Pair Rankings (${bestPolicy.name})`)
  lines.push('')
  lines.push(tableRow(['pair', 'task', 'tool', 'preferred', 'rejected', 'margin', 'preferred_reason', 'rejected_reason']))
  lines.push(tableRow(['---:', '---', '---', '---', '---', '---:', '---', '---']))
  for (const pair of bestPolicy.pairs) {
    lines.push(tableRow([
      pair.pairIndex,
      pair.taskId,
      pair.toolName,
      pair.preferredSelector,
      pair.rejectedSelector,
      pair.margin.toFixed(3),
      pair.preferredReasons.join(', '),
      pair.rejectedReasons.join(', '),
    ]))
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('- `preference_accuracy` scores direct preferred/rejected action pairs from the same task and tool bucket.')
  lines.push('- This is the closest current offline metric to a selector/action reranker objective.')
  lines.push('- Future rerankers should beat this deterministic baseline while preserving benchmark task success.')

  checkPolicyResult(bestPolicy, check)

  if (!check.checkOnly) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${lines.join('\n')}\n`)
  }

  if (!check.checkOnly) console.log(`Wrote preference policy baseline: ${sourcePath(output)}`)
  console.log(`Best policy: ${bestPolicy.name}`)
  console.log(`Preference accuracy: ${bestPolicy.accuracy.toFixed(4)} (${bestPolicy.pairs.length} pairs)`)
  console.log(`Preference min margin: ${bestPolicy.minMargin.toFixed(3)}`)
  if (check.checkOnly) console.log('Preference policy gates passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

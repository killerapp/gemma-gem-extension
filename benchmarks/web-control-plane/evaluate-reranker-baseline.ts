import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreRecord, type TraceRecord } from './trace-policy-scoring'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.preferences.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.baseline.md')
const DEFAULT_EPOCHS = 40

type RerankerAction = {
  sourceFile: string
  index: number
  status: string
  toolName: string
  selector: string
  text: string | null
  title: string | null
}

type RerankerCandidate = {
  id: 'candidate_a' | 'candidate_b'
  action: RerankerAction
}

type RerankerPreferenceRecord = {
  recordType: 'web-control-action-reranker-preference'
  sourceFile: string
  pairIndex: number
  bucket: {
    taskId: string
    toolName: string
  }
  task: TraceRecord['task']
  prompt: string
  candidates: [RerankerCandidate, RerankerCandidate]
  chosen: RerankerCandidate
  rejected: RerankerCandidate
  chosenCompletion: string
  rejectedCompletion: string
}

type PairResult = {
  pairIndex: number
  taskId: string
  toolName: string
  chosenId: string
  rejectedId: string
  chosenSelector: string
  rejectedSelector: string
  chosenScore: number
  rejectedScore: number
  margin: number
  correct: number
}

type PolicyResult = {
  name: string
  accuracy: number
  pairs: PairResult[]
  minMargin: number
}

type CheckConfig = {
  requireBestPolicy?: string
  minPairs?: number
  minSemanticAccuracy?: number
  minLearnedAccuracy?: number
  minLearnedLotoAccuracy?: number
  checkOnly: boolean
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): { input: string; output: string; epochs: number; check: CheckConfig } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_RERANKER_BASELINE_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_BASELINE_OUTPUT) : DEFAULT_OUTPUT
  let epochs = process.env.GEMMA_GEM_RERANKER_BASELINE_EPOCHS ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_EPOCHS, 'GEMMA_GEM_RERANKER_BASELINE_EPOCHS') : DEFAULT_EPOCHS
  const check: CheckConfig = {
    requireBestPolicy: process.env.GEMMA_GEM_RERANKER_BASELINE_REQUIRE_BEST,
    minPairs: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS, 'GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS') : undefined,
    minSemanticAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC, 'GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC') : undefined,
    minLearnedAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED') : undefined,
    minLearnedLotoAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO') : undefined,
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
    } else if (arg === '--epochs') {
      epochs = parseNumber(value, '--epochs')
      i += 1
    } else if (arg.startsWith('--epochs=')) {
      epochs = parseNumber(arg.slice('--epochs='.length), '--epochs')
    } else if (arg === '--check-only') {
      check.checkOnly = true
    } else if (arg === '--require-best-policy') {
      if (!value) throw new Error('--require-best-policy requires a policy name')
      check.requireBestPolicy = value
      i += 1
    } else if (arg.startsWith('--require-best-policy=')) {
      check.requireBestPolicy = arg.slice('--require-best-policy='.length)
    } else if (arg === '--min-pairs') {
      check.minPairs = parseNumber(value, '--min-pairs')
      i += 1
    } else if (arg.startsWith('--min-pairs=')) {
      check.minPairs = parseNumber(arg.slice('--min-pairs='.length), '--min-pairs')
    } else if (arg === '--min-semantic-accuracy') {
      check.minSemanticAccuracy = parseNumber(value, '--min-semantic-accuracy')
      i += 1
    } else if (arg.startsWith('--min-semantic-accuracy=')) {
      check.minSemanticAccuracy = parseNumber(arg.slice('--min-semantic-accuracy='.length), '--min-semantic-accuracy')
    } else if (arg === '--min-learned-accuracy') {
      check.minLearnedAccuracy = parseNumber(value, '--min-learned-accuracy')
      i += 1
    } else if (arg.startsWith('--min-learned-accuracy=')) {
      check.minLearnedAccuracy = parseNumber(arg.slice('--min-learned-accuracy='.length), '--min-learned-accuracy')
    } else if (arg === '--min-learned-loto-accuracy') {
      check.minLearnedLotoAccuracy = parseNumber(value, '--min-learned-loto-accuracy')
      i += 1
    } else if (arg.startsWith('--min-learned-loto-accuracy=')) {
      check.minLearnedLotoAccuracy = parseNumber(arg.slice('--min-learned-loto-accuracy='.length), '--min-learned-loto-accuracy')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path>, --output <path>, --epochs <n>, --check-only, and metric threshold options.`)
    }
  }

  if (!Number.isInteger(epochs) || epochs < 1) throw new Error('--epochs must be a positive integer')
  return { input, output, epochs, check }
}

function sourcePath(path: string): string {
  return path.replace(REPO_ROOT, '.').replaceAll('\\', '/')
}

function tokens(text: string | null | undefined): string[] {
  const result = new Set<string>()
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue
    result.add(raw)
  }
  return [...result].sort()
}

function selectorTokens(selector: string): string[] {
  return tokens(selector.replace(/^#/, '').replace(/[-_]/g, ' '))
}

function addFeature(features: Map<string, number>, name: string, value = 1): void {
  features.set(name, (features.get(name) ?? 0) + value)
}

function actionFeatures(pair: RerankerPreferenceRecord, action: RerankerAction): Map<string, number> {
  const features = new Map<string, number>()
  const taskTokens = tokens(`${pair.task.id} ${pair.task.title} ${pair.task.tool}`)
  const actionTokens = tokens(`${action.toolName} ${action.selector} ${action.text ?? ''} ${action.title ?? ''}`)
  const selectorParts = selectorTokens(action.selector)

  addFeature(features, `tool=${action.toolName}`)
  addFeature(features, `status=${action.status}`)
  addFeature(features, `task_tool=${pair.task.tool}:${action.toolName}`)
  if (action.selector === 'body') addFeature(features, 'selector=body')
  if (action.selector.startsWith('#source-')) addFeature(features, 'selector_prefix=source')
  if (action.selector.startsWith('#dest-')) addFeature(features, 'selector_prefix=dest')
  if (action.selector.startsWith('#download-')) addFeature(features, 'selector_prefix=download')
  if (action.selector.includes('receipt')) addFeature(features, 'selector_contains=receipt')
  if (action.selector.includes('invoice')) addFeature(features, 'selector_contains=invoice')
  if (action.selector.includes('settings')) addFeature(features, 'selector_contains=settings')
  if (action.selector.includes('save')) addFeature(features, 'selector_contains=save')
  if (action.text?.includes('format=html')) addFeature(features, 'read_format=html')
  if (action.text?.includes('format=text')) addFeature(features, 'read_format=text')

  for (const token of selectorParts) addFeature(features, `selector_token=${token}`)
  for (const token of actionTokens) addFeature(features, `action_token=${token}`)
  for (const taskToken of taskTokens) {
    for (const selectorToken of selectorParts) {
      addFeature(features, `task_selector=${taskToken}:${selectorToken}`)
    }
    for (const actionToken of actionTokens) {
      addFeature(features, `task_action=${taskToken}:${actionToken}`)
    }
  }

  return features
}

function dot(weights: Map<string, number>, features: Map<string, number>): number {
  let score = 0
  for (const [feature, value] of features) score += (weights.get(feature) ?? 0) * value
  return score
}

function updateWeights(weights: Map<string, number>, features: Map<string, number>, sign: 1 | -1): void {
  for (const [feature, value] of features) {
    const next = (weights.get(feature) ?? 0) + sign * value
    if (next === 0) weights.delete(feature)
    else weights.set(feature, next)
  }
}

function trainPerceptron(pairs: RerankerPreferenceRecord[], epochs: number): Map<string, number> {
  const weights = new Map<string, number>()
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let mistakes = 0
    for (const pair of pairs) {
      const chosenFeatures = actionFeatures(pair, pair.chosen.action)
      const rejectedFeatures = actionFeatures(pair, pair.rejected.action)
      if (dot(weights, chosenFeatures) <= dot(weights, rejectedFeatures)) {
        updateWeights(weights, chosenFeatures, 1)
        updateWeights(weights, rejectedFeatures, -1)
        mistakes += 1
      }
    }
    if (mistakes === 0) break
  }
  return weights
}

function actionRecord(pair: RerankerPreferenceRecord, action: RerankerAction, label: 'positive' | 'negative'): TraceRecord {
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

function evaluateSemanticKeyword(pairs: RerankerPreferenceRecord[]): PolicyResult {
  const results = pairs.map(pair => {
    const chosen = scoreRecord(actionRecord(pair, pair.chosen.action, 'positive'), 'semantic_keyword')
    const rejected = scoreRecord(actionRecord(pair, pair.rejected.action, 'negative'), 'semantic_keyword')
    const margin = chosen.score - rejected.score
    return {
      pairIndex: pair.pairIndex,
      taskId: pair.task.id,
      toolName: pair.bucket.toolName,
      chosenId: pair.chosen.id,
      rejectedId: pair.rejected.id,
      chosenSelector: pair.chosen.action.selector,
      rejectedSelector: pair.rejected.action.selector,
      chosenScore: chosen.score,
      rejectedScore: rejected.score,
      margin,
      correct: margin > 0 ? 1 : margin === 0 ? 0.5 : 0,
    }
  })
  return policyResult('semantic_keyword', results)
}

function evaluateLearned(name: string, pairs: RerankerPreferenceRecord[], weights: Map<string, number>): PolicyResult {
  const results = pairs.map(pair => {
    const chosenScore = dot(weights, actionFeatures(pair, pair.chosen.action))
    const rejectedScore = dot(weights, actionFeatures(pair, pair.rejected.action))
    const margin = chosenScore - rejectedScore
    return {
      pairIndex: pair.pairIndex,
      taskId: pair.task.id,
      toolName: pair.bucket.toolName,
      chosenId: pair.chosen.id,
      rejectedId: pair.rejected.id,
      chosenSelector: pair.chosen.action.selector,
      rejectedSelector: pair.rejected.action.selector,
      chosenScore,
      rejectedScore,
      margin,
      correct: margin > 0 ? 1 : margin === 0 ? 0.5 : 0,
    }
  })
  return policyResult(name, results)
}

function policyResult(name: string, pairs: PairResult[]): PolicyResult {
  const correct = pairs.reduce((sum, pair) => sum + pair.correct, 0)
  return {
    name,
    accuracy: pairs.length ? correct / pairs.length : 0,
    pairs,
    minMargin: pairs.length ? Math.min(...pairs.map(pair => pair.margin)) : 0,
  }
}

function evaluateLeaveOneTaskOut(pairs: RerankerPreferenceRecord[], epochs: number): PolicyResult {
  const taskIds = [...new Set(pairs.map(pair => pair.task.id))].sort()
  const results: PairResult[] = []
  for (const taskId of taskIds) {
    const train = pairs.filter(pair => pair.task.id !== taskId)
    const test = pairs.filter(pair => pair.task.id === taskId)
    if (train.length === 0 || test.length === 0) continue
    const weights = trainPerceptron(train, epochs)
    results.push(...evaluateLearned('learned_perceptron_loto', test, weights).pairs)
  }
  return policyResult('learned_perceptron_loto', results.sort((a, b) => a.pairIndex - b.pairIndex))
}

function topWeights(weights: Map<string, number>, limit: number): Array<[string, number]> {
  return [...weights.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  if (actual + Number.EPSILON < minimum) {
    throw new Error(`${label} ${actual.toFixed(4)} is below required floor ${minimum.toFixed(4)}`)
  }
}

function checkResults(results: PolicyResult[], check: CheckConfig): void {
  const best = bestPolicy(results)
  const semantic = results.find(result => result.name === 'semantic_keyword')
  const learned = results.find(result => result.name === 'learned_perceptron')
  const loto = results.find(result => result.name === 'learned_perceptron_loto')
  if (!semantic || !learned || !loto) throw new Error('Missing required reranker baseline results')
  if (check.requireBestPolicy && best.name !== check.requireBestPolicy) {
    throw new Error(`best_policy ${best.name} does not match required policy ${check.requireBestPolicy}`)
  }
  assertAtLeast(semantic.pairs.length, check.minPairs, 'reranker_pairs')
  assertAtLeast(semantic.accuracy, check.minSemanticAccuracy, 'semantic_keyword_accuracy')
  assertAtLeast(learned.accuracy, check.minLearnedAccuracy, 'learned_perceptron_accuracy')
  assertAtLeast(loto.accuracy, check.minLearnedLotoAccuracy, 'learned_perceptron_loto_accuracy')
}

function bestPolicy(results: PolicyResult[]): PolicyResult {
  return [...results].sort((a, b) =>
    b.accuracy - a.accuracy ||
    b.minMargin - a.minMargin ||
    a.name.localeCompare(b.name)
  )[0]
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map(cell => String(cell)).join(' | ')} |`
}

async function main(): Promise<void> {
  const { input, output, epochs, check } = parseArgs()
  if (!existsSync(input)) throw new Error(`Reranker preference source not found: ${input}`)

  const pairs = (await readFile(input, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as RerankerPreferenceRecord)
  const fullWeights = trainPerceptron(pairs, epochs)
  const results = [
    evaluateSemanticKeyword(pairs),
    evaluateLearned('learned_perceptron', pairs, fullWeights),
    evaluateLeaveOneTaskOut(pairs, epochs),
  ]
  const best = bestPolicy(results)
  const buckets = new Set(pairs.map(pair => `${pair.bucket.taskId}:${pair.bucket.toolName}`))
  const tasks = new Set(pairs.map(pair => pair.task.id))

  const lines: string[] = []
  lines.push('# Action Reranker Baseline')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:reranker:baseline\` from \`${sourcePath(input)}\`.`)
  lines.push('')
  lines.push('## Metrics')
  lines.push('')
  lines.push(`- reranker_pairs: ${pairs.length}`)
  lines.push(`- reranker_buckets: ${buckets.size}`)
  lines.push(`- reranker_tasks: ${tasks.size}`)
  lines.push(`- epochs: ${epochs}`)
  lines.push(`- best_policy: ${best.name}`)
  lines.push(`- best_accuracy: ${best.accuracy.toFixed(4)}`)
  lines.push(`- best_min_margin: ${best.minMargin.toFixed(3)}`)
  lines.push('')
  lines.push('## Policy Comparison')
  lines.push('')
  lines.push(tableRow(['policy', 'accuracy', 'pairs', 'min_margin']))
  lines.push(tableRow(['---', '---:', '---:', '---:']))
  for (const result of results) {
    lines.push(tableRow([
      result.name,
      result.accuracy.toFixed(4),
      result.pairs.length,
      result.minMargin.toFixed(3),
    ]))
  }
  lines.push('')
  lines.push('## Learned Weights')
  lines.push('')
  lines.push(tableRow(['feature', 'weight']))
  lines.push(tableRow(['---', '---:']))
  for (const [feature, weight] of topWeights(fullWeights, 24)) {
    lines.push(tableRow([feature, weight.toFixed(3)]))
  }
  lines.push('')
  lines.push('## Pair Rankings (learned_perceptron_loto)')
  lines.push('')
  lines.push(tableRow(['pair', 'task', 'tool', 'chosen', 'rejected', 'margin']))
  lines.push(tableRow(['---:', '---', '---', '---', '---', '---:']))
  const loto = results.find(result => result.name === 'learned_perceptron_loto')
  for (const pair of loto?.pairs ?? []) {
    lines.push(tableRow([
      pair.pairIndex,
      pair.taskId,
      pair.toolName,
      `${pair.chosenId}:${pair.chosenSelector}`,
      `${pair.rejectedId}:${pair.rejectedSelector}`,
      pair.margin.toFixed(3),
    ]))
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('- `semantic_keyword` is the existing deterministic action-policy baseline on the same chosen/rejected pairs.')
  lines.push('- `learned_perceptron` is trained and evaluated on all reranker pairs, so it only proves the current data is linearly separable.')
  lines.push('- `learned_perceptron_loto` trains on all but one task and evaluates the held-out task, giving the first offline generalization check before changing runtime prompts.')

  checkResults(results, check)

  if (!check.checkOnly) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${lines.join('\n')}\n`)
  }

  if (!check.checkOnly) console.log(`Wrote reranker baseline: ${sourcePath(output)}`)
  console.log(`Best policy: ${best.name}`)
  for (const result of results) {
    console.log(`${result.name}: accuracy ${result.accuracy.toFixed(4)} (${result.pairs.length} pairs), min margin ${result.minMargin.toFixed(3)}`)
  }
  if (check.checkOnly) console.log('Reranker baseline gates passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

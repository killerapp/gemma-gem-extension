import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreRecord, type TraceRecord } from './trace-policy-scoring'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.preferences.jsonl')
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.baseline.md')
const DEFAULT_WEIGHTS_OUTPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.weights.json')
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
  suiteId: string
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
  minLearnedLotoMargin?: number
  minLearnedLosoAccuracy?: number
  minLearnedLosoMargin?: number
  checkOnly: boolean
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): { input: string; output: string; weightsOutput: string; epochs: number; check: CheckConfig } {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT) : DEFAULT_INPUT
  let output = process.env.GEMMA_GEM_RERANKER_BASELINE_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_BASELINE_OUTPUT) : DEFAULT_OUTPUT
  let weightsOutput = process.env.GEMMA_GEM_RERANKER_WEIGHTS_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_WEIGHTS_OUTPUT) : DEFAULT_WEIGHTS_OUTPUT
  let epochs = process.env.GEMMA_GEM_RERANKER_BASELINE_EPOCHS ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_EPOCHS, 'GEMMA_GEM_RERANKER_BASELINE_EPOCHS') : DEFAULT_EPOCHS
  const check: CheckConfig = {
    requireBestPolicy: process.env.GEMMA_GEM_RERANKER_BASELINE_REQUIRE_BEST,
    minPairs: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS, 'GEMMA_GEM_RERANKER_BASELINE_MIN_PAIRS') : undefined,
    minSemanticAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC, 'GEMMA_GEM_RERANKER_BASELINE_MIN_SEMANTIC') : undefined,
    minLearnedAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LEARNED') : undefined,
    minLearnedLotoAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO') : undefined,
    minLearnedLotoMargin: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO_MARGIN ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO_MARGIN, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LOTO_MARGIN') : undefined,
    minLearnedLosoAccuracy: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO') : undefined,
    minLearnedLosoMargin: process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO_MARGIN ? parseNumber(process.env.GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO_MARGIN, 'GEMMA_GEM_RERANKER_BASELINE_MIN_LOSO_MARGIN') : undefined,
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
    } else if (arg === '--weights-output') {
      if (!value) throw new Error('--weights-output requires a path')
      weightsOutput = resolve(value)
      i += 1
    } else if (arg.startsWith('--weights-output=')) {
      weightsOutput = resolve(arg.slice('--weights-output='.length))
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
    } else if (arg === '--min-learned-loto-margin') {
      check.minLearnedLotoMargin = parseNumber(value, '--min-learned-loto-margin')
      i += 1
    } else if (arg.startsWith('--min-learned-loto-margin=')) {
      check.minLearnedLotoMargin = parseNumber(arg.slice('--min-learned-loto-margin='.length), '--min-learned-loto-margin')
    } else if (arg === '--min-learned-loso-accuracy') {
      check.minLearnedLosoAccuracy = parseNumber(value, '--min-learned-loso-accuracy')
      i += 1
    } else if (arg.startsWith('--min-learned-loso-accuracy=')) {
      check.minLearnedLosoAccuracy = parseNumber(arg.slice('--min-learned-loso-accuracy='.length), '--min-learned-loso-accuracy')
    } else if (arg === '--min-learned-loso-margin') {
      check.minLearnedLosoMargin = parseNumber(value, '--min-learned-loso-margin')
      i += 1
    } else if (arg.startsWith('--min-learned-loso-margin=')) {
      check.minLearnedLosoMargin = parseNumber(arg.slice('--min-learned-loso-margin='.length), '--min-learned-loso-margin')
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input <path>, --output <path>, --epochs <n>, --check-only, and metric threshold options.`)
    }
  }

  if (!Number.isInteger(epochs) || epochs < 1) throw new Error('--epochs must be a positive integer')
  return { input, output, weightsOutput, epochs, check }
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

function fieldAlignment(selector: string, title: string | null): 'match' | 'mismatch' | null {
  const selectorParts = new Set(selectorTokens(selector))
  const titleTokens = new Set(tokens(title))
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

function selectorRole(selector: string): 'source' | 'destination' | 'result' | null {
  if (selector.includes('result')) return 'result'
  if (selector.startsWith('#source-') || selector.startsWith('#shipping-') || selector.startsWith('#contact-') || selector.startsWith('#customer-')) return 'source'
  if (selector.startsWith('#dest-') || selector.startsWith('#billing-') || selector.startsWith('#checkout-') || selector.startsWith('#order-')) return 'destination'
  return null
}

function clickRole(selector: string): 'submit' | 'status' | 'field' | null {
  if (selector.includes('save') && !selector.includes('result')) return 'submit'
  if (selector.includes('result')) return 'status'
  if (selector.startsWith('#dest-') || selector.startsWith('#billing-') || selector.startsWith('#checkout-') || selector.startsWith('#order-')) return 'field'
  return null
}

function fieldKind(selector: string): 'name' | 'email' | null {
  const selectorParts = new Set(selectorTokens(selector))
  if (selectorParts.has('name')) return 'name'
  if (selectorParts.has('email')) return 'email'
  return null
}

function expectsFullPageRead(task: RerankerPreferenceRecord['task']): boolean {
  return task.tool === 'gemma_extract' ||
    task.tool === 'gemma_page_brief' ||
    task.tool === 'gemma_agent' ||
    task.tool === 'gemma_observe'
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
  const alignment = fieldAlignment(action.selector, action.title)
  if (alignment) addFeature(features, `field_title_selector=${alignment}`, 3)
  const role = selectorRole(action.selector)
  if (role) {
    addFeature(features, `selector_role=${role}`, 2)
    addFeature(features, `${action.toolName}_selector_role=${role}`, 3)
    if (action.toolName === 'read_page_content' && role === 'result') {
      addFeature(features, 'read_page_content_result_context', 5)
    }
    const field = fieldKind(action.selector)
    if (field) {
      addFeature(features, `${action.toolName}_selector_role_field=${role}:${field}`, 4)
    }
  }
  if (action.toolName === 'click_element') {
    const role = clickRole(action.selector)
    if (role) addFeature(features, `click_role=${role}`, 3)
  }
  if (action.toolName === 'read_page_content' && expectsFullPageRead(pair.task)) {
    addFeature(features, action.selector === 'body' ? 'full_page_read=body' : 'full_page_read=narrow', 5)
  }

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
      suiteId: pair.task.suite,
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
      suiteId: pair.task.suite,
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

function evaluateLeaveOneSuiteOut(pairs: RerankerPreferenceRecord[], epochs: number): PolicyResult {
  const suiteIds = [...new Set(pairs.map(pair => pair.task.suite))].sort()
  const results: PairResult[] = []
  for (const suiteId of suiteIds) {
    const train = pairs.filter(pair => pair.task.suite !== suiteId)
    const test = pairs.filter(pair => pair.task.suite === suiteId)
    if (train.length === 0 || test.length === 0) continue
    const weights = trainPerceptron(train, epochs)
    results.push(...evaluateLearned('learned_perceptron_loso', test, weights).pairs)
  }
  return policyResult('learned_perceptron_loso', results.sort((a, b) => a.pairIndex - b.pairIndex))
}

function topWeights(weights: Map<string, number>, limit: number): Array<[string, number]> {
  return [...weights.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

function sortedWeights(weights: Map<string, number>): Array<{ feature: string; weight: number }> {
  return [...weights.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    .map(([feature, weight]) => ({ feature, weight }))
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
  const loso = results.find(result => result.name === 'learned_perceptron_loso')
  if (!semantic || !learned || !loto || !loso) throw new Error('Missing required reranker baseline results')
  if (check.requireBestPolicy && best.name !== check.requireBestPolicy) {
    throw new Error(`best_policy ${best.name} does not match required policy ${check.requireBestPolicy}`)
  }
  assertAtLeast(semantic.pairs.length, check.minPairs, 'reranker_pairs')
  assertAtLeast(semantic.accuracy, check.minSemanticAccuracy, 'semantic_keyword_accuracy')
  assertAtLeast(learned.accuracy, check.minLearnedAccuracy, 'learned_perceptron_accuracy')
  assertAtLeast(loto.accuracy, check.minLearnedLotoAccuracy, 'learned_perceptron_loto_accuracy')
  assertAtLeast(loto.minMargin, check.minLearnedLotoMargin, 'learned_perceptron_loto_min_margin')
  assertAtLeast(loso.accuracy, check.minLearnedLosoAccuracy, 'learned_perceptron_loso_accuracy')
  assertAtLeast(loso.minMargin, check.minLearnedLosoMargin, 'learned_perceptron_loso_min_margin')
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

function pushPairRankingSection(lines: string[], result: PolicyResult, title: string): void {
  lines.push(`## Pair Rankings (${title})`)
  lines.push('')
  lines.push(tableRow(['pair', 'suite', 'task', 'tool', 'chosen', 'rejected', 'margin']))
  lines.push(tableRow(['---:', '---', '---', '---', '---', '---', '---:']))
  for (const pair of result.pairs) {
    lines.push(tableRow([
      pair.pairIndex,
      pair.suiteId,
      pair.taskId,
      pair.toolName,
      `${pair.chosenId}:${pair.chosenSelector}`,
      `${pair.rejectedId}:${pair.rejectedSelector}`,
      pair.margin.toFixed(3),
    ]))
  }
  lines.push('')
}

function weightsArtifact(input: string, epochs: number, pairs: RerankerPreferenceRecord[], results: PolicyResult[], weights: Map<string, number>): unknown {
  const buckets = new Set(pairs.map(pair => `${pair.bucket.taskId}:${pair.bucket.toolName}`))
  const tasks = new Set(pairs.map(pair => pair.task.id))
  const suites = new Set(pairs.map(pair => pair.task.suite))
  const best = bestPolicy(results)
  return {
    recordType: 'web-control-action-reranker-weights',
    version: 1,
    sourceFile: sourcePath(input),
    generatedBy: 'pnpm benchmark:traces:reranker:baseline',
    model: {
      type: 'pairwise_perceptron',
      featureSet: 'web-control-action-v1',
      epochs,
    },
    training: {
      pairs: pairs.length,
      buckets: buckets.size,
      tasks: tasks.size,
      suites: suites.size,
    },
    metrics: {
      bestPolicy: best.name,
      policies: results.map(result => ({
        name: result.name,
        accuracy: Number(result.accuracy.toFixed(4)),
        pairs: result.pairs.length,
        minMargin: Number(result.minMargin.toFixed(3)),
      })),
    },
    weights: sortedWeights(weights),
  }
}

async function main(): Promise<void> {
  const { input, output, weightsOutput, epochs, check } = parseArgs()
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
    evaluateLeaveOneSuiteOut(pairs, epochs),
  ]
  const best = bestPolicy(results)
  const buckets = new Set(pairs.map(pair => `${pair.bucket.taskId}:${pair.bucket.toolName}`))
  const tasks = new Set(pairs.map(pair => pair.task.id))

  const lines: string[] = []
  lines.push('# Action Reranker Baseline')
  lines.push('')
  lines.push(`This report is generated by \`pnpm benchmark:traces:reranker:baseline\` from \`${sourcePath(input)}\`.`)
  lines.push(`The machine-readable learned weights are written to \`${sourcePath(weightsOutput)}\`.`)
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
  const loto = results.find(result => result.name === 'learned_perceptron_loto')
  const loso = results.find(result => result.name === 'learned_perceptron_loso')
  if (loto) pushPairRankingSection(lines, loto, 'learned_perceptron_loto')
  if (loso) pushPairRankingSection(lines, loso, 'learned_perceptron_loso')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('- `semantic_keyword` is the existing deterministic action-policy baseline on the same chosen/rejected pairs.')
  lines.push('- `learned_perceptron` is trained and evaluated on all reranker pairs, so it only proves the current data is linearly separable.')
  lines.push('- `learned_perceptron_loto` trains on all but one task and evaluates the held-out task, giving the first offline generalization check before changing runtime prompts.')
  lines.push('- `learned_perceptron_loso` trains on all but one suite and evaluates the held-out suite, making supervised-data transfer failures visible before runtime integration.')

  checkResults(results, check)

  if (!check.checkOnly) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${lines.join('\n')}\n`)
    await mkdir(dirname(weightsOutput), { recursive: true })
    await writeFile(weightsOutput, `${JSON.stringify(weightsArtifact(input, epochs, pairs, results, fullWeights), null, 2)}\n`)
  }

  if (!check.checkOnly) console.log(`Wrote reranker baseline: ${sourcePath(output)}`)
  if (!check.checkOnly) console.log(`Wrote reranker weights: ${sourcePath(weightsOutput)}`)
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

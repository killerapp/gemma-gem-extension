import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { learnedMargin, type RerankerPreferenceRecord } from './reranker-scoring'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DEFAULT_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.weights.json')
const DEFAULT_PREFERENCES_INPUT = resolve(REPO_ROOT, 'benchmarks', 'web-control-plane', 'action-reranker.preferences.jsonl')

type WeightRecord = {
  feature?: unknown
  weight?: unknown
}

type PolicyMetric = {
  name?: unknown
  accuracy?: unknown
  pairs?: unknown
  minMargin?: unknown
}

type RerankerWeightsArtifact = {
  recordType?: unknown
  version?: unknown
  sourceFile?: unknown
  generatedBy?: unknown
  model?: {
    type?: unknown
    featureSet?: unknown
    epochs?: unknown
  }
  training?: {
    pairs?: unknown
    buckets?: unknown
    tasks?: unknown
    suites?: unknown
  }
  metrics?: {
    bestPolicy?: unknown
    policies?: unknown
  }
  weights?: unknown
}

type CheckConfig = {
  input: string
  preferencesInput: string
  minPairs?: number
  minWeights?: number
  requiredPolicy?: string
  minPolicyAccuracy?: number
  minPolicyMargin?: number
  minRecomputedAccuracy?: number
  minRecomputedMargin?: number
  requiredFeatures: string[]
}

function parseNumber(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} requires a value`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseArgs(): CheckConfig {
  const args = process.argv.slice(2)
  let input = process.env.GEMMA_GEM_RERANKER_WEIGHTS_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_WEIGHTS_OUTPUT) : DEFAULT_INPUT
  let preferencesInput = process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT ? resolve(process.env.GEMMA_GEM_RERANKER_PREFERENCES_OUTPUT) : DEFAULT_PREFERENCES_INPUT
  let minPairs: number | undefined
  let minWeights: number | undefined
  let requiredPolicy: string | undefined
  let minPolicyAccuracy: number | undefined
  let minPolicyMargin: number | undefined
  let minRecomputedAccuracy: number | undefined
  let minRecomputedMargin: number | undefined
  const requiredFeatures: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const value = args[i + 1]
    if (arg === '--input') {
      if (!value) throw new Error('--input requires a path')
      input = resolve(value)
      i += 1
    } else if (arg.startsWith('--input=')) {
      input = resolve(arg.slice('--input='.length))
    } else if (arg === '--preferences-input') {
      if (!value) throw new Error('--preferences-input requires a path')
      preferencesInput = resolve(value)
      i += 1
    } else if (arg.startsWith('--preferences-input=')) {
      preferencesInput = resolve(arg.slice('--preferences-input='.length))
    } else if (arg === '--min-pairs') {
      minPairs = parseNumber(value, '--min-pairs')
      i += 1
    } else if (arg.startsWith('--min-pairs=')) {
      minPairs = parseNumber(arg.slice('--min-pairs='.length), '--min-pairs')
    } else if (arg === '--min-weights') {
      minWeights = parseNumber(value, '--min-weights')
      i += 1
    } else if (arg.startsWith('--min-weights=')) {
      minWeights = parseNumber(arg.slice('--min-weights='.length), '--min-weights')
    } else if (arg === '--require-policy') {
      if (!value) throw new Error('--require-policy requires a policy name')
      requiredPolicy = value
      i += 1
    } else if (arg.startsWith('--require-policy=')) {
      requiredPolicy = arg.slice('--require-policy='.length)
    } else if (arg === '--min-policy-accuracy') {
      minPolicyAccuracy = parseNumber(value, '--min-policy-accuracy')
      i += 1
    } else if (arg.startsWith('--min-policy-accuracy=')) {
      minPolicyAccuracy = parseNumber(arg.slice('--min-policy-accuracy='.length), '--min-policy-accuracy')
    } else if (arg === '--min-policy-margin') {
      minPolicyMargin = parseNumber(value, '--min-policy-margin')
      i += 1
    } else if (arg.startsWith('--min-policy-margin=')) {
      minPolicyMargin = parseNumber(arg.slice('--min-policy-margin='.length), '--min-policy-margin')
    } else if (arg === '--min-recomputed-accuracy') {
      minRecomputedAccuracy = parseNumber(value, '--min-recomputed-accuracy')
      i += 1
    } else if (arg.startsWith('--min-recomputed-accuracy=')) {
      minRecomputedAccuracy = parseNumber(arg.slice('--min-recomputed-accuracy='.length), '--min-recomputed-accuracy')
    } else if (arg === '--min-recomputed-margin') {
      minRecomputedMargin = parseNumber(value, '--min-recomputed-margin')
      i += 1
    } else if (arg.startsWith('--min-recomputed-margin=')) {
      minRecomputedMargin = parseNumber(arg.slice('--min-recomputed-margin='.length), '--min-recomputed-margin')
    } else if (arg === '--require-feature') {
      if (!value) throw new Error('--require-feature requires a feature name')
      requiredFeatures.push(value)
      i += 1
    } else if (arg.startsWith('--require-feature=')) {
      requiredFeatures.push(arg.slice('--require-feature='.length))
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input, --preferences-input, --min-pairs, --min-weights, --require-policy, --min-policy-accuracy, --min-policy-margin, --min-recomputed-accuracy, --min-recomputed-margin, and --require-feature.`)
    }
  }

  return { input, preferencesInput, minPairs, minWeights, requiredPolicy, minPolicyAccuracy, minPolicyMargin, minRecomputedAccuracy, minRecomputedMargin, requiredFeatures }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertAtLeast(actual: number, minimum: number | undefined, label: string): void {
  if (minimum === undefined) return
  assert(actual >= minimum, `${label} ${actual} is below required floor ${minimum}`)
}

function assertString(value: unknown, label: string): string {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`)
  return value
}

function assertNumber(value: unknown, label: string): number {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number`)
  return value
}

async function readPreferences(path: string): Promise<RerankerPreferenceRecord[]> {
  if (!existsSync(path)) throw new Error(`Reranker preference source not found: ${path}`)
  return (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as RerankerPreferenceRecord)
}

async function main(): Promise<void> {
  const check = parseArgs()
  if (!existsSync(check.input)) throw new Error(`Reranker weights artifact not found: ${check.input}`)

  const artifact = JSON.parse(await readFile(check.input, 'utf8')) as RerankerWeightsArtifact
  assert(artifact.recordType === 'web-control-action-reranker-weights', 'recordType must be web-control-action-reranker-weights')
  assert(artifact.version === 1, 'version must be 1')
  assertString(artifact.sourceFile, 'sourceFile')
  assert(artifact.generatedBy === 'pnpm benchmark:traces:reranker:baseline', 'generatedBy must match reranker baseline script')
  assert(artifact.model?.type === 'pairwise_perceptron', 'model.type must be pairwise_perceptron')
  assert(artifact.model?.featureSet === 'web-control-action-v1', 'model.featureSet must be web-control-action-v1')
  assertNumber(artifact.model?.epochs, 'model.epochs')

  const pairs = assertNumber(artifact.training?.pairs, 'training.pairs')
  assertNumber(artifact.training?.buckets, 'training.buckets')
  assertNumber(artifact.training?.tasks, 'training.tasks')
  assertNumber(artifact.training?.suites, 'training.suites')
  assertAtLeast(pairs, check.minPairs, 'training.pairs')

  assert(Array.isArray(artifact.metrics?.policies), 'metrics.policies must be an array')
  const policies = artifact.metrics.policies as PolicyMetric[]
  const policy = check.requiredPolicy
    ? policies.find(candidate => candidate.name === check.requiredPolicy)
    : undefined
  if (check.requiredPolicy) assert(policy, `required policy not found: ${check.requiredPolicy}`)
  if (policy) {
    assertAtLeast(assertNumber(policy.accuracy, `${check.requiredPolicy}.accuracy`), check.minPolicyAccuracy, `${check.requiredPolicy}.accuracy`)
    assertAtLeast(assertNumber(policy.minMargin, `${check.requiredPolicy}.minMargin`), check.minPolicyMargin, `${check.requiredPolicy}.minMargin`)
  }

  assert(Array.isArray(artifact.weights), 'weights must be an array')
  const weights = artifact.weights as WeightRecord[]
  assertAtLeast(weights.length, check.minWeights, 'weights.length')
  const seen = new Set<string>()
  let previous = ''
  for (const [index, weight] of weights.entries()) {
    const feature = assertString(weight.feature, `weights[${index}].feature`)
    assert(!seen.has(feature), `duplicate weight feature: ${feature}`)
    assert(feature >= previous, `weights must be sorted by feature: ${feature} appeared after ${previous}`)
    seen.add(feature)
    previous = feature
    assertNumber(weight.weight, `weights[${index}].weight`)
    assert(weight.weight !== 0, `weights[${index}].weight must be non-zero`)
  }
  for (const feature of check.requiredFeatures) {
    assert(seen.has(feature), `required feature not found: ${feature}`)
  }

  const preferences = await readPreferences(check.preferencesInput)
  assert(preferences.length === pairs, `preference pair count ${preferences.length} does not match weights training.pairs ${pairs}`)
  const weightMap = new Map(weights.map(weight => [weight.feature as string, weight.weight as number]))
  const margins = preferences.map(pair => learnedMargin(pair, weightMap).margin)
  const correct = margins.reduce((sum, margin) => sum + (margin > 0 ? 1 : margin === 0 ? 0.5 : 0), 0)
  const recomputedAccuracy = margins.length ? correct / margins.length : 0
  const recomputedMinMargin = margins.length ? Math.min(...margins) : 0
  assertAtLeast(recomputedAccuracy, check.minRecomputedAccuracy, 'recomputed_accuracy')
  assertAtLeast(recomputedMinMargin, check.minRecomputedMargin, 'recomputed_min_margin')
  const learnedPolicy = policies.find(candidate => candidate.name === 'learned_perceptron')
  if (learnedPolicy) {
    assert(recomputedAccuracy === learnedPolicy.accuracy, `recomputed accuracy ${recomputedAccuracy} does not match learned_perceptron metric ${learnedPolicy.accuracy}`)
    assert(recomputedMinMargin === learnedPolicy.minMargin, `recomputed min margin ${recomputedMinMargin} does not match learned_perceptron metric ${learnedPolicy.minMargin}`)
  }

  console.log(`Checked reranker weights: ${check.input.replace(REPO_ROOT, '.').replaceAll('\\', '/')}`)
  console.log(`Training pairs: ${pairs}`)
  console.log(`Weights: ${weights.length}`)
  console.log(`Recomputed learned_perceptron: accuracy ${recomputedAccuracy.toFixed(4)}, min margin ${recomputedMinMargin.toFixed(3)}`)
  if (check.requiredPolicy && policy) {
    console.log(`${check.requiredPolicy}: accuracy ${(policy.accuracy as number).toFixed(4)}, min margin ${(policy.minMargin as number).toFixed(3)}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

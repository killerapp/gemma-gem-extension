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
    targetSelectorPolicies?: unknown
  }
  weights?: unknown
}

type CheckConfig = {
  input: string
  preferencesInput: string
  minPairs?: number
  minBuckets?: number
  minTasks?: number
  minSuites?: number
  minWeights?: number
  requiredBestPolicy?: string
  requiredPolicy?: string
  minPolicyPairs?: number
  minPolicyAccuracy?: number
  minPolicyMargin?: number
  minRecomputedAccuracy?: number
  minRecomputedMargin?: number
  requiredTargetSelectorPolicy?: string
  minTargetSelectorPolicyPairs?: number
  minTargetSelectorPolicyAccuracy?: number
  minTargetSelectorPolicyMargin?: number
  minTargetSelectorRecomputedAccuracy?: number
  minTargetSelectorRecomputedMargin?: number
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
  let minBuckets: number | undefined
  let minTasks: number | undefined
  let minSuites: number | undefined
  let minWeights: number | undefined
  let requiredBestPolicy: string | undefined
  let requiredPolicy: string | undefined
  let minPolicyPairs: number | undefined
  let minPolicyAccuracy: number | undefined
  let minPolicyMargin: number | undefined
  let minRecomputedAccuracy: number | undefined
  let minRecomputedMargin: number | undefined
  let requiredTargetSelectorPolicy: string | undefined
  let minTargetSelectorPolicyPairs: number | undefined
  let minTargetSelectorPolicyAccuracy: number | undefined
  let minTargetSelectorPolicyMargin: number | undefined
  let minTargetSelectorRecomputedAccuracy: number | undefined
  let minTargetSelectorRecomputedMargin: number | undefined
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
    } else if (arg === '--min-buckets') {
      minBuckets = parseNumber(value, '--min-buckets')
      i += 1
    } else if (arg.startsWith('--min-buckets=')) {
      minBuckets = parseNumber(arg.slice('--min-buckets='.length), '--min-buckets')
    } else if (arg === '--min-tasks') {
      minTasks = parseNumber(value, '--min-tasks')
      i += 1
    } else if (arg.startsWith('--min-tasks=')) {
      minTasks = parseNumber(arg.slice('--min-tasks='.length), '--min-tasks')
    } else if (arg === '--min-suites') {
      minSuites = parseNumber(value, '--min-suites')
      i += 1
    } else if (arg.startsWith('--min-suites=')) {
      minSuites = parseNumber(arg.slice('--min-suites='.length), '--min-suites')
    } else if (arg === '--min-weights') {
      minWeights = parseNumber(value, '--min-weights')
      i += 1
    } else if (arg.startsWith('--min-weights=')) {
      minWeights = parseNumber(arg.slice('--min-weights='.length), '--min-weights')
    } else if (arg === '--require-best-policy') {
      if (!value) throw new Error('--require-best-policy requires a policy name')
      requiredBestPolicy = value
      i += 1
    } else if (arg.startsWith('--require-best-policy=')) {
      requiredBestPolicy = arg.slice('--require-best-policy='.length)
    } else if (arg === '--require-policy') {
      if (!value) throw new Error('--require-policy requires a policy name')
      requiredPolicy = value
      i += 1
    } else if (arg.startsWith('--require-policy=')) {
      requiredPolicy = arg.slice('--require-policy='.length)
    } else if (arg === '--min-policy-pairs') {
      minPolicyPairs = parseNumber(value, '--min-policy-pairs')
      i += 1
    } else if (arg.startsWith('--min-policy-pairs=')) {
      minPolicyPairs = parseNumber(arg.slice('--min-policy-pairs='.length), '--min-policy-pairs')
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
    } else if (arg === '--require-target-selector-policy') {
      if (!value) throw new Error('--require-target-selector-policy requires a policy name')
      requiredTargetSelectorPolicy = value
      i += 1
    } else if (arg.startsWith('--require-target-selector-policy=')) {
      requiredTargetSelectorPolicy = arg.slice('--require-target-selector-policy='.length)
    } else if (arg === '--min-target-selector-policy-pairs') {
      minTargetSelectorPolicyPairs = parseNumber(value, '--min-target-selector-policy-pairs')
      i += 1
    } else if (arg.startsWith('--min-target-selector-policy-pairs=')) {
      minTargetSelectorPolicyPairs = parseNumber(arg.slice('--min-target-selector-policy-pairs='.length), '--min-target-selector-policy-pairs')
    } else if (arg === '--min-target-selector-policy-accuracy') {
      minTargetSelectorPolicyAccuracy = parseNumber(value, '--min-target-selector-policy-accuracy')
      i += 1
    } else if (arg.startsWith('--min-target-selector-policy-accuracy=')) {
      minTargetSelectorPolicyAccuracy = parseNumber(arg.slice('--min-target-selector-policy-accuracy='.length), '--min-target-selector-policy-accuracy')
    } else if (arg === '--min-target-selector-policy-margin') {
      minTargetSelectorPolicyMargin = parseNumber(value, '--min-target-selector-policy-margin')
      i += 1
    } else if (arg.startsWith('--min-target-selector-policy-margin=')) {
      minTargetSelectorPolicyMargin = parseNumber(arg.slice('--min-target-selector-policy-margin='.length), '--min-target-selector-policy-margin')
    } else if (arg === '--min-target-selector-recomputed-accuracy') {
      minTargetSelectorRecomputedAccuracy = parseNumber(value, '--min-target-selector-recomputed-accuracy')
      i += 1
    } else if (arg.startsWith('--min-target-selector-recomputed-accuracy=')) {
      minTargetSelectorRecomputedAccuracy = parseNumber(arg.slice('--min-target-selector-recomputed-accuracy='.length), '--min-target-selector-recomputed-accuracy')
    } else if (arg === '--min-target-selector-recomputed-margin') {
      minTargetSelectorRecomputedMargin = parseNumber(value, '--min-target-selector-recomputed-margin')
      i += 1
    } else if (arg.startsWith('--min-target-selector-recomputed-margin=')) {
      minTargetSelectorRecomputedMargin = parseNumber(arg.slice('--min-target-selector-recomputed-margin='.length), '--min-target-selector-recomputed-margin')
    } else if (arg === '--require-feature') {
      if (!value) throw new Error('--require-feature requires a feature name')
      requiredFeatures.push(value)
      i += 1
    } else if (arg.startsWith('--require-feature=')) {
      requiredFeatures.push(arg.slice('--require-feature='.length))
    } else {
      throw new Error(`Unknown argument ${arg}. Use --input, --preferences-input, --min-pairs, --min-weights, --require-policy, --min-policy-accuracy, --min-policy-margin, --min-recomputed-accuracy, --min-recomputed-margin, target-selector metric options, and --require-feature.`)
    }
  }

  return {
    input,
    preferencesInput,
    minPairs,
    minBuckets,
    minTasks,
    minSuites,
    minWeights,
    requiredBestPolicy,
    requiredPolicy,
    minPolicyPairs,
    minPolicyAccuracy,
    minPolicyMargin,
    minRecomputedAccuracy,
    minRecomputedMargin,
    requiredTargetSelectorPolicy,
    minTargetSelectorPolicyPairs,
    minTargetSelectorPolicyAccuracy,
    minTargetSelectorPolicyMargin,
    minTargetSelectorRecomputedAccuracy,
    minTargetSelectorRecomputedMargin,
    requiredFeatures,
  }
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

function policyMetricLabel(policyName: string | undefined, field: string): string {
  return policyName ? `${policyName}.${field}` : field
}

function assertPolicyMetric(policy: PolicyMetric, policyName: string | undefined, check: {
  minPairs?: number
  minAccuracy?: number
  minMargin?: number
}): void {
  assertAtLeast(assertNumber(policy.pairs, policyMetricLabel(policyName, 'pairs')), check.minPairs, policyMetricLabel(policyName, 'pairs'))
  assertAtLeast(assertNumber(policy.accuracy, policyMetricLabel(policyName, 'accuracy')), check.minAccuracy, policyMetricLabel(policyName, 'accuracy'))
  assertAtLeast(assertNumber(policy.minMargin, policyMetricLabel(policyName, 'minMargin')), check.minMargin, policyMetricLabel(policyName, 'minMargin'))
}

function accuracyAndMinMargin(margins: number[]): { accuracy: number; minMargin: number } {
  const correct = margins.reduce((sum, margin) => sum + (margin > 0 ? 1 : margin === 0 ? 0.5 : 0), 0)
  return {
    accuracy: margins.length ? correct / margins.length : 0,
    minMargin: margins.length ? Math.min(...margins) : 0,
  }
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
  const buckets = assertNumber(artifact.training?.buckets, 'training.buckets')
  const tasks = assertNumber(artifact.training?.tasks, 'training.tasks')
  const suites = assertNumber(artifact.training?.suites, 'training.suites')
  assertAtLeast(pairs, check.minPairs, 'training.pairs')
  assertAtLeast(buckets, check.minBuckets, 'training.buckets')
  assertAtLeast(tasks, check.minTasks, 'training.tasks')
  assertAtLeast(suites, check.minSuites, 'training.suites')

  const bestPolicy = assertString(artifact.metrics?.bestPolicy, 'metrics.bestPolicy')
  if (check.requiredBestPolicy) assert(bestPolicy === check.requiredBestPolicy, `bestPolicy ${bestPolicy} does not match required policy ${check.requiredBestPolicy}`)
  assert(Array.isArray(artifact.metrics?.policies), 'metrics.policies must be an array')
  const policies = artifact.metrics.policies as PolicyMetric[]
  const policy = check.requiredPolicy
    ? policies.find(candidate => candidate.name === check.requiredPolicy)
    : undefined
  if (check.requiredPolicy) assert(policy, `required policy not found: ${check.requiredPolicy}`)
  if (policy) {
    assertPolicyMetric(policy, check.requiredPolicy, {
      minPairs: check.minPolicyPairs,
      minAccuracy: check.minPolicyAccuracy,
      minMargin: check.minPolicyMargin,
    })
  }

  assert(Array.isArray(artifact.metrics?.targetSelectorPolicies), 'metrics.targetSelectorPolicies must be an array')
  const targetSelectorPolicies = artifact.metrics.targetSelectorPolicies as PolicyMetric[]
  const targetSelectorPolicy = check.requiredTargetSelectorPolicy
    ? targetSelectorPolicies.find(candidate => candidate.name === check.requiredTargetSelectorPolicy)
    : undefined
  if (check.requiredTargetSelectorPolicy) assert(targetSelectorPolicy, `required target selector policy not found: ${check.requiredTargetSelectorPolicy}`)
  if (targetSelectorPolicy) {
    assertPolicyMetric(targetSelectorPolicy, check.requiredTargetSelectorPolicy, {
      minPairs: check.minTargetSelectorPolicyPairs,
      minAccuracy: check.minTargetSelectorPolicyAccuracy,
      minMargin: check.minTargetSelectorPolicyMargin,
    })
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
  const { accuracy: recomputedAccuracy, minMargin: recomputedMinMargin } = accuracyAndMinMargin(margins)
  assertAtLeast(recomputedAccuracy, check.minRecomputedAccuracy, 'recomputed_accuracy')
  assertAtLeast(recomputedMinMargin, check.minRecomputedMargin, 'recomputed_min_margin')
  const learnedPolicy = policies.find(candidate => candidate.name === 'learned_perceptron')
  if (learnedPolicy) {
    assert(recomputedAccuracy === learnedPolicy.accuracy, `recomputed accuracy ${recomputedAccuracy} does not match learned_perceptron metric ${learnedPolicy.accuracy}`)
    assert(recomputedMinMargin === learnedPolicy.minMargin, `recomputed min margin ${recomputedMinMargin} does not match learned_perceptron metric ${learnedPolicy.minMargin}`)
  }

  const targetSelectorPreferences = preferences.filter(pair => Boolean(pair.task.targetSelector))
  const targetSelectorMargins = targetSelectorPreferences.map(pair => learnedMargin(pair, weightMap).margin)
  const { accuracy: targetSelectorRecomputedAccuracy, minMargin: targetSelectorRecomputedMinMargin } = accuracyAndMinMargin(targetSelectorMargins)
  assertAtLeast(targetSelectorRecomputedAccuracy, check.minTargetSelectorRecomputedAccuracy, 'target_selector_recomputed_accuracy')
  assertAtLeast(targetSelectorRecomputedMinMargin, check.minTargetSelectorRecomputedMargin, 'target_selector_recomputed_min_margin')
  const learnedTargetSelectorPolicy = targetSelectorPolicies.find(candidate => candidate.name === 'learned_perceptron')
  if (learnedTargetSelectorPolicy) {
    assert(targetSelectorPreferences.length === learnedTargetSelectorPolicy.pairs, `target selector preference pair count ${targetSelectorPreferences.length} does not match learned_perceptron target selector metric ${learnedTargetSelectorPolicy.pairs}`)
    assert(targetSelectorRecomputedAccuracy === learnedTargetSelectorPolicy.accuracy, `target selector recomputed accuracy ${targetSelectorRecomputedAccuracy} does not match learned_perceptron target selector metric ${learnedTargetSelectorPolicy.accuracy}`)
    assert(targetSelectorRecomputedMinMargin === learnedTargetSelectorPolicy.minMargin, `target selector recomputed min margin ${targetSelectorRecomputedMinMargin} does not match learned_perceptron target selector metric ${learnedTargetSelectorPolicy.minMargin}`)
  }

  console.log(`Checked reranker weights: ${check.input.replace(REPO_ROOT, '.').replaceAll('\\', '/')}`)
  console.log(`Training pairs: ${pairs}`)
  console.log(`Training buckets: ${buckets}`)
  console.log(`Training tasks: ${tasks}`)
  console.log(`Training suites: ${suites}`)
  console.log(`Weights: ${weights.length}`)
  console.log(`Best policy: ${bestPolicy}`)
  console.log(`Recomputed learned_perceptron: accuracy ${recomputedAccuracy.toFixed(4)}, min margin ${recomputedMinMargin.toFixed(3)}`)
  console.log(`Recomputed target selector learned_perceptron: accuracy ${targetSelectorRecomputedAccuracy.toFixed(4)} (${targetSelectorPreferences.length} pairs), min margin ${targetSelectorRecomputedMinMargin.toFixed(3)}`)
  if (check.requiredPolicy && policy) {
    console.log(`${check.requiredPolicy}: accuracy ${(policy.accuracy as number).toFixed(4)}, min margin ${(policy.minMargin as number).toFixed(3)}`)
  }
  if (check.requiredTargetSelectorPolicy && targetSelectorPolicy) {
    console.log(`target selector ${check.requiredTargetSelectorPolicy}: accuracy ${(targetSelectorPolicy.accuracy as number).toFixed(4)} (${targetSelectorPolicy.pairs as number} pairs), min margin ${(targetSelectorPolicy.minMargin as number).toFixed(3)}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

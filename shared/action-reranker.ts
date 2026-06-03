import type { ObservedAction } from './bridge-messages'

export type ActionRerankerTask = {
  id?: string
  suite?: string
  title?: string
  tool?: string
  targetSelector?: string
}

export type RerankerActionInput = {
  status?: string | null
  toolName?: string | null
  selector?: string | null
  text?: string | null
  title?: string | null
}

export type RerankerTrainingPair<Action extends RerankerActionInput = RerankerActionInput> = {
  task: ActionRerankerTask
  chosen: Action
  rejected: Action
}

export type NormalizedRerankerAction = {
  status: string
  toolName: string
  selector: string
  text?: string | null
  title?: string | null
}

export type RankedActionCandidate<Candidate> = {
  rank: number
  index: number
  score: number
  marginFromNext: number | null
  candidate: Candidate
  action: NormalizedRerankerAction
  topContributions: Array<{ feature: string; value: number; weight: number; contribution: number }>
}

export type RerankerWeightsArtifact = {
  recordType?: string
  version?: number
  model?: {
    type?: string
    featureSet?: string
    epochs?: number
  }
  training?: {
    pairs?: number
    buckets?: number
    tasks?: number
    suites?: number
  }
  metrics?: unknown
  weights?: Array<{ feature?: unknown; weight?: unknown }>
}

const MIN_TRAINING_MARGIN = 10

export function tokens(text: string | null | undefined): string[] {
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

function fieldAlignment(selector: string, title: string | null | undefined): 'match' | 'mismatch' | null {
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

function expectsFullPageRead(task: ActionRerankerTask): boolean {
  return task.tool === 'gemma_extract' ||
    task.tool === 'gemma_page_brief' ||
    task.tool === 'gemma_agent' ||
    task.tool === 'gemma_observe'
}

function addFeature(features: Map<string, number>, name: string, value = 1): void {
  features.set(name, (features.get(name) ?? 0) + value)
}

export function normalizeObservedAction(action: ObservedAction): NormalizedRerankerAction {
  const selector = action.selector ?? (typeof action.arguments[0] === 'string' ? action.arguments[0] : '')
  const toolName = action.method === 'click'
    ? 'click_element'
    : action.method === 'type'
      ? 'type_text'
      : action.method === 'select'
        ? 'select_option'
        : action.method === 'scroll'
          ? 'scroll_page'
          : 'run_javascript'

  return {
    status: 'candidate',
    toolName,
    selector,
    text: action.description,
    title: action.description,
  }
}

export function normalizeRerankerAction(action: RerankerActionInput): NormalizedRerankerAction {
  return {
    status: action.status ?? 'candidate',
    toolName: action.toolName ?? 'unknown',
    selector: action.selector ?? '',
    text: action.text ?? null,
    title: action.title ?? null,
  }
}

export function actionFeatures(task: ActionRerankerTask, input: RerankerActionInput): Map<string, number> {
  const action = normalizeRerankerAction(input)
  const features = new Map<string, number>()
  const taskTokens = tokens(`${task.id ?? ''} ${task.title ?? ''} ${task.tool ?? ''}`)
  const actionTokens = tokens(`${action.toolName} ${action.selector} ${action.text ?? ''} ${action.title ?? ''}`)
  const selectorParts = selectorTokens(action.selector)

  addFeature(features, `tool=${action.toolName}`)
  addFeature(features, `status=${action.status}`)
  addFeature(features, `task_tool=${task.tool ?? ''}:${action.toolName}`)
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
  if (action.toolName === 'read_page_content' && task.targetSelector) {
    addFeature(features, action.selector === task.targetSelector ? 'scoped_target_selector=match' : 'scoped_target_selector=mismatch', 6)
  }

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
  if (action.toolName === 'read_page_content' && expectsFullPageRead(task)) {
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

export function dot(weights: Map<string, number>, features: Map<string, number>): number {
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

export function trainPerceptron(pairs: RerankerTrainingPair[], epochs: number): Map<string, number> {
  const weights = new Map<string, number>()
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let mistakes = 0
    for (const pair of pairs) {
      const chosenFeatures = actionFeatures(pair.task, pair.chosen)
      const rejectedFeatures = actionFeatures(pair.task, pair.rejected)
      if (dot(weights, chosenFeatures) - dot(weights, rejectedFeatures) < MIN_TRAINING_MARGIN) {
        updateWeights(weights, chosenFeatures, 1)
        updateWeights(weights, rejectedFeatures, -1)
        mistakes += 1
      }
    }
    if (mistakes === 0) break
  }
  return weights
}

export function learnedMargin(task: ActionRerankerTask, chosen: RerankerActionInput, rejected: RerankerActionInput, weights: Map<string, number>): { chosenScore: number; rejectedScore: number; margin: number } {
  const chosenScore = dot(weights, actionFeatures(task, chosen))
  const rejectedScore = dot(weights, actionFeatures(task, rejected))
  return { chosenScore, rejectedScore, margin: chosenScore - rejectedScore }
}

export function parseRerankerWeights(artifact: RerankerWeightsArtifact): Map<string, number> {
  const weights = new Map<string, number>()
  for (const record of artifact.weights ?? []) {
    if (typeof record.feature !== 'string' || typeof record.weight !== 'number') continue
    weights.set(record.feature, record.weight)
  }
  return weights
}

export function explainActionScore(task: ActionRerankerTask, action: RerankerActionInput, weights: Map<string, number>, limit = 5): Array<{ feature: string; value: number; weight: number; contribution: number }> {
  const features = actionFeatures(task, action)
  return [...features.entries()]
    .map(([feature, value]) => {
      const weight = weights.get(feature) ?? 0
      return { feature, value, weight, contribution: value * weight }
    })
    .filter(item => item.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.feature.localeCompare(b.feature))
    .slice(0, limit)
}

export function rankActionCandidates<Candidate>(
  task: ActionRerankerTask,
  candidates: Candidate[],
  weights: Map<string, number>,
  actionForCandidate: (candidate: Candidate) => RerankerActionInput,
): RankedActionCandidate<Candidate>[] {
  const scored = candidates.map((candidate, index) => {
    const action = normalizeRerankerAction(actionForCandidate(candidate))
    return {
      rank: 0,
      index,
      score: dot(weights, actionFeatures(task, action)),
      marginFromNext: null,
      candidate,
      action,
      topContributions: explainActionScore(task, action, weights),
    } satisfies RankedActionCandidate<Candidate>
  })

  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    marginFromNext: index + 1 < scored.length ? candidate.score - scored[index + 1].score : null,
  }))
}

import type { TraceRecord } from './trace-policy-scoring'

export type RerankerAction = {
  sourceFile: string
  index: number
  status: string
  toolName: string
  selector: string
  text: string | null
  title: string | null
}

export type RerankerCandidate = {
  id: 'candidate_a' | 'candidate_b'
  action: RerankerAction
}

export type RerankerPreferenceRecord = {
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

export function actionFeatures(pair: RerankerPreferenceRecord, action: RerankerAction): Map<string, number> {
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

export function trainPerceptron(pairs: RerankerPreferenceRecord[], epochs: number): Map<string, number> {
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

export function learnedMargin(pair: RerankerPreferenceRecord, weights: Map<string, number>): { chosenScore: number; rejectedScore: number; margin: number } {
  const chosenScore = dot(weights, actionFeatures(pair, pair.chosen.action))
  const rejectedScore = dot(weights, actionFeatures(pair, pair.rejected.action))
  return { chosenScore, rejectedScore, margin: chosenScore - rejectedScore }
}

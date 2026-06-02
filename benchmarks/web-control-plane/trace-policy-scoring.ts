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

export const CANDIDATE_TOOL_NAMES = new Set(['click_element', 'type_text', 'read_page_content'])

export type TraceRecord = {
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

export type ScoredRecord = TraceRecord & {
  policy: string
  score: number
  reasons: string[]
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

function requiresFullPageRead(taskId: string): boolean {
  return taskId === 'extract-pricing-json' ||
    taskId === 'semantic-page-brief' ||
    taskId === 'semantic-receipt-agent' ||
    taskId === 'semantic-observe-json'
}

export function scoreRecord(record: TraceRecord, policy = 'lexical'): ScoredRecord {
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
    if (
      record.action.toolName === 'read_page_content' &&
      requiresFullPageRead(record.task.id) &&
      record.action.selector !== 'body'
    ) {
      score -= 2
      reasons.push('narrow_context_read')
    }
    if (
      record.task.id === 'transfer-profile-fields' &&
      record.action.toolName === 'read_page_content' &&
      record.action.selector?.startsWith('#dest-')
    ) {
      score -= 4
      reasons.push('transfer_destination_read_distractor')
    }
    if (record.action.toolName === 'type_text') {
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

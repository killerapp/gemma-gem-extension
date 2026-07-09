import type { ToolCall, ToolResponse } from '@kessler/gemma-agent'

const MAX_CONTENT_LENGTH = 64000
const CUSTOM_OPTION_WAIT_MS = 2500
const CUSTOM_OPTION_POLL_MS = 25

function readPageContent(args: Record<string, unknown>): ToolResponse {
  const selector = (args.selector as string) || 'body'
  const format = (args.format as string) || 'text'

  const element = document.querySelector(selector)
  if (!element) {
    return { name: 'read_page_content', result: { error: `No element found for selector: ${selector}` } }
  }

  let content = format === 'html' ? element.innerHTML : textContentForRead(element)
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.slice(0, MAX_CONTENT_LENGTH) + '\n...(truncated)'
  }

  return { name: 'read_page_content', result: { content } }
}

function textContentForRead(element: Element): string {
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    return element.checked ? 'checked' : 'unchecked'
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value
  }
  if (element instanceof HTMLSelectElement) {
    const selected = element.selectedOptions[0]
    const selectedLabel = selected?.textContent?.trim() ?? ''
    const selectedValue = selected?.value ?? ''
    const options = [...element.options].map(option => option.textContent?.trim()).filter(Boolean)
    return [
      `selected: ${selectedLabel} (${selectedValue})`,
      'options:',
      ...options,
    ].join('\n')
  }
  return (element as HTMLElement).innerText
}

function clickElement(args: Record<string, unknown>): ToolResponse {
  const selector = (args.selector ?? args.body ?? args.element) as string
  if (!selector) {
    return { name: 'click_element', result: { error: 'selector parameter is required. If you cannot determine a CSS selector, use run_javascript instead: document.querySelector("a").click()' } }
  }
  const element = document.querySelector(selector) as HTMLElement | null
  if (!element) {
    return { name: 'click_element', result: { error: `No element found for selector: ${selector}. Try run_javascript to inspect available elements: JSON.stringify([...document.querySelectorAll("a")].slice(0,5).map(a=>a.href))` } }
  }

  element.click()
  const tag = element.tagName.toLowerCase()
  const text = element.textContent?.slice(0, 50) || ''
  return { name: 'click_element', result: { clicked: `${tag}: ${text}`, selector } }
}

function typeText(args: Record<string, unknown>): ToolResponse {
  const selector = args.selector as string
  const text = args.text as string
  const clear = args.clear !== false
  const element = document.querySelector(selector) as HTMLInputElement | null
  if (!element) {
    return { name: 'type_text', result: { error: `No element found for selector: ${selector}` } }
  }

  element.focus()
  element.value = clear ? text : `${element.value}${text}`
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))

  return { name: 'type_text', result: { typed: text, into: selector, value: element.value } }
}

function selectOption(args: Record<string, unknown>): ToolResponse {
  const selector = args.selector as string
  const value = args.value as string | undefined
  const label = args.label as string | undefined
  const element = document.querySelector(selector) as HTMLSelectElement | null
  if (!element) {
    return { name: 'select_option', result: { error: `No select element found for selector: ${selector}` } }
  }

  const option = [...element.options].find(item =>
    (value != null && item.value === value) ||
    (label != null && item.textContent?.trim() === label) ||
    (label != null && item.textContent?.trim().toLowerCase() === label.toLowerCase())
  )
  if (!option) {
    return {
      name: 'select_option',
      result: {
        error: `No option found for selector: ${selector}`,
        available: [...element.options].map(item => ({ value: item.value, label: item.textContent?.trim() })).slice(0, 200),
      },
    }
  }

  element.value = option.value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))

  return { name: 'select_option', result: { selected: option.textContent?.trim(), value: option.value, selector } }
}

async function chooseOption(args: Record<string, unknown>): Promise<ToolResponse> {
  const selector = args.selector as string
  const optionSelector = args.optionSelector as string | undefined
  const value = args.value as string | undefined
  const label = args.label as string | undefined
  const trigger = document.querySelector(selector) as HTMLElement | null
  if (!trigger) {
    return { name: 'choose_option', result: { error: `No trigger found for selector: ${selector}` } }
  }
  if (!optionSelector && !value && !label) {
    return { name: 'choose_option', result: { error: 'choose_option requires optionSelector, value, or label' } }
  }

  trigger.click()

  const option = await waitForCustomOption(optionSelector, value, label)
  if (!option) {
    return {
      name: 'choose_option',
      result: {
        error: `No option found for selector: ${selector}`,
        available: customOptionCandidates().map(candidate => optionSummary(candidate)).slice(0, 50),
      },
    }
  }

  option.click()
  return {
    name: 'choose_option',
    result: {
      selector,
      optionSelector: selectorForOption(option),
      selected: option.textContent?.trim() ?? '',
      value: optionValue(option),
    },
  }
}

async function waitForCustomOption(
  optionSelector: string | undefined,
  value: string | undefined,
  label: string | undefined,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + CUSTOM_OPTION_WAIT_MS
  do {
    const option = optionSelector ? findCustomOptionBySelector(optionSelector) : findCustomOption(value, label)
    if (option) return option
    await delay(CUSTOM_OPTION_POLL_MS)
  } while (Date.now() < deadline)
  return optionSelector ? findCustomOptionBySelector(optionSelector) : findCustomOption(value, label)
}

function findCustomOptionBySelector(optionSelector: string): HTMLElement | null {
  const option = document.querySelector(optionSelector) as HTMLElement | null
  return option && isVisibleCustomOption(option) ? option : null
}

function findCustomOption(value: string | undefined, label: string | undefined): HTMLElement | null {
  const expectedValue = value?.toLowerCase()
  const expectedLabel = label?.toLowerCase()
  return customOptionCandidates().find(option => {
    const actualValue = optionValue(option).toLowerCase()
    const actualLabel = (option.textContent ?? '').trim().toLowerCase()
    return (expectedValue != null && actualValue === expectedValue) ||
      (expectedLabel != null && actualLabel === expectedLabel)
  }) ?? null
}

function customOptionCandidates(): HTMLElement[] {
  return ([...document.querySelectorAll([
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[data-option-value]',
    '[data-value][data-select-option]',
  ].join(','))] as HTMLElement[])
    .filter(isVisibleCustomOption)
}

function isVisibleCustomOption(option: HTMLElement): boolean {
  return !option.hidden && !option.closest('[hidden]') && option.getAttribute('aria-hidden') !== 'true'
}

function optionValue(option: HTMLElement): string {
  return option.getAttribute('data-option-value') ??
    option.getAttribute('data-value') ??
    option.getAttribute('value') ??
    option.getAttribute('aria-label') ??
    option.textContent?.trim() ??
    ''
}

function selectorForOption(option: HTMLElement): string {
  return option.id ? `#${option.id}` : option.getAttribute('data-option-value')
    ? `[data-option-value="${option.getAttribute('data-option-value')}"]`
    : option.getAttribute('data-value')
      ? `[data-value="${option.getAttribute('data-value')}"]`
      : option.tagName.toLowerCase()
}

function optionSummary(option: HTMLElement): Record<string, string> {
  return {
    selector: selectorForOption(option),
    label: option.textContent?.trim() ?? '',
    value: optionValue(option),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function scrollPage(args: Record<string, unknown>): ToolResponse {
  const direction = args.direction as string
  const amount = (args.amount as number) || 500
  const pixels = direction === 'up' ? -amount : amount

  window.scrollBy({ top: pixels, behavior: 'auto' })

  return { name: 'scroll_page', result: { scrolled: `${direction} ${amount}px`, scrollY: window.scrollY } }
}

export async function executeContentTool(call: ToolCall): Promise<ToolResponse | null> {
  try {
    switch (call.name) {
      case 'read_page_content': return readPageContent(call.arguments)
      case 'click_element': return clickElement(call.arguments)
      case 'type_text': return typeText(call.arguments)
      case 'select_option': return selectOption(call.arguments)
      case 'choose_option': return chooseOption(call.arguments)
      case 'scroll_page': return scrollPage(call.arguments)
      default: return null
    }
  } catch (e) {
    return { name: call.name, result: { error: `Tool ${call.name} failed: ${e instanceof Error ? e.message : e}` } }
  }
}

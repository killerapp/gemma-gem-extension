import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  appendRelayText,
  isRelayChunkActivity,
  normalizeRelayActivityStatus,
  relayDisplayStatus,
  relayActivityChunkParts,
  relayChunkParts,
  relayRenderableEvent,
} from '../../content/chat-overlay'

test('Relay chunk helpers normalize transport statuses', () => {
  assert.equal(normalizeRelayActivityStatus('CHUNK'), 'chunk')
  assert.equal(normalizeRelayActivityStatus(' chunk '), 'chunk')
  assert.equal(normalizeRelayActivityStatus('bridge:chunk'), 'chunk')
  assert.equal(normalizeRelayActivityStatus('agent:chunk'), 'chunk')
  assert.equal(normalizeRelayActivityStatus('Tool'), 'tool')
  assert.equal(normalizeRelayActivityStatus('bridge:tool_call'), 'tool')
  assert.equal(normalizeRelayActivityStatus('unexpected'), undefined)
})

test('Relay event row labels canonicalize before display', () => {
  assert.equal(relayDisplayStatus('CHUNK'), 'chunk')
  assert.equal(relayDisplayStatus(' Tool '), 'tool')
  assert.equal(relayDisplayStatus('custom event'), 'custom event')
  assert.equal(relayDisplayStatus(undefined), undefined)
})

test('Relay thinking chunks parse as stream parts', () => {
  assert.deepEqual(relayChunkParts('[Thinking] click.'), { label: 'thinking', text: 'click.' })
  assert.deepEqual(relayChunkParts('Thinking: 3.'), { label: 'thinking', text: '3.' })
  assert.deepEqual(relayChunkParts('[Tool] click_element'), { label: 'tool', text: 'click_element' })
})

test('Relay explicit thinking payloads stream even with noncanonical statuses', () => {
  assert.equal(isRelayChunkActivity({ status: 'CHUNK', text: 'Thinking: click.' }), true)
  assert.equal(isRelayChunkActivity({ status: 'bridge:chunk', text: 'Thinking: Report' }), true)
  assert.equal(isRelayChunkActivity({ status: 'agent:chunk', text: 'Thinking: the result' }), true)
  assert.equal(isRelayChunkActivity({ status: 'completed', text: 'Thinking: final note' }), false)
  assert.equal(isRelayChunkActivity({ status: 'error', text: 'Thinking: failed' }), false)
})

test('Relay chunk payloads do not render as ordinary event rows', () => {
  const activity = {
    type: 'bridge:activity' as const,
    status: 'CHUNK' as 'chunk',
    text: 'Thinking: click.',
    timestamp: 1,
  }

  assert.deepEqual(relayActivityChunkParts(activity), { label: 'thinking', text: 'click.' })
  assert.equal(relayRenderableEvent(activity), null)
})

test('Relay token-sized thinking chunks coalesce into readable text', () => {
  const chunks = ['me', 'click.', '3.', 'Report', 'the', 'result']
  const text = chunks.reduce((current, chunk) => appendRelayText(current, chunk), '')

  assert.equal(text, 'me click. 3. Report the result')
})

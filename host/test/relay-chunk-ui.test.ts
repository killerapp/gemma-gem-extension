import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  appendRelayText,
  normalizeRelayActivityStatus,
  relayChunkParts,
} from '../../content/chat-overlay'

test('Relay chunk helpers normalize transport statuses', () => {
  assert.equal(normalizeRelayActivityStatus('CHUNK'), 'chunk')
  assert.equal(normalizeRelayActivityStatus(' chunk '), 'chunk')
  assert.equal(normalizeRelayActivityStatus('Tool'), 'tool')
  assert.equal(normalizeRelayActivityStatus('unexpected'), undefined)
})

test('Relay thinking chunks parse as stream parts', () => {
  assert.deepEqual(relayChunkParts('[Thinking] click.'), { label: 'thinking', text: 'click.' })
  assert.deepEqual(relayChunkParts('Thinking: 3.'), { label: 'thinking', text: '3.' })
  assert.deepEqual(relayChunkParts('[Tool] click_element'), { label: 'tool', text: 'click_element' })
})

test('Relay token-sized thinking chunks coalesce into readable text', () => {
  const chunks = ['me', 'click.', '3.', 'Report', 'the', 'result']
  const text = chunks.reduce((current, chunk) => appendRelayText(current, chunk), '')

  assert.equal(text, 'me click. 3. Report the result')
})

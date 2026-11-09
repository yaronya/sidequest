import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Fork, ParentLink, Topic } from '../types'
import {
  answerExcerpt,
  applyAgents,
  cleanTitle,
  digTopic,
  fallbackTitle,
  forkExcerpt,
  forkName,
  forkPrompt,
  forksLabel,
  nextPage,
  pageOf,
  parentLabel,
  parentName,
  parentOf,
  parseBackgrounded,
  parseTopics,
  transcriptPath,
} from '../hooks/forks'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const PARENT: ParentLink = { sessionId: '6bedcd55-2c20-4ec8-8baa-6b95beee6121', name: 'sidequest fork session metadata' }

const fork = (over: Partial<Fork>): Fork => ({
  id: 'abc123',
  name: 'parent/topic',
  title: 'Topic',
  prompt: 'Fork from the parent session: deep dive on this one topic only, "Topic".',
  startedAt: NOW,
  state: 'working',
  ...over,
})

describe('topics', () => {
  test('parses the JSON array out of a chatty reply', () => {
    const topics = parseTopics('Here you go:\n[{"title":"NAT cost","prompt":"Dig into NAT."},{"title":"WAF","prompt":"Check WAF."}]')
    expect(topics.map(t => t.title).join()).toBe('NAT cost,WAF')
  })
  test('drops malformed items', () => {
    expect(parseTopics('[{"title":"ok","prompt":"p"},{"title":3},{"prompt":"x"}]').length).toBe(1)
  })
  test('no array, no topics', () => {
    expect(parseTopics('nothing here').length).toBe(0)
  })
  test('keeps all twelve findings of a long report', () => {
    const twelve = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, prompt: 'p' })))
    expect(parseTopics(twelve).length).toBe(12)
  })
  test('caps at thirty', () => {
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, prompt: 'p' })))
    expect(parseTopics(many).length).toBe(30)
  })
  test('a long answer keeps its start and its end', () => {
    const excerpt = answerExcerpt(`TOP-FINDING${'x'.repeat(30_000)}LAST-QUESTION`)
    expect([excerpt.startsWith('TOP-FINDING'), excerpt.endsWith('LAST-QUESTION'), excerpt.length < 21_000].join()).toBe('true,true,true')
  })
  test('a short answer is kept whole', () => {
    expect(answerExcerpt('short')).toBe('short')
  })
  test('a topic title from the model is cleaned', () => {
    expect(parseTopics('[{"title":" \\"NAT cost.\\" ","prompt":"p"}]')[0]?.title).toBe('NAT cost')
  })
})

describe('dig', () => {
  test('a short title before ": " names the fork', () => {
    expect(digTopic('Cache eviction plan: so to fix the cache we need to evict stale keys')).toEqual({
      title: 'Cache eviction plan',
      prompt: 'so to fix the cache we need to evict stale keys',
    })
  })
  test('no title typed leaves it to the model', () => {
    expect(digTopic('so to fix the cache we need to evict stale keys')).toEqual({ prompt: 'so to fix the cache we need to evict stale keys' })
  })
  test('a long sentence before a colon is not a title', () => {
    expect(digTopic('compare the Aurora proxy bypass cost against the RDS bill: is it worth it')?.title).toBe(undefined)
  })
  test('a URL is not a title', () => {
    expect(digTopic('check https://example.com/pull/1 for drift')?.title).toBe(undefined)
  })
  test('an empty dig is nothing', () => {
    expect(digTopic('   ')).toBe(undefined)
  })
  test('with no model title, the first words typed', () => {
    expect(fallbackTitle('compare Aurora proxy bypass cost against the RDS bill')).toBe('compare Aurora proxy bypass cost against')
  })
})

describe('titles', () => {
  test('drops quotes, a label and a trailing period', () => {
    expect(cleanTitle('Title: "Cache rollout urgency."')).toBe('Cache rollout urgency')
  })
  test('keeps the first line only', () => {
    expect(cleanTitle('NAT cost\nbecause the gateway...')).toBe('NAT cost')
  })
  test('cuts a long title at a word, never mid-word', () => {
    expect(cleanTitle('Rotate staging database credentials before Friday release window')).toBe('Rotate staging database credentials')
  })
  test('a cut title does not end on a connecting word', () => {
    expect(cleanTitle('Expire S3 incomplete uploads and noncurrent versions')).toBe('Expire S3 incomplete uploads')
  })
  test('a cut title drops a run of connecting words', () => {
    expect(cleanTitle('help me answer these questions on the quarterly report today')).toBe('help me answer these questions')
  })
})

describe('pages', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1)
  test('the first page shows nine', () => {
    expect(pageOf(twelve, 0).shown.join()).toBe('1,2,3,4,5,6,7,8,9')
  })
  test('the second page shows the rest', () => {
    expect(pageOf(twelve, 9).shown.join()).toBe('10,11,12')
  })
  test('more after the last page goes back to the first', () => {
    expect([nextPage(12, 0), nextPage(12, 9)].join()).toBe('9,0')
  })
  test('an offset past the list falls back to the first page', () => {
    expect(pageOf([1, 2], 9).start).toBe(0)
  })
})

describe('names', () => {
  test('a fork is named by its title after the fork mark', () => {
    expect(forkName('Cache eviction plan', [])).toBe('⑂ Cache eviction plan')
  })
  test('a fork of a fork has the same shape, never the parent chain', () => {
    expect(forkName('Rollout questions reply', ['⑂ Cache eviction plan'])).toBe('⑂ Rollout questions reply')
  })
  test('a title already used in this session gets a number', () => {
    expect(forkName('NAT cost', ['⑂ NAT cost', '⑂ NAT cost 2'])).toBe('⑂ NAT cost 3')
  })
  test('reads the id claude --bg prints', () => {
    expect(parseBackgrounded('backgrounded · 490a1126 · fb-probe/topic-a\n  claude agents')).toBe('490a1126')
  })
  test('builds the transcript path from the cwd', () => {
    expect(transcriptPath('/Users/me', '/Users/me/dev/env0', 's1')).toBe('/Users/me/.claude/projects/-Users-me-dev-env0/s1.jsonl')
  })
})

describe('fork states', () => {
  test('an idle fork is waiting, and says so once', () => {
    const { forks, nowWaiting } = applyAgents([fork({})], [{ id: 'abc123', status: 'idle', sessionId: 's1' }], NOW)
    expect([forks[0]?.state, forks[0]?.waitingSince, forks[0]?.sessionId, nowWaiting.join()].join()).toBe(`waiting,${NOW},s1,Topic`)
  })
  test('a fork already waiting keeps its time and is not announced again', () => {
    const { forks, nowWaiting } = applyAgents([fork({ state: 'waiting', waitingSince: 1 })], [{ id: 'abc123', status: 'idle' }], NOW)
    expect([forks[0]?.waitingSince, nowWaiting.length].join()).toBe('1,0')
  })
  test('a busy fork is working', () => {
    expect(applyAgents([fork({})], [{ id: 'abc123', status: 'busy', state: 'working' }], NOW).forks[0]?.state).toBe('working')
  })
  test('a running fork with no status yet is working', () => {
    expect(applyAgents([fork({})], [{ id: 'abc123', state: 'working' }], NOW).forks[0]?.state).toBe('working')
  })
  test('a fork missing from the list is gone', () => {
    expect(applyAgents([fork({})], [], NOW).forks[0]?.state).toBe('gone')
  })
})

describe('footer label', () => {
  test('ready first, then running', () => {
    expect(forksLabel([fork({}), fork({ state: 'waiting' }), fork({ state: 'working' })])).toBe('⑂ 1 ready · 2 running')
  })
  test('a zero count is left out', () => {
    expect(forksLabel([fork({ state: 'waiting' })])).toBe('⑂ 1 ready')
  })
  test('only gone forks show nothing', () => {
    expect(forksLabel([fork({ state: 'gone' })])).toBe(undefined)
  })
})

const mountFooter = async (...[$, on, forks, parent]: [...Parameters<TestBody>, Fork[], ParentLink?]) => {
  on('state.get', (_, e) => ({
    value: {
      value: e.key === 'parent' && parent ? { shape: 'parent-1', value: parent } : { shape: 'forks-1', value: e.key === 'forks' ? forks : [] },
      version: 1,
    },
  }))
  // Stands for the engine and any plugin beneath: draws the labels it is handed, joined as the footer joins them.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`[${e.props.modes.join(' & ')}]`}</Text>
  })
  return $.ui.mount({ plugin: 'sidequest', component: 'SessionMode', surface: 'terminal', props: { modes: ['focus'] } })
}

test('the footer keeps the other modes and adds the fork counts last', async ($, on) => {
  const ui = await mountFooter($, on, [fork({ state: 'waiting' }), fork({})])
  expect(Boolean(await ui.find({ type: 'Text', text: '[focus & ⑂ 1 ready · 1 running]' }))).toBe(true)
  await ui.unmount()
})

test('a fork names its parent in the footer, before its own fork counts', async ($, on) => {
  const ui = await mountFooter($, on, [fork({})], PARENT)
  expect(Boolean(await ui.find({ type: 'Text', text: '[focus & ⑂ from sidequest fork session metadata & ⑂ 1 running]' }))).toBe(true)
  await ui.unmount()
})

test('with no live fork the footer is passed on untouched', async ($, on) => {
  const ui = await mountFooter($, on, [fork({ state: 'gone' })])
  expect(Boolean(await ui.find({ type: 'Text', text: '[focus]' }))).toBe(true)
  await ui.unmount()
})

describe('parent link', () => {
  test('a fork prompt names its parent, and reads back as it', () => {
    expect(parentOf(forkPrompt({ title: 'NAT cost', prompt: 'Dig into NAT.' }, PARENT))).toEqual(PARENT)
  })
  test('a fork prompt from before the link names no parent', () => {
    expect(parentOf(fork({}).prompt)).toBe(undefined)
  })
  test('an ordinary prompt names no parent', () => {
    expect(parentOf('what about NAT?')).toBe(undefined)
  })
  test('a parent name drops the fork mark and double quotes', () => {
    expect(parentName('⑂ Cache "eviction" plan', PARENT.sessionId)).toBe("Cache 'eviction' plan")
  })
  test('a session with no name goes by its short id', () => {
    expect(parentName(undefined, PARENT.sessionId)).toBe('6bedcd55')
  })
  test('the footer label', () => {
    expect(parentLabel(PARENT)).toBe('⑂ from sidequest fork session metadata')
  })
})

test('the prompt that starts a fork keeps its parent, for the session and for a resume', async ($, on) => {
  const writes: string[] = []
  on('state.get', () => ({ value: { value: { shape: 'none', value: [] }, version: 1 } }))
  on('state.set', (_, e) => {
    writes.push(`state ${e.key}`)
    return { value: { isSet: true, version: 2 } }
  })
  on('store.set', (_, e) => {
    writes.push(`store ${e.key}`)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'child-session' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const text = forkPrompt({ title: 'NAT cost', prompt: 'Dig into NAT.' }, PARENT)
  expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text })).text).toBe(text)
  expect(writes.join()).toBe('state parent,store parent:child-session')
})

describe('harvest excerpt', () => {
  const prompt = fork({}).prompt
  const lines = [
    { uuid: 'u0', type: 'user', message: { role: 'user', content: 'parent question before the fork' } },
    { uuid: 'a0', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'parent answer' }] } },
    { uuid: 'u1', type: 'user', message: { role: 'user', content: prompt } },
    { uuid: 'a1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'fork finding' }] } },
    { uuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'noise' }] } },
    { uuid: 'u3', type: 'user', message: { role: 'user', content: 'so we go with option B' } },
    { uuid: 'a3', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'agreed, B' }] } },
  ]
  const jsonl = `{"cut off line\n${lines.map(l => JSON.stringify(l)).join('\n')}\n`

  test('keeps only what came after the fork prompt', () => {
    expect(forkExcerpt(jsonl, prompt).excerpt).toBe(
      'Assistant: fork finding\n\nUser: so we go with option B\n\nAssistant: agreed, B',
    )
  })
  test('starts after what an earlier harvest took', () => {
    expect(forkExcerpt(jsonl, prompt, 'a1').excerpt).toBe('User: so we go with option B\n\nAssistant: agreed, B')
  })
  test('remembers the last message it took', () => {
    expect(forkExcerpt(jsonl, prompt).lastUuid).toBe('a3')
  })
  test('nothing new after the last harvest', () => {
    expect(forkExcerpt(jsonl, prompt, 'a3').excerpt).toBe('')
  })
})

const TOPICS: Topic[] = [
  { title: 'NAT gateway cost', prompt: 'Dig into NAT.' },
  { title: 'WAF count mode', prompt: 'Check WAF.' },
]

test('the band offers each topic on every surface', async ($, on) => {
  on('state.get', (_, e) => ({
    value: { value: { shape: 'topics-1', value: e.key === 'topics' ? TOPICS : [] }, version: 1 },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'sidequest', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} } })
    const found = [await ui.find({ key: 'topic-0' }), await ui.find({ key: 'topic-1' }), await ui.find({ key: 'fork-all' })]
    expect(found.every(Boolean)).toBe(true)
    await ui.unmount()
  }
})

describe('band keys sent as a prompt', () => {
  const withTopics = (on: Parameters<TestBody>[1], topics: Topic[]) => {
    on('state.get', (_, e) => ({ value: { value: { shape: 'topics-1', value: e.key === 'topics' ? topics : [] }, version: 1 } }))
    on('state.set', () => ({ value: { isSet: true, version: 2 } }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
  }

  test('x dismisses the topics', async ($, on) => {
    withTopics(on, TOPICS)
    expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'x' })).drop).toBe('Side quests dismissed.')
  })
  test('a number past the list says so', async ($, on) => {
    withTopics(on, TOPICS)
    expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: '9' })).drop).toBe('No side quest 9: the band shows 2.')
  })
  test('other prompts pass', async ($, on) => {
    withTopics(on, TOPICS)
    expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'what about NAT?' })).text).toBe('what about NAT?')
  })
  test('on the second page, 1 forks topic 10', async ($, on) => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ title: `finding ${i + 1}`, prompt: 'p' }))
    on('state.get', (_, e) => ({
      value: e.key === 'offset' ? { value: { shape: 'offset-1', value: 9 }, version: 1 } : { value: { shape: 'topics-1', value: e.key === 'topics' ? twelve : [] }, version: 1 },
    }))
    on('state.set', () => ({ value: { isSet: true, version: 2 } }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: '1' })).drop).toBe('Forking "finding 10" in the background.')
  })
  test('with no band, x is an ordinary prompt', async ($, on) => {
    withTopics(on, [])
    expect((await $.prompt.submit({ wait: false, origin: { kind: 'composer' }, text: 'x' })).text).toBe('x')
  })
})

test('the band pages twelve findings', async ($, on) => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ title: `finding ${i + 1}`, prompt: 'p' }))
  on('state.get', (_, e) => ({ value: { value: { shape: 'topics-1', value: e.key === 'topics' ? twelve : [] }, version: 1 } }))

  const ui = await $.ui.mount({
    plugin: 'sidequest',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const found = [
    await ui.find({ type: 'Text', text: /Side quests 1-9 of 12/ }),
    await ui.find({ key: 'topic-8' }),
    await ui.find({ type: 'Text', text: /\+3 more · \/quests more/ }),
  ]
  expect([found.every(Boolean), Boolean(await ui.find({ key: 'topic-9' }))].join()).toBe('true,false')
  await ui.unmount()
})

test('the pane shows which fork is ready', async ($, on) => {
  const forks = [fork({ title: 'NAT gateway cost', state: 'waiting', waitingSince: NOW - 600_000 }), fork({ id: 'def456', title: 'WAF' })]
  on('state.get', (_, e) => ({ value: { value: { shape: 'forks-1', value: e.key === 'forks' ? forks : [] }, version: 1 } }))
  on('clock.now', () => ({ value: NOW }))

  const ui = await $.ui.mount({
    plugin: 'sidequest',
    component: 'Pane',
    requestId: 'sidequest',
    surface: 'terminal',
    props: { title: 'Side quests', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const found = [await ui.find({ type: 'Text', text: /ready 10m/ }), await ui.find({ type: 'Text', text: /WAF/ })]
  expect([found.every(Boolean), Boolean(await ui.find({ type: 'Text', text: /claude attach/ }))].join()).toBe('true,false')
  await ui.unmount()
})

test('a pane button label does not repeat the hotkey the painter draws before it', async ($, on) => {
  on('state.get', () => ({ value: { value: { shape: 'forks-1', value: [] }, version: 1 } }))
  on('clock.now', () => ({ value: NOW }))
  const ui = await $.ui.mount({
    plugin: 'sidequest',
    component: 'Pane',
    requestId: 'sidequest',
    surface: 'terminal',
    props: { title: 'Side quests', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect([(await ui.find({ key: 'refresh' }))?.text, (await ui.find({ key: 'forget' }))?.text].join()).toBe('refresh,forget gone')
  await ui.unmount()
})

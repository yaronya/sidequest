import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fork, ParentLink, Topic } from '../types'
import {
  type Agent,
  applyAgents,
  cleanTitle,
  digTopic,
  fallbackTitle,
  forkExcerpt,
  forkName,
  forkPrompt,
  forksLabel,
  harvestRequest,
  nextPage,
  pageOf,
  parentKey,
  parentLabel,
  parentName,
  parentOf,
  parseBackgrounded,
  parseTopics,
  titleRequest,
  topicsRequest,
  transcriptPath,
} from './forks'

const PANE = 'sidequest'
const POLL_MS = 20_000
// Large enough for a long fork discussion; the copied parent history before it is skipped.
const TRANSCRIPT_TAIL_BYTES = '3000000'

// Change a tag when that value's fields change: a reload keeps what the old code stored.
const topicsAtom = atom({ plugin: 'sidequest', key: 'topics' } as const, [], { shape: 'topics-1' })
const offsetAtom = atom({ plugin: 'sidequest', key: 'offset' } as const, 0, { shape: 'offset-1' })
const forksAtom = atom({ plugin: 'sidequest', key: 'forks' } as const, [], { shape: 'forks-1' })
const parentAtom = atom({ plugin: 'sidequest', key: 'parent' } as const, null, { shape: 'parent-1' })

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

async function storeKey($: EngineInterface): Promise<string> {
  return `forks:${await $.session.id()}`
}

async function saveForks($: EngineInterface, forks: Fork[]): Promise<void> {
  await update($, forksAtom, () => forks)
  await $.store.set(await storeKey($), forks)
}

async function loadForks($: EngineInterface): Promise<void> {
  const saved = await $.store.get(await storeKey($))
  if (Array.isArray(saved)) await update($, forksAtom, () => saved as Fork[])
}

async function loadParent($: EngineInterface): Promise<void> {
  const saved = await $.store.get(parentKey(await $.session.id()))
  if (saved) await update($, parentAtom, () => saved as ParentLink)
}

// A fork learns its parent from the prompt that started it, and stores it for a resume.
async function noteParent($: EngineInterface, text: string): Promise<void> {
  const parent = parentOf(text)
  if (!parent || (await read($, parentAtom))) return
  await update($, parentAtom, () => parent)
  await $.store.set(parentKey(await $.session.id()), parent)
}

async function listAgents($: EngineInterface): Promise<Agent[]> {
  const run = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 20_000 })
  if (run.exitCode !== 0) return []
  try {
    const parsed: unknown = JSON.parse(run.stdout)
    return Array.isArray(parsed) ? (parsed as Agent[]) : []
  } catch {
    return []
  }
}

async function poll($: EngineInterface): Promise<void> {
  const forks = await read($, forksAtom)
  if (!forks.some(fork => fork.state !== 'gone')) return
  const { forks: next, nowWaiting } = applyAgents(forks, await listAgents($), await $.clock.now())
  if (JSON.stringify(next) !== JSON.stringify(forks)) await saveForks($, next)
  for (const title of nowWaiting) $.ui.toast(`"${title}" is ready`)
}

async function forkTopic($: EngineInterface, topic: Topic): Promise<string> {
  const sessionId = await $.session.id()
  const cwd = await $.session.cwd()
  const model = await $.session.model()
  const name = forkName(topic.title, (await read($, forksAtom)).map(fork => fork.name))
  const self = (await listAgents($)).find(agent => agent.sessionId === sessionId)
  const prompt = forkPrompt(topic, { sessionId, name: parentName(self?.name, sessionId) })
  const argv = ['claude', '-r', sessionId, '--fork-session', '--bg', '-n', name]
  if (/^[\w.[\]-]+$/.test(model)) argv.push('--model', model)

  const run = await $.process.run([...argv, prompt], { cwd, timeoutMs: 60_000 })
  const id = parseBackgrounded(`${run.stdout}\n${run.stderr}`)
  if (!id) return `could not fork "${topic.title}": ${firstLine(run.stderr || run.stdout) || `exit ${run.exitCode}`}`

  const fork: Fork = { id, name, title: topic.title, prompt, startedAt: await $.clock.now(), state: 'working' }
  await saveForks($, [...(await read($, forksAtom)), fork])
  await update($, topicsAtom, topics => topics.filter(t => t.title !== topic.title))
  return `forked "${topic.title}" as ${name} · claude attach ${id}`
}

// A `/dig` with no typed title gets a short one from the model, so the session list reads by subject.
async function titleFor($: EngineInterface, prompt: string): Promise<string> {
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: titleRequest(prompt), maxTokens: 40 })
    return (reply.isAnswered && cleanTitle(reply.text)) || fallbackTitle(prompt)
  } catch {
    return fallbackTitle(prompt)
  }
}

// Runs detached from a key or a click, so a failure becomes a toast, never an unhandled rejection.
async function forkAndToast($: EngineInterface, topic: Topic): Promise<void> {
  let message: string
  try {
    message = await forkTopic($, topic)
  } catch (error) {
    message = `could not fork "${topic.title}": ${error instanceof Error ? error.message : String(error)}`
  }
  $.ui.toast(message)
}

// The band's current page of up to 9 topics.
async function shownTopics($: EngineInterface): Promise<{ topics: Topic[]; shown: Topic[]; start: number }> {
  const topics = await read($, topicsAtom)
  return { topics, ...pageOf(topics, await read($, offsetAtom)) }
}

// Forks the page shown, not every topic: a long list stays a choice.
async function forkShown($: EngineInterface): Promise<void> {
  for (const topic of (await shownTopics($)).shown) await forkAndToast($, topic)
}

async function dismiss($: EngineInterface): Promise<void> {
  await update($, topicsAtom, () => [])
  await update($, offsetAtom, () => 0)
}

async function showMore($: EngineInterface): Promise<string> {
  const topics = await read($, topicsAtom)
  if (topics.length === 0) return 'no side quests listed. Run /quests after an answer first.'
  const offset = nextPage(topics.length, await read($, offsetAtom))
  await update($, offsetAtom, () => offset)
  return `the band shows side quests ${offset + 1}-${Math.min(offset + 9, topics.length)} of ${topics.length}.`
}

// The last answer: the assistant text since the last user prompt.
async function lastAnswer($: EngineInterface): Promise<string> {
  const messages = await $.session.messages()
  const parts: string[] = []
  for (const message of [...messages].reverse()) {
    if (message.role === 'assistant' && message.text.trim()) parts.unshift(message.text)
    else if (message.role === 'user' && message.text.trim() && parts.length > 0) break
  }
  return parts.join('\n\n')
}

async function findTopics($: EngineInterface): Promise<string> {
  const answer = await lastAnswer($)
  if (!answer) return 'no answer to read side quests from yet.'
  const reply = await $.model.complete({ model: 'haiku', prompt: topicsRequest(answer), maxTokens: 6000 })
  if (!reply.isAnswered) return `the topic model did not answer (${reply.reason}).`
  const topics = parseTopics(reply.text)
  await update($, topicsAtom, () => topics)
  await update($, offsetAtom, () => 0)
  if (topics.length === 0) return 'found no separate threads in the last answer.'
  const more = topics.length > 9 ? ` /quests more shows the next ${Math.min(9, topics.length - 9)}.` : ''
  return `${topics.length} side quests, ranked by impact, are in the band above the prompt. Send a number to fork one, a to fork the ones shown, x to dismiss.${more}`
}

async function harvest($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const agents = await listAgents($)
  // Live states: the saved ones are stale whenever no poll ran since (a resumed session, a closed pane).
  const { forks } = applyAgents(await read($, forksAtom), agents, await $.clock.now())
  const sections: string[] = []
  const next: Fork[] = []

  for (const fork of forks) {
    const agent = agents.find(a => a.id === fork.id)
    const sessionId = fork.sessionId ?? agent?.sessionId
    if (fork.state === 'working' || !sessionId || !agent?.cwd) {
      next.push(fork)
      continue
    }
    const tail = await $.process.run(['tail', '-c', TRANSCRIPT_TAIL_BYTES, transcriptPath(home, agent.cwd, sessionId)])
    const { excerpt, lastUuid } = tail.exitCode === 0 ? forkExcerpt(tail.stdout, fork.prompt, fork.harvestedUuid) : { excerpt: '' }
    if (!excerpt) {
      next.push(fork)
      continue
    }
    const reply = await $.model.complete({ model: 'haiku', prompt: harvestRequest(fork.title, excerpt), maxTokens: 800 })
    if (!reply.isAnswered) {
      next.push(fork)
      continue
    }
    sections.push(`### ${fork.title} (claude attach ${fork.id})\n${reply.text.trim()}`)
    next.push({ ...fork, harvestedUuid: lastUuid ?? fork.harvestedUuid })
  }

  await saveForks($, next)
  return sections.length > 0
    ? `Results from side quests, new since the last harvest:\n\n${sections.join('\n\n')}`
    : 'no side quest has new results (one still running is skipped).'
}

// A band key sent as a prompt (`1`-`9`, `a`, `x`) while the band shows; undefined when it is not one.
async function bandKey($: EngineInterface, text: string): Promise<string | undefined> {
  const { topics, shown } = await shownTopics($)
  const key = text.trim().toLowerCase()
  if (topics.length === 0 || !/^(?:[1-9]|a|x)$/.test(key)) return undefined
  if (key === 'x') {
    await dismiss($)
    return 'Side quests dismissed.'
  }
  if (key === 'a') {
    void forkShown($)
    return `Forking the ${shown.length} side quests shown in the background.`
  }
  const topic = shown[Number(key) - 1]
  if (!topic) return `No side quest ${key}: the band shows ${shown.length}.`
  void forkAndToast($, topic)
  return `Forking "${topic.title}" in the background.`
}

async function forget($: EngineInterface): Promise<void> {
  await saveForks($, (await read($, forksAtom)).filter(fork => fork.state !== 'gone'))
}

function ago(at: number | undefined, now: number): string {
  if (!at) return ''
  const minutes = Math.round((now - at) / 60_000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'quests', description: 'List the side quests in the last answer, each one key away from a fork' })
    await $.command.register({ name: 'dig', description: 'Start a side quest on the topic you type, as a forked background session (/dig <title>: <topic> names it)' })
    await $.command.register({ name: 'questlog', description: "Show this session's side quests and which are ready" })
    await $.command.register({ name: 'harvest', description: 'Bring the conclusions of ready side quests back into this session' })
    // An earlier version pinned the counts with $.ui.status, which outlives a reload.
    $.ui.status(undefined)
    await loadForks($)
    await loadParent($)
    $.clock.every(POLL_MS, () => void poll($))
    return started
  })

  on('command.run', { command: 'quests' }, async ($, e) => ({
    text: e.args.trim() === 'more' ? await showMore($) : await findTopics($),
  }))

  // Band hotkeys need the band focused, so the keys also work sent as a prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    await noteParent($, e.text)
    const handled = await bandKey($, e.text)
    return handled ? { drop: handled } : next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dig' }, async ($, e) => {
    const dig = digTopic(e.args)
    if (!dig) return { text: 'type the topic after the command: /dig <what to dig into>, or /dig <title>: <what to dig into>.' }
    return { text: await forkTopic($, { title: dig.title ?? (await titleFor($, dig.prompt)), prompt: dig.prompt }) }
  })

  // The footer's mode labels compose: each plugin adds its own and passes the list on. The hint line
  // beside them is often redrawn whole by another mod (a PR status line), so the counts stay out of it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const parent = await read($, parentAtom)
    const labels = [parent ? parentLabel(parent) : undefined, forksLabel(await read($, forksAtom))].filter(
      (label): label is string => Boolean(label),
    )
    return next(labels.length > 0 ? { ...e, props: { ...e.props, modes: [...e.props.modes, ...labels] } } : e)
  })

  on('command.run', { command: 'questlog' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Side quests' })
    void poll($)
    return { text: 'quest log opened.' }
  })

  on('command.run', { command: 'harvest' }, async $ => ({ text: await harvest($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { topics, shown, start } = await shownTopics($)
    if (topics.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const end = start + shown.length
    const rest = topics.length - end

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {`Side quests ${start + 1}-${end} of ${topics.length}, by impact. Send a number to fork it, a for these, x to dismiss:`}
        </Text>
        {shown.map((topic, index) => (
          <Button key={`topic-${index}`} hotkey={String(index + 1)} onPress={() => void forkAndToast($, topic)}>
            {`${index + 1}  ${topic.title}`}
          </Button>
        ))}
        {(rest > 0 || start > 0) && (
          <Text dimColor>{rest > 0 ? `+${rest} more · /quests more` : '/quests more goes back to the first page'}</Text>
        )}
        <Box flexDirection="row" gap={2}>
          <Button key="fork-all" hotkey="a" onPress={() => void forkShown($)}>
            {`a  fork these ${shown.length}`}
          </Button>
          <Button key="dismiss" hotkey="x" onPress={() => void dismiss($)}>
            x  dismiss
          </Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const forks = await read($, forksAtom)
    const now = await $.clock.now()
    const columns = e.viewport?.columns ?? 60
    const clip = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text)

    return (
      <Box flexDirection="column">
        {forks.length === 0 && <Text dimColor>No side quests yet. Run /quests after an answer, or /dig &lt;topic&gt;.</Text>}
        {forks.map(fork => (
          <Box flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              {fork.state === 'waiting' ? (
                <Text color="success">{`● ready ${ago(fork.waitingSince, now)}`}</Text>
              ) : fork.state === 'working' ? (
                <Text dimColor>◐ running</Text>
              ) : (
                <Text color="subtle">○ gone</Text>
              )}
              <Text weight="bold">{clip(fork.title, columns - 20)}</Text>
              {fork.harvestedUuid && <Text dimColor>harvested</Text>}
            </Box>
          </Box>
        ))}
        {/* A plain Button draws its hotkey before the label itself (`r: refresh`). */}
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" hotkey="r" plain onPress={() => void poll($)}>
            refresh
          </Button>
          <Button key="forget" hotkey="g" plain onPress={() => void forget($)}>
            forget gone
          </Button>
        </Box>
        <Text dimColor>/harvest brings ready side quests' conclusions here.</Text>
      </Box>
    )
  })
}

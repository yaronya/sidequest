import type { Fork, ForkState, ParentLink, Topic } from '../types'

export const MAX_TOPICS = 30
// One band page: the number keys 1-9.
export const PAGE_SIZE = 9
const ANSWER_HEAD_CHARS = 16_000
const ANSWER_TAIL_CHARS = 4_000
const MAX_EXCERPT_CHARS = 14_000

// A long answer keeps its start, where reports put the biggest findings, and its end, where the open questions go.
export function answerExcerpt(answer: string): string {
  if (answer.length <= ANSWER_HEAD_CHARS + ANSWER_TAIL_CHARS) return answer
  return `${answer.slice(0, ANSWER_HEAD_CHARS)}\n\n[… middle of the answer left out …]\n\n${answer.slice(-ANSWER_TAIL_CHARS)}`
}

// The topics a band page shows, and where that page starts, kept inside the list.
export function pageOf<T>(topics: T[], offset: number): { shown: T[]; start: number } {
  const start = offset < topics.length ? offset : 0
  return { shown: topics.slice(start, start + PAGE_SIZE), start }
}

// The offset of the page after the one at `offset`, back to the first after the last.
export const nextPage = (count: number, offset: number) => (offset + PAGE_SIZE < count ? offset + PAGE_SIZE : 0)

// Leads every fork's session name, so `claude agents` tells forks apart from sessions started by hand.
export const FORK_MARK = '⑂'
const MAX_TITLE_CHARS = 40
// A cut title ends on a word that carries meaning, never on "and", "with" or "the".
const DANGLING_WORDS = /(?:\s+(?:a|an|and|at|by|for|from|in|of|on|or|the|to|via|vs|with))+$/i

// One line of plain words, cut at a word boundary: a model's reply or a typed title, made fit to name a session.
export function cleanTitle(raw: string): string {
  const line = (raw.trim().split('\n')[0] ?? '')
    .replace(/^title:\s*/i, '')
    .replace(/^["'`*_\s]+|["'`*_\s.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
  if (line.length <= MAX_TITLE_CHARS) return line
  const cut = line.slice(0, MAX_TITLE_CHARS + 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : line.slice(0, MAX_TITLE_CHARS)).replace(/[\s.,;:-]+$/, '').replace(DANGLING_WORDS, '')
}

// A fork's session name: the mark, then its title; a title this session already used gets a number.
export function forkName(title: string, taken: readonly string[]): string {
  const base = `${FORK_MARK} ${title || 'Topic'}`
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`
  return name
}

// What the footer says about this session's forks; undefined when none is running or ready.
export function forksLabel(forks: readonly Fork[]): string | undefined {
  const ready = forks.filter(fork => fork.state === 'waiting').length
  const running = forks.filter(fork => fork.state === 'working').length
  const parts = [ready > 0 && `${ready} ready`, running > 0 && `${running} running`].filter(Boolean)
  return parts.length > 0 ? `${FORK_MARK} ${parts.join(' · ')}` : undefined
}

export const topicsRequest = (answer: string) =>
  [
    'Below is the last answer in a working session. List every distinct thread in it that deserves its own deep dive or discussion:',
    'findings, questions, options, risks, follow-ups or investigations. A finding that comes with a proposed fix still counts: validating or carrying out the fix is a deep dive.',
    'Merge items that share a root cause or the same action into one topic. Rank by impact, highest first: dollars for cost findings, otherwise risk or importance.',
    `Return only a JSON array of at most ${MAX_TOPICS} objects: {"title": "<3-6 words>", "prompt": "<one or two sentences telling a session what to dig into, self-contained, with any figure the answer gave>"}.`,
    'Return [] when there is one thread or none.',
    '',
    '<answer>',
    answerExcerpt(answer),
    '</answer>',
  ].join('\n')

export function parseTopics(reply: string): Topic[] {
  const match = reply.match(/\[[\s\S]*\]/)
  if (!match) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(
      (item): item is Topic =>
        typeof item === 'object' && item !== null && typeof item.title === 'string' && typeof item.prompt === 'string',
    )
    .map(({ title, prompt }) => ({ title: cleanTitle(title), prompt: prompt.trim() }))
    .filter(topic => topic.title && topic.prompt)
    .slice(0, MAX_TOPICS)
}

// Opens with the parent's id and name: the fork reads its parent back from there (parentOf).
export const forkPrompt = (topic: Topic, parent: ParentLink) =>
  `Fork of session ${parent.sessionId} ("${parent.name}"): deep dive on this one topic only, "${topic.title}". ${topic.prompt}\n\nThe parent session carries on with the other threads, so stay on this one.`

const FORK_OF = /^Fork of session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \("([^"\n]*)"\):/

// The parent a fork prompt names; undefined for any other prompt.
export function parentOf(prompt: string): ParentLink | undefined {
  const match = prompt.match(FORK_OF)
  return match?.[1] ? { sessionId: match[1], name: match[2] || match[1].slice(0, 8) } : undefined
}

// A session's name made fit for the fork prompt's quotes and the footer: no fork mark, no double quote, one short line.
export const parentName = (name: string | undefined, sessionId: string) =>
  cleanTitle((name ?? '').replace(new RegExp(`^${FORK_MARK}\\s*`), '').replace(/"/g, "'")) || sessionId.slice(0, 8)

// A fork keeps its parent under its own session id, so a resume finds it again.
export const parentKey = (sessionId: string) => `parent:${sessionId}`

export const parentLabel = (parent: ParentLink) => `${FORK_MARK} from ${parent.name}`

// `/dig <title>: <prompt>` names the fork itself; with no short title before `: `, the title is left to the model.
export function digTopic(text: string): { prompt: string; title?: string } | undefined {
  const typed = text.trim()
  if (!typed) return undefined
  const match = typed.match(/^([^:\n]+):\s+(\S[\s\S]*)$/)
  const title = match?.[1] && match[1].trim().split(/\s+/).length <= 6 ? cleanTitle(match[1]) : ''
  return title && match?.[2] ? { title, prompt: match[2].trim() } : { prompt: typed }
}

// The title when the model gives none: the first words typed.
export const fallbackTitle = (prompt: string) => cleanTitle(prompt.split(/\s+/).slice(0, 6).join(' '))

export const titleRequest = (prompt: string) =>
  [
    'Write a 3 to 5 word title for the topic below, for a list of parallel work sessions.',
    "Name the subject, not the action or the filler around it: 'Cache eviction plan', not 'So to fix the'. Keep acronyms and ticket ids.",
    'Reply with the title only: no quotes, no trailing period.',
    '',
    '<topic>',
    prompt.slice(0, 4_000),
    '</topic>',
  ].join('\n')

// `claude --bg` prints `backgrounded · <id> · <name>`.
export function parseBackgrounded(stdout: string): string | undefined {
  return stdout.match(/backgrounded\s+·\s+([0-9a-f]+)\s+·/)?.[1]
}

export type Agent = { id?: string; sessionId?: string; name?: string; status?: string; state?: string; cwd?: string }

export function stateOf(agent: Agent | undefined): ForkState {
  if (!agent) return 'gone'
  // Seen: busy/working while a turn runs, idle/done once it ends; anything else waits on the person.
  return agent.status === 'busy' || agent.state === 'working' ? 'working' : 'waiting'
}

// New fork states from `claude agents --json --all`, and the titles that just started waiting.
export function applyAgents(forks: Fork[], agents: Agent[], now: number): { forks: Fork[]; nowWaiting: string[] } {
  const nowWaiting: string[] = []
  const next = forks.map(fork => {
    const agent = agents.find(a => a.id === fork.id)
    const state = stateOf(agent)
    if (state === 'waiting' && fork.state !== 'waiting') nowWaiting.push(fork.title)
    return {
      ...fork,
      sessionId: fork.sessionId ?? agent?.sessionId,
      state,
      waitingSince: state === 'waiting' ? (fork.state === 'waiting' ? fork.waitingSince : now) : undefined,
    }
  })
  return { forks: next, nowWaiting }
}

// Where Claude Code keeps a session's transcript.
export const transcriptPath = (home: string, cwd: string, sessionId: string) =>
  `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`

type Line = { uuid?: string; type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(block => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text as string)
          .join('\n')
      : ''

// The conversation the fork had after its own prompt (and after `afterUuid`, what an earlier harvest took), as text.
export function forkExcerpt(jsonl: string, prompt: string, afterUuid?: string): { excerpt: string; lastUuid?: string } {
  const messages: { uuid?: string; role: string; text: string }[] = []
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const role = line.message?.role
    if ((line.type !== 'user' && line.type !== 'assistant') || line.isMeta || (role !== 'user' && role !== 'assistant')) continue
    const text = textOf(line.message?.content).trim()
    if (text && !text.startsWith('<')) messages.push({ uuid: line.uuid, role, text })
  }

  const marker = prompt.slice(0, 80)
  const promptAt = messages.findLastIndex(m => m.role === 'user' && m.text.includes(marker))
  const harvestedAt = afterUuid ? messages.findIndex(m => m.uuid === afterUuid) : -1
  const fresh = messages.slice(Math.max(promptAt, harvestedAt) + 1)
  const excerpt = fresh.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n\n')
  return { excerpt: excerpt.slice(-MAX_EXCERPT_CHARS), lastUuid: fresh.at(-1)?.uuid }
}

export const harvestRequest = (title: string, excerpt: string) =>
  [
    `A forked session dug into "${title}". Below is what it found and discussed.`,
    'Summarize for the parent session in at most 6 short bullets: conclusions, decisions taken, and open questions. Plain text, no preamble.',
    '',
    '<fork>',
    excerpt,
    '</fork>',
  ].join('\n')

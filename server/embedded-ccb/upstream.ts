/** CCB extracts at 963e0013184ecc1521289a0fc7d5da4bb6e45356.
 * Only structural message and tool-safety dependencies are substituted.
 */
import type { Continue, Terminal } from './transitions'

type Message = { type: 'user' } | { type: 'assistant'; message: { id: string } }

/** Adapted from query.ts assistant-stream accumulation. */
export function collectToolUses<T extends { type: string }>(
  assistantMessage: { message: { content: readonly T[] } },
) {
  const toolUseBlocks: Extract<T, { type: 'tool_use' }>[] = []
  let needsFollowUp = false
  const msgToolUseBlocks = assistantMessage.message.content.filter(
    (content): content is Extract<T, { type: 'tool_use' }> => content.type === 'tool_use',
  )
  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }
  return { toolUseBlocks, needsFollowUp }
}

/** Adapted from query.ts's next state after the non-streaming tool batch. */
export function nextToolTurn<T>(
  messagesForQuery: T[], assistantMessages: T[], toolResults: T[], turnCount: number, maxTurns: number,
): Extract<Terminal, { reason: 'max_turns' }> | {
  messages: T[]; turnCount: number; transition: Extract<Continue, { reason: 'next_turn' }>
} {
  const nextTurnCount = turnCount + 1
  if (maxTurns && nextTurnCount > maxTurns) {
    return { reason: 'max_turns', turnCount: nextTurnCount }
  }
  return {
    messages: messagesForQuery.concat(assistantMessages, toolResults),
    turnCount: nextTurnCount,
    transition: { reason: 'next_turn' },
  }
}

export function groupMessagesByApiRound<T extends Message>(messages: T[]): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  // message.id of the most recently seen assistant. This is the sole
  // boundary gate: streaming chunks from the same API response share an
  // id, so boundaries only fire at the start of a genuinely new round.
  // normalizeMessages yields one AssistantMessage per content block, and
  // StreamingToolExecutor interleaves tool_results between chunks live
  // (yield order, not concat order — see query.ts:613). The id check
  // correctly keeps `[tu_A(id=X), result_A, tu_B(id=X)]` in one group.
  let lastAssistantId: string | undefined

  // In a well-formed conversation the API contract guarantees every
  // tool_use is resolved before the next assistant turn, so lastAssistantId
  // alone is a sufficient boundary gate. Tracking unresolved tool_use IDs
  // would only do work when the conversation is malformed (dangling tool_use
  // after resume-from-partial-batch or max_tokens truncation) — and in that
  // case it pins the gate shut forever, merging all subsequent rounds into
  // one group. We let those boundaries fire; the summarizer fork's own
  // ensureToolResultPairing at claude.ts:1136 repairs the dangling tu at
  // API time.
  for (const msg of messages) {
    if (
      msg.type === 'assistant' &&
      msg.message!.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message!.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

type Batch<T> = { isConcurrencySafe: boolean; blocks: T[] }

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
export function partitionToolCalls<T>(
  toolUseMessages: readonly T[],
  canRunConcurrently: (tool: T) => boolean,
): Batch<T>[] {
  return toolUseMessages.reduce((acc: Batch<T>[], toolUse) => {
    const isConcurrencySafe = (() => {
      try { return Boolean(canRunConcurrently(toolUse)) }
      catch { return false }
    })()
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

type QueuedGenerator<A> = {
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> return type
  done: boolean | void
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> yield type
  value: A | void
  generator: AsyncGenerator<A, void>
  promise: Promise<QueuedGenerator<A>>
}

// Run all generators concurrently up to a concurrency cap, yielding values as they come in
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }))
    return promise
  }
  const waiting = [...generators]
  const promises = new Set<Promise<QueuedGenerator<A>>>()

  // Start initial batch up to concurrency cap
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!
    promises.add(next(gen))
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise)

    if (!done) {
      promises.add(next(generator))
      // TODO: Clean this up
      if (value !== undefined) {
        yield value as Awaited<A>
      }
    } else if (waiting.length > 0) {
      // Start a new generator when one finishes
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}


export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // Strip analysis section — it's a drafting scratchpad that improves summary
  // quality but has no informational value once the summary is written.
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // Extract and format summary section
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}


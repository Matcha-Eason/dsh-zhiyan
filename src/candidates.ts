import type { PrefixCandidate } from './protocol.ts'

/** Candidate boundaries preserve original UTF-16 offsets; the decision model judges completeness. */
export function prefixCandidates(draft: string): PrefixCandidate[] {
  const boundaries: Omit<PrefixCandidate, 'id'>[] = []
  const closing: string[] = []
  const pairs: Record<string, string> = { '(': ')', '（': '）', '[': ']', '{': '}', '“': '”', '「': '」', '『': '』' }
  let quote = ''
  let escaped = false
  for (let i = 0; i < draft.length; i++) {
    const char = draft[i]!
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === '`') { quote = char; continue }
    if (pairs[char]) { closing.push(pairs[char]!); continue }
    if (closing.length) { if (char === closing.at(-1)) closing.pop(); continue }
    if (!/[，,。！？!?；;\n]/u.test(char)) continue
    let sendEnd = i
    while (sendEnd > 0 && /[\s，,。！？!?；;]/u.test(draft[sendEnd - 1]!)) sendEnd--
    let consumeEnd = i + 1
    while (consumeEnd < draft.length && /[\s，,。！？!?；;]/u.test(draft[consumeEnd]!)) consumeEnd++
    if (draft.slice(0, sendEnd).trim().length >= 4 && !boundaries.some(item => item.sendEnd === sendEnd)) {
      boundaries.push({ sendEnd, consumeEnd })
    }
  }
  // An unfinished quote or bracket also makes the complete-draft candidate premature.
  const end = draft.trimEnd().length
  if (!quote && closing.length === 0 && end >= 4 && !/[，,。！？!?；;]/u.test(draft[end - 1]!)
    && !boundaries.some(item => item.sendEnd === end)) boundaries.push({ sendEnd: end, consumeEnd: draft.length })
  const complete = boundaries.filter(item => !/(?:然后|另外|接着|并且|同时|以及|是否|如果|除非|不对|但是|不过|因为|所以|关于|这个|那个)$/u.test(draft.slice(0, item.sendEnd).trim()))
  const selected = complete.length <= 3 ? complete : [complete[0]!, ...complete.slice(-2)]
  return selected.map((item, index) => ({ ...item, id: `c${index}` }))
}

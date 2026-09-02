import { createHash } from 'node:crypto'

export const PLAN_IMPORT_VERSION = 1
export const PLAN_IMPORT_MAX_BYTES = 256 * 1024
export const PLAN_IMPORT_MAX_LINES = 6000

/**
 * Deterministic Markdown plan importer.
 *
 * Supports a strict subset of Markdown covering the conventions used by the
 * Etsy MASTER_PLAN.md family of planning documents:
 *
 *   - top-level `# Project Title` with optional status block (`**Status:**`).
 *   - `# N. Objective` first-level section whose body becomes `objective`.
 *   - `# Story N — Title` for stories.
 *   - Story subsections (`## Objective`, `## Implementation decision`,
 *     `## Tool contract`, `## Ordered plan`, `## Target files/symbols`,
 *     `## Dependencies`, `## Scope boundaries`, `## Required invariants`,
 *     `## Acceptance criteria`, `## Validation`, `## Deviation policy`,
 *     `## Completion receipt`).
 *   - `## Tranche X — Title` sections with `Exit criterion:` quote blocks
 *     and `Implement:` ordered lists.
 *   - `# N. MVP Completion Criteria` with a numbered list of criteria.
 *
 * Preview is mutation-free and returns the proposed objects plus a
 * deterministic checksum, warnings, and unresolved dependency references.
 *
 * Apply requires the checksum plus optional source identity, persists the
 * source label and checksum on the created project, and is idempotent when
 * the same identity+checksum pair is replayed.
 */

function checksum(text) {
  return createHash('sha256').update(text).digest('hex')
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(label + ' must be a non-empty string')
  return value.trim()
}

function optionalString(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new TypeError('value must be a string')
  const v = value.trim()
  return v === '' ? null : v
}

function validateInput(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string')
  if (markdown.length === 0) throw new TypeError('markdown must be non-empty')
  const byteLength = Buffer.byteLength(markdown, 'utf8')
  if (byteLength > PLAN_IMPORT_MAX_BYTES) {
    const err = new TypeError('markdown exceeds maximum size (' + PLAN_IMPORT_MAX_BYTES + ' bytes)')
    err.code = 'PLAN_IMPORT_TOO_LARGE'
    throw err
  }
  const lineCount = markdown.split('\n').length
  if (lineCount > PLAN_IMPORT_MAX_LINES) {
    const err = new TypeError('markdown exceeds maximum line count (' + PLAN_IMPORT_MAX_LINES + ')')
    err.code = 'PLAN_IMPORT_TOO_LARGE'
    throw err
  }
  return markdown
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n')
}

function slugify(value) {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'section' : slug
}

function uniqueSlug(prefix, title, taken) {
  const base = prefix + '-' + slugify(title).slice(0, 64)
  let candidate = base
  let n = 1
  while (taken.has(candidate)) {
    n += 1
    candidate = base + '-' + n
  }
  taken.add(candidate)
  return candidate
}

function parseHeadingLine(line) {
  const match = line.match(/^(#{1,6})\s+(.*)$/)
  if (!match) return null
  return { level: match[1].length, text: match[2].trim() }
}

function listDepth(line) {
  let depth = 0
  while (depth < line.length && line[depth] === ' ') depth += 1
  const trimmed = line.slice(depth)
  const orderedMatch = trimmed.match(/^(\d+)\.\s+/)
  const unorderedMatch = trimmed.match(/^[-*]\s+/)
  if (orderedMatch) return { depth, ordered: true, start: Number(orderedMatch[1]), content: trimmed.slice(orderedMatch[0].length) }
  if (unorderedMatch) return { depth, ordered: false, content: trimmed.slice(unorderedMatch[0].length) }
  return null
}

function splitNumberedHeading(text) {
  const match = text.match(/^(?:(\d+)\.\s+)?(.*?)\s*$/)
  if (!match) return { number: null, title: text }
  return { number: match[1] ?? null, title: (match[2] ?? '').trim() }
}

function extractFencedBlocks(text) {
  const out = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const fence = lines[i].match(/^```(\w*)\s*$/)
    if (fence) {
      const language = fence[1] || ''
      const start = i
      i += 1
      const body = []
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        body.push(lines[i])
        i += 1
      }
      if (i >= lines.length) break
      i += 1
      out.push({ language, body: body.join('\n'), start, end: i })
      continue
    }
    i += 1
  }
  return out
}

function collectBlockquote(text) {
  const lines = text.split('\n').filter(line => line.startsWith('>'))
  return lines.map(line => line.replace(/^>\s?/, '')).join('\n').trim()
}

function collectListItems(text) {
  const lines = text.split('\n')
  const items = []
  let current = null
  for (const line of lines) {
    if (line.trim() === '') {
      if (current) { items.push(current); current = null }
      continue
    }
    const parsed = listDepth(line)
    if (parsed) {
      if (current) items.push(current)
      current = { depth: parsed.depth, ordered: parsed.ordered, start: parsed.start ?? null, content: parsed.content }
    } else if (current) {
      current.content += '\n' + line.replace(/^\s+/, '')
    }
  }
  if (current) items.push(current)
  return items
}

function extractStatusFromHeader(text) {
  const match = text.match(/\*\*Status:\*\*\s+([^*\n]+)/)
  return match ? match[1].trim() : null
}

function parseAcceptanceCriteria(text) {
  const lines = text.split('\n')
  const items = []
  let mode = null
  for (const line of lines) {
    const given = line.match(/^\s*GIVEN\s+(.*)$/)
    const when = line.match(/^\s*WHEN\s+(.*)$/)
    const then = line.match(/^\s*THEN\s+(.*)$/)
    if (given) { mode = 'given'; items.push({ kind: 'given', text: given[1].trim() }); continue }
    if (when) { mode = 'when'; items.push({ kind: 'when', text: when[1].trim() }); continue }
    if (then) { mode = 'then'; items.push({ kind: 'then', text: then[1].trim() }); continue }
    const dash = line.match(/^\s*[-*]\s+(.*)$/)
    if (dash) { items.push({ kind: 'item', text: dash[1].trim() }); mode = null; continue }
    if (line.trim() === '') { mode = null; continue }
  }
  return items
}

function parseValidation(text) {
  const lines = text.split('\n')
  const out = []
  for (const line of lines) {
    const match = line.match(/^\s*```(\w*)\s*$/)
    if (match) continue
    const cmd = line.replace(/^\s*\$\s*/, '').trim()
    if (cmd) out.push(cmd)
  }
  return out
}

function parseDependencies(text) {
  const result = { blocked_by: [], enables: [], raw: text.trim() }
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\s*[-*]\s+/, '').trim()
    if (trimmed === '') continue
    const blocked = trimmed.match(/^Blocked\s+by:\s*(.+)$/i)
    if (blocked) {
      for (const ref of blocked[1].split(/,\s*/)) if (ref.trim() !== '') result.blocked_by.push(ref.trim())
      continue
    }
    const enables = trimmed.match(/^Enables:\s*(.+)$/i)
    if (enables) {
      for (const ref of enables[1].split(/,\s*/)) if (ref.trim() !== '') result.enables.push(ref.trim())
      continue
    }
    const follows = trimmed.match(/^Usually\s+follows:\s*(.+)$/i)
    if (follows) {
      for (const ref of follows[1].split(/,\s*/)) if (ref.trim() !== '') result.enables.push(ref.trim())
      continue
    }
  }
  return result
}

function parseScopeBoundaries(text) {
  const items = collectListItems(text)
  return items.filter(item => item.depth <= 2).map(item => item.content.trim()).filter(item => item !== '')
}

function parseInvariants(text) {
  const items = collectListItems(text)
  return items.filter(item => item.depth <= 2).map(item => item.content.trim()).filter(item => item !== '')
}

function parseTargetFiles(text) {
  const items = collectListItems(text)
  return items.filter(item => item.depth <= 2).map(item => item.content.trim()).filter(item => item !== '')
}

function parseOrderedPlan(text) {
  const items = collectListItems(text)
  return items.filter(item => item.ordered).map(item => item.content.trim()).filter(item => item !== '')
}

function normalizeDependencyReference(ref, storyById, storyByTitle, stories, ambiguousTitles = new Set()) {
  const trimmed = ref.replace(/[`*]/g, '').trim()
  const slug = slugify(trimmed)
  if (storyById.has(slug)) return { resolved: true, target_id: slug, target_title: storyById.get(slug).title }
  const titleKey = trimmed.toLowerCase()
  if (ambiguousTitles.has(titleKey)) return { resolved: false, ambiguous: true, target: trimmed }
  if (storyByTitle.has(titleKey)) return { resolved: true, target_id: storyByTitle.get(titleKey), target_title: trimmed }
  const withoutPrefix = trimmed.replace(/^Story\s+\d+\s*[—:-]\s*/i, '').trim()
  const withoutPrefixKey = withoutPrefix.toLowerCase()
  if (ambiguousTitles.has(withoutPrefixKey)) return { resolved: false, ambiguous: true, target: withoutPrefix }
  if (storyByTitle.has(withoutPrefixKey)) return { resolved: true, target_id: storyByTitle.get(withoutPrefixKey), target_title: withoutPrefix }
  if (stories) {
    for (const story of stories) {
      if (story.number !== null && trimmed.toLowerCase() === ('story ' + story.number).toLowerCase()) return { resolved: true, target_id: story.id, target_title: story.title }
      if (story.number !== null && trimmed.toLowerCase() === ('story ' + story.number + ' ' + story.title).toLowerCase()) return { resolved: true, target_id: story.id, target_title: story.title }
    }
  }
  return { resolved: false, target: trimmed }
}

function detectSections(text) {
  const lines = text.split('\n')
  const headings = []
  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseHeadingLine(lines[i])
    if (heading) headings.push({ index: i, heading })
  }
  const sections = []
  for (let i = 0; i < headings.length; i += 1) {
    const current = headings[i]
    let end = lines.length
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].heading.level <= current.heading.level) { end = headings[j].index; break }
    }
    sections.push({ heading: current.heading, start: current.index + 1, end })
  }
  return sections
}

export { detectSections, findTrancheSubsections, sectionBody }

function sectionBody(sections, index, text) {
  const lines = text.split('\n')
  const section = sections[index]
  return lines.slice(section.start, section.end).join('\n').trim()
}

function detectProjectTitle(text) {
  const lines = text.split('\n')
  for (const line of lines) {
    const heading = parseHeadingLine(line)
    if (heading && heading.level === 1 && !/^Story\s/i.test(heading.text) && !/^Tranche\s/i.test(heading.text) && !/^\d+\.\s/.test(heading.text)) {
      return heading.text
    }
  }
  return null
}

function detectProjectStatus(text) {
  const statusMatch = text.match(/\*\*Status:\*\*\s+([^*\n]+)/)
  if (!statusMatch) return 'planning'
  const normalized = statusMatch[1].trim().toLowerCase()
  if (['planning', 'active', 'blocked', 'completed', 'cancelled'].includes(normalized)) return normalized
  return 'planning'
}

function detectObjectives(text, sections) {
  const idx = sections.findIndex(s => s.heading.level === 1 && /^\d+\.\s+Objective/i.test(s.heading.text))
  if (idx === -1) return null
  return sectionBody(sections, idx, text)
}

function detectMvpCompletionCriteria(text, sections) {
  const idx = sections.findIndex(s => s.heading.level === 1 && /MVP Completion Criteria/i.test(s.heading.text))
  if (idx === -1) return []
  const body = sectionBody(sections, idx, text)
  const items = collectListItems(body)
  return items.filter(item => item.ordered).map(item => item.content.trim()).filter(item => item !== '')
}

function detectStories(text, sections) {
  const stories = []
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i]
    if (section.heading.level !== 1) continue
    const match = section.heading.text.match(/^Story\s+(\d+)\s*[—:-]\s*(.+)$/i)
    if (!match) continue
    stories.push({ heading_index: i, number: Number(match[1]), title: match[2].trim() })
  }
  return stories
}

function detectTranches(text, sections) {
  const tranches = []
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i]
    if (section.heading.level !== 2) continue
    const match = section.heading.text.match(/^Tranche\s+([A-Z0-9]+)\s*[—:-]\s*(.+)$/i)
    if (!match) continue
    tranches.push({ heading_index: i, code: match[1], title: match[2].trim() })
  }
  return tranches
}

function findStorySubsections(storyIndex, sections) {
  const result = {}
  for (let i = storyIndex + 1; i < sections.length; i += 1) {
    if (sections[i].heading.level <= sections[storyIndex].heading.level) break
    if (sections[i].heading.level === 2) result[sections[i].heading.text.toLowerCase()] = i
  }
  return result
}

function findTrancheSubsections(trancheIndex, sections, text) {
  const result = {}
  for (let i = trancheIndex + 1; i < sections.length; i += 1) {
    if (sections[i].heading.level <= sections[trancheIndex].heading.level) break
    if (sections[i].heading.level === 3) result[sections[i].heading.text.toLowerCase()] = i
  }
  if (Object.keys(result).length === 0) {
    // Plain-text subsections (Etsy MASTER_PLAN style): scan body for `Implement:` and `Exit criterion:`
    const tranche = sections[trancheIndex]
    const lines = text.split('\n').slice(tranche.start, tranche.end)
    let implementStart = -1
    let implementEnd = -1
    let exitStart = -1
    let exitEnd = -1
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim()
      if (implementStart === -1 && /^Implement:\s*$/i.test(trimmed)) { implementStart = tranche.start + i + 1; continue }
      if (implementStart !== -1 && implementEnd === -1 && /^Exit\s+[Cc]riterion:/i.test(trimmed)) { implementEnd = tranche.start + i }
      if (exitStart === -1 && /^Exit\s+[Cc]riterion:\s*$/i.test(trimmed)) { exitStart = tranche.start + i + 1; exitEnd = tranche.end }
    }
    if (implementStart !== -1) {
      result['implement'] = { bodyStart: implementStart, bodyEnd: implementEnd !== -1 ? implementEnd : tranche.end }
    }
    if (exitStart !== -1) {
      result['exit'] = { bodyStart: exitStart, bodyEnd: exitEnd }
    }
  }
  return result
}

function trancheBodyFromInline(subsection, text) {
  return text.split('\n').slice(subsection.bodyStart, subsection.bodyEnd).join('\n').trim()
}

function detectUnresolvedReferences(storyRefs, trancheRefs, storyByTitle, stories, ambiguousTitles = new Set()) {
  const unresolved = []
  const seen = new Set()
  for (const story of storyRefs) {
    for (const ref of story.blocked_by) {
      const match = normalizeDependencyReference(ref, new Map(stories.map(s => [s.id, { title: s.title }])), storyByTitle, stories, ambiguousTitles)
      if (!match.resolved) {
        const key = 'story:' + story.id + ':blocked:' + ref
        if (!seen.has(key)) { unresolved.push({ from: story.id, kind: 'blocked_by', target: ref, resolved: false, ...(match.ambiguous ? { ambiguous: true } : {}) }); seen.add(key) }
      }
    }
    for (const ref of story.enables) {
      const match = normalizeDependencyReference(ref, new Map(stories.map(s => [s.id, { title: s.title }])), storyByTitle, stories, ambiguousTitles)
      if (!match.resolved) {
        const key = 'story:' + story.id + ':enables:' + ref
        if (!seen.has(key)) { unresolved.push({ from: story.id, kind: 'enables', target: ref, resolved: false, ...(match.ambiguous ? { ambiguous: true } : {}) }); seen.add(key) }
      }
    }
  }
  for (const tranche of trancheRefs) {
    for (const ref of tranche.story_refs) {
      const match = normalizeDependencyReference(ref, new Map(stories.map(s => [s.id, { title: s.title }])), storyByTitle, stories, ambiguousTitles)
      if (!match.resolved) {
        const key = 'tranche:' + tranche.id + ':story:' + ref
        if (!seen.has(key)) { unresolved.push({ from: tranche.id, kind: 'implements_story', target: ref, resolved: false, ...(match.ambiguous ? { ambiguous: true } : {}) }); seen.add(key) }
      }
    }
  }
  return unresolved
}

export function parsePlanImport(markdown, _debug = false) {
  validateInput(markdown)
  const text = normalizeNewlines(markdown)
  const sections = detectSections(text)
  if (sections.length === 0) {
    const err = new TypeError('markdown must contain at least one heading')
    err.code = 'PLAN_IMPORT_EMPTY'
    throw err
  }

  const title = detectProjectTitle(text)
  if (!title) {
    const err = new TypeError('markdown must begin with a project title heading')
    err.code = 'PLAN_IMPORT_NO_TITLE'
    throw err
  }

  const idTaken = new Set()
  const slug = uniqueSlug('project', title, idTaken)

  const project = {
    id: slug,
    title,
    status: detectProjectStatus(text),
    objective: detectObjectives(text, sections),
    stories: [],
    tranches: [],
    completion_criteria: detectMvpCompletionCriteria(text, sections),
    metadata: { source_format: 'plan-import/v' + PLAN_IMPORT_VERSION },
  }

  const detectedStories = detectStories(text, sections)
  const storyByTitle = new Map()
  const ambiguousTitles = new Set()
  const storyById = new Map()

  for (const detected of detectedStories) {
    const storyId = uniqueSlug('story', detected.title, idTaken)
    const subsections = findStorySubsections(detected.heading_index, sections)
    const get = (name) => subsections[name] !== undefined ? sectionBody(sections, subsections[name], text) : null
    const orderedPlanItems = parseOrderedPlan(get('ordered plan') ?? '')
    const targetFiles = parseTargetFiles(get('target files/symbols') ?? '')
    const scope = parseScopeBoundaries(get('scope boundaries') ?? '')
    const invariants = parseInvariants(get('required invariants') ?? '')
    const acceptanceRaw = parseAcceptanceCriteria(get('acceptance criteria') ?? '')
    const validation = parseValidation(get('validation') ?? '')
    const dependencies = parseDependencies(get('dependencies') ?? '')
    const story = {
      id: storyId,
      number: detected.number,
      title: detected.title,
      objective: get('objective'),
      implementation_decision: get('implementation decision'),
      tool_contract: get('tool contract'),
      ordered_plan: orderedPlanItems,
      target_files: targetFiles,
      scope_boundaries: scope,
      required_invariants: invariants,
      acceptance_criteria: acceptanceRaw.map(criterion => criterion.text),
      validation,
      blocked_by: dependencies.blocked_by,
      enables: dependencies.enables,
      deviation_policy: get('deviation policy'),
      completion_receipt: get('completion receipt'),
    }
    project.stories.push(story)
    const titleKey = story.title.toLowerCase()
    if (storyByTitle.has(titleKey)) {
      storyByTitle.delete(titleKey)
      ambiguousTitles.add(titleKey)
    } else if (!ambiguousTitles.has(titleKey)) {
      storyByTitle.set(titleKey, story.id)
    }
    storyById.set(story.id, { title: story.title })
  }

  const detectedTranches = detectTranches(text, sections)
  for (const detected of detectedTranches) {
    const trancheId = uniqueSlug('tranche', detected.title, idTaken)
    const subsections = findTrancheSubsections(detected.heading_index, sections, text)
    let implementText = ''
    let exitText = null
    if (subsections.implement !== undefined) {
      if (typeof subsections.implement === 'number') implementText = sectionBody(sections, subsections.implement, text)
      else implementText = trancheBodyFromInline(subsections.implement, text)
    }
    if (subsections.exit !== undefined) {
      if (typeof subsections.exit === 'number') exitText = sectionBody(sections, subsections.exit, text)
      else exitText = trancheBodyFromInline(subsections.exit, text)
    }
    const implementItems = parseOrderedPlan(implementText)
    const storyRefs = []
    for (const line of implementText.split('\n')) {
      const backtick = line.match(/`([^`]+)`/g)
      if (backtick) for (const ref of backtick) storyRefs.push(ref.replace(/`/g, '').trim())
      const m = line.match(/^[-\s]+\*?\*?Story\s+\d+\s*[—:-]\s*([^.\n]+)/i)
      if (m) storyRefs.push(m[1].trim())
    }
    const tranche = {
      id: trancheId,
      code: detected.code,
      title: detected.title,
      implement: implementItems,
      exit_criterion: exitText ? collectBlockquote(exitText) : null,
      story_refs: storyRefs.filter((ref, index) => storyRefs.indexOf(ref) === index),
    }
    project.tranches.push(tranche)
  }

  const warnings = []
  if (ambiguousTitles.size > 0) warnings.push({ code: 'PLAN_IMPORT_AMBIGUOUS_STORY_TITLE', message: 'duplicate story titles will not be resolved by title: ' + Array.from(ambiguousTitles).sort().join(', ') })
  if (!project.objective) warnings.push({ code: 'PLAN_IMPORT_NO_OBJECTIVE', message: 'no objective section found; using empty objective' })
  if (project.completion_criteria.length === 0) warnings.push({ code: 'PLAN_IMPORT_NO_COMPLETION_CRITERIA', message: 'no MVP completion criteria section found' })
  if (project.stories.length === 0) warnings.push({ code: 'PLAN_IMPORT_NO_STORIES', message: 'no story sections found' })

  const unresolvedReferences = detectUnresolvedReferences(project.stories, project.tranches, storyByTitle, project.stories, ambiguousTitles)

  const sourceChecksum = checksum(text)
  const proposalId = createHash('sha256').update(JSON.stringify({ slug, checksum: sourceChecksum })).digest('hex')

  return {
    proposal_id: proposalId,
    source_checksum: sourceChecksum,
    version: PLAN_IMPORT_VERSION,
    project,
    unresolved_references: unresolvedReferences,
    warnings,
  }
}

export function previewPlanImport(markdown, options = {}) {
  const proposal = parsePlanImport(markdown)
  return {
    proposal_id: proposal.proposal_id,
    source_checksum: proposal.source_checksum,
    version: proposal.version,
    project: proposal.project,
    unresolved_references: proposal.unresolved_references,
    warnings: proposal.warnings,
    source_label: optionalString(options.source_label ?? options.sourceLabel) ?? null,
  }
}

/**
 * Apply a previously-previewed plan to a store.
 *
 * @param {object} store - the TaskStore instance
 * @param {string} markdown - raw plan content (must match the preview's source_checksum when provided)
 * @param {object} options - { source_label, source_checksum, proposal_id, dry_run, actor }
 *
 * Returns the resulting project, milestones, and tasks, plus replay metadata.
 *
 * The apply is idempotent: if a project with the same source_label and source_checksum
 * already exists, the existing project is returned with `replayed: true` and no mutation.
 * If source_label matches but source_checksum differs, apply fails with PLAN_IMPORT_SOURCE_CONFLICT.
 */
export function applyPlanImport(store, markdown, options = {}) {
  const parsed = parsePlanImport(markdown)
  const sourceLabel = optionalString(options.source_label ?? options.sourceLabel)
  const expectedChecksum = optionalString(options.source_checksum ?? options.sourceChecksum)
  if (expectedChecksum && expectedChecksum !== parsed.source_checksum) {
    const err = new TypeError('source_checksum does not match the parsed content')
    err.code = 'PLAN_IMPORT_CHECKSUM_MISMATCH'
    throw err
  }
  if (options.proposal_id && options.proposal_id !== parsed.proposal_id) {
    const err = new TypeError('proposal_id does not match the parsed content')
    err.code = 'PLAN_IMPORT_PROPOSAL_MISMATCH'
    throw err
  }

  if (sourceLabel) {
    const existing = store.findProjectBySource(sourceLabel, parsed.source_checksum)
    if (existing) {
      return {
        replayed: true,
        proposal_id: parsed.proposal_id,
        source_checksum: parsed.source_checksum,
        source_label: sourceLabel,
        project: existing,
        milestones: store.listMilestones(existing.id),
        tasks: store.list({ project_id: existing.id }),
        warnings: parsed.warnings,
        unresolved_references: parsed.unresolved_references,
      }
    }
    const conflicting = store.db.prepare('SELECT id, source_checksum FROM projects WHERE source_label = ? AND source_checksum <> ?').all(sourceLabel, parsed.source_checksum)
    if (conflicting.length > 0) {
      const err = new TypeError('conflicting source_label already imported with a different checksum: ' + conflicting[0].id)
      err.code = 'PLAN_IMPORT_SOURCE_CONFLICT'
      throw err
    }
  }

  if (options.dry_run === true) {
    return {
      replayed: false,
      dry_run: true,
      proposal_id: parsed.proposal_id,
      source_checksum: parsed.source_checksum,
      source_label: sourceLabel,
      project: null,
      milestones: [],
      tasks: [],
      warnings: parsed.warnings,
      unresolved_references: parsed.unresolved_references,
    }
  }

  const projectInput = {
    id: parsed.project.id,
    title: parsed.project.title,
    status: parsed.project.status,
    objective: parsed.project.objective,
    completion_criteria: parsed.project.completion_criteria,
    source_label: sourceLabel,
    source_checksum: parsed.source_checksum,
    description: parsed.project.objective,
    metadata: parsed.project.metadata,
    specification: { objective: parsed.project.objective, completion_criteria: parsed.project.completion_criteria },
    outline: parsed.project.stories.map(story => ({ id: story.id, title: story.title })),
  }
  const project = store.createProject(projectInput, { actor: options.actor })

  const milestonesByStoryId = new Map()
  const milestones = []
  const storyById = new Map(parsed.project.stories.map(story => [story.id, { title: story.title }]))
  const titleToStoryId = new Map(parsed.project.stories.map(story => [story.title.toLowerCase(), story.id]))
  parsed.project.tranches.forEach((tranche, index) => {
    const milestone = store.createMilestone({
      id: tranche.id,
      project_id: project.id,
      title: tranche.code + ' — ' + tranche.title,
      description: tranche.exit_criterion,
      position: index + 1,
      exit_criteria: tranche.exit_criterion ? [tranche.exit_criterion] : [],
      metadata: { tranche_code: tranche.code, story_refs: tranche.story_refs },
    }, { actor: options.actor })
    milestones.push(milestone)
    const candidateRefs = new Set([...tranche.story_refs, ...tranche.implement])
    for (const ref of candidateRefs) {
      const normalized = normalizeDependencyReference(ref, storyById, titleToStoryId, parsed.project.stories)
      if (normalized.resolved) milestonesByStoryId.set(normalized.target_id, milestone.id)
    }
  })

  const tasks = []
  for (const story of parsed.project.stories) {
    const milestoneId = milestonesByStoryId.get(story.id) ?? null
    const task = store.create({
      id: story.id,
      title: story.title,
      project_id: project.id,
      milestone_id: milestoneId,
      relationship_type: 'story',
      specification: {
        objective: story.objective,
        implementation_decision: story.implementation_decision,
        tool_contract: story.tool_contract,
        ordered_plan: story.ordered_plan,
        target_files: story.target_files,
        required_invariants: story.required_invariants,
        deviation_policy: story.deviation_policy,
        completion_receipt: story.completion_receipt,
      },
      scope_boundaries: story.scope_boundaries,
      acceptance_criteria: story.acceptance_criteria,
      validation: story.validation,
      metadata: { source_format: 'plan-import/v' + PLAN_IMPORT_VERSION, story_number: story.number },
    }, { actor: options.actor })
    tasks.push(task)
  }
  for (const story of parsed.project.stories) {
    if (story.blocked_by.length === 0) continue
    for (const ref of story.blocked_by) {
      const normalized = normalizeDependencyReference(ref, storyById, titleToStoryId, parsed.project.stories)
      if (!normalized.resolved) continue
      store.addDependency(story.id, normalized.target_id, { actor: options.actor })
    }
  }

  return {
    replayed: false,
    proposal_id: parsed.proposal_id,
    source_checksum: parsed.source_checksum,
    source_label: sourceLabel,
    project,
    milestones,
    tasks,
    warnings: parsed.warnings,
    unresolved_references: parsed.unresolved_references,
  }
}
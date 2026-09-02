import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// The FakeDocument normalizes createElement tagName to uppercase so it matches
// HTML element conventions (e.g. HTMLButtonElement.tagName === 'BUTTON').
// Tests below compare against uppercase names.

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.dataset = this._ensureDataset()
    this.classList = {
      values: new Set(),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.values.has(name) : force
        if (enabled) this.classList.values.add(name)
        else this.classList.values.delete(name)
      },
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name),
    }
    Object.defineProperty(this, 'className', {
      get: () => Array.from(this.classList.values).join(' '),
      set: (value) => {
        this.classList.values.clear()
        if (typeof value === 'string') for (const cls of value.split(/\s+/).filter(Boolean)) this.classList.values.add(cls)
      },
    })
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parentNode = this } }
  // Reflect dataset changes onto data-* attributes, matching real DOM behavior.
  // We expose a Proxy-backed dataset so writes to dataset[key] update attributes.
  _ensureDataset() {
    if (this._datasetProxy) return this._datasetProxy
    const target = {}
    this._datasetProxy = new Proxy(target, {
      set: (obj, key, value) => {
        obj[key] = value
        const attr = 'data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase())
        this.attributes.set(attr, String(value))
        return true
      },
      get: (obj, key) => obj[key],
      deleteProperty: (obj, key) => {
        delete obj[key]
        const attr = 'data-' + String(key).replace(/[A-Z]/g, char => '-' + char.toLowerCase())
        this.attributes.delete(attr)
        return true
      },
    })
    return this._datasetProxy
  }
  insertBefore(child, anchor) { if (anchor === null || anchor === undefined) this.append(child); else { const index = this.children.indexOf(anchor); if (index < 0) this.append(child); else { this.children.splice(index, 0, child); child.parentNode = this } } }
  removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child }
  remove() { this.parentNode?.removeChild(this) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  closest() { return null }
  matches(selector) { return selector.includes('data-dsh-task-orchestrator-entry') && this.attributes.has('data-dsh-task-orchestrator-entry') }
  querySelector(selector) { return find(this, node => node !== this && (selector.includes('newSession') && node.tagName === 'BUTTON' && node.className.includes('newSession'))) ?? null }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)) }
  get parentElement() { return this.parentNode }
  get firstChild() { return this.children[0] }
  get firstElementChild() { return this.children.find(child => child.tagName !== '#text') }
  get nextElementSibling() { const siblings = this.parentNode?.children ?? []; const index = siblings.indexOf(this); return index >= 0 ? siblings[index + 1] : undefined }
  get isConnected() { return this.parentNode !== null && (this.parentNode.isConnected || this.parentNode.tagName === '#document') }
  set textContent(value) { this.children = []; this.text = String(value) }
  get textContent() { return this.text ?? this.children.map(child => child.textContent ?? '').join('') }
  get value() { return this._value ?? '' }
  set value(v) { this._value = String(v); this.attributes.set('value', String(v)) }
  get checked() { return Boolean(this._checked) }
  set checked(v) { this._checked = Boolean(v) }
  set innerHTML(value) { this._innerHTML = String(value) }
  get innerHTML() { return this._innerHTML ?? '' }
}

function find(node, predicate) {
  if (predicate(node)) return node
  for (const child of node.children) { const result = find(child, predicate); if (result) return result }
  return undefined
}

function findAll(node, predicate, results = []) {
  if (predicate(node)) results.push(node)
  for (const child of node.children) findAll(child, predicate, results)
  return results
}

class FakeDocument extends FakeNode {
  constructor() { super('#document'); this.head = new FakeNode('head'); this.body = new FakeNode('body'); this.append(this.head, this.body) }
  // Normalize tagName to uppercase so it matches the HTML convention used by
  // real browser DOM elements (e.g. HTMLButtonElement.tagName === 'BUTTON').
  // The bundle code and test predicates both compare against uppercase names,
  // so this keeps the fake faithful to production DOM without touching src/.
  createElement(tagName) { return new FakeNode(String(tagName).toUpperCase()) }
  createTextNode(text) { const node = new FakeNode('#text'); node.textContent = text; return node }
  querySelector(selector) {
    if (selector.includes('data-pane="sidebar"') || selector.includes('sidebarCol')) return find(this, node => node.attributes.get('data-pane') === 'sidebar') ?? null
    if (selector === '[data-dsh-task-orchestrator-board]') return find(this, node => node.attributes.has('data-dsh-task-orchestrator-board')) ?? null
    if (selector === '[data-dsh-task-orchestrator-entry]') return find(this, node => node.attributes.has('data-dsh-task-orchestrator-entry')) ?? null
    return null
  }
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback }
  observe() {}
  disconnect() {}
}

function makeFixture(fetcher) {
  const document = new FakeDocument()
  const sidebarColumn = new FakeNode('div')
  sidebarColumn.setAttribute('data-pane', 'sidebar')
  const sidebarRoot = new FakeNode('div')
  const newSession = new FakeNode('BUTTON')
  newSession.className = 'newSession'
  sidebarRoot.append(newSession)
  sidebarColumn.append(sidebarRoot)
  document.body.append(sidebarColumn)
  let registration
  const context = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document,
    Node: FakeNode,
    MutationObserver: FakeMutationObserver,
    console,
    URLSearchParams,
    fetch: fetcher,
  }
  context.globalThis = context
  return { document, context, load: async () => { vm.runInNewContext(await readFile('lib/client.js', 'utf8'), context); return registration } }
}

async function bootstrapProjectView() {
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes('/projects?') || url.endsWith('/projects')) return { ok: true, status: 200, async json() { return { projects: [{ id: 'p1', title: 'Project one', status: 'active', milestones: [{ id: 'm1', project_id: 'p1', title: 'Milestone one', status: 'active', position: 0 }] }] } } }
    if (url.includes('/tasks?')) return { ok: true, status: 200, async json() { return { tasks: [
      { id: 't-a', title: 'Task A', status: 'ready', project_id: 'p1', milestone_id: 'm1', blocked_by: [], ready_to_run: true, acceptance_criteria: ['works'], criterion_results: [{ index: 0, criterion: 'works', status: 'satisfied', evidence: 'tests' }] },
      { id: 't-b', title: 'Task B', status: 'done', project_id: 'p1', milestone_id: 'm1', blocked_by: ['t-a'], ready_to_run: false, acceptance_criteria: [], criterion_results: [] },
    ] } } }
    return { ok: true, status: 200, async json() { return {} } }
  }
  const fixture = makeFixture(fetcher)
  const registration = await fixture.load()
  assert.equal(registration?.id, 'dsh-task-orchestrator')
  const exports = registration.factory(() => { throw new Error('unexpected external require') })
  let effectCleanup
  exports.apply({ effect(factory) { effectCleanup = factory(); return effectCleanup } })
  // Yield repeatedly until the project filter has the dynamic option.
  const start = Date.now()
  while (Date.now() - start < 1000) {
    await Promise.resolve()
    const panel = find(fixture.document, n => n.attributes.has('data-dsh-task-orchestrator-board'))
    if (panel) {
      const sel = find(panel, n => n.tagName === 'SELECT' && Array.from(n.children).some(child => child.attributes.get('value') === 'p1'))
      if (sel) break
    }
  }
  const panel = find(fixture.document, n => n.attributes.has('data-dsh-task-orchestrator-board'))
  return { document: fixture.document, panel, calls, dispose: () => effectCleanup?.() }
}

test('bundled DSH client registers, mounts, and adds a sidebar entry', async () => {
  const calls = []
  const fetcher = async (url) => {
    calls.push({ url })
    if (url.includes('/tasks?')) return { ok: true, status: 200, async json() { return { tasks: [] } } }
    if (url.includes('/projects')) return { ok: true, status: 200, async json() { return { projects: [] } } }
    return { ok: true, status: 200, async json() { return {} } }
  }
  const fixture = makeFixture(fetcher)
  const registration = await fixture.load()
  assert.equal(registration?.id, 'dsh-task-orchestrator')
  const exports = registration.factory(() => { throw new Error('unexpected external require') })
  let effectCleanup
  exports.apply({ effect(factory) { effectCleanup = factory(); return effectCleanup } })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.ok(fixture.document.querySelector('[data-dsh-task-orchestrator-board]'))
  assert.ok(fixture.document.querySelector('[data-dsh-task-orchestrator-entry]'))
  assert.ok(calls.some(call => call.url.includes('/tasks?')), 'expected task list call')
  assert.ok(calls.some(call => call.url.includes('/projects')), 'expected project list call')
  effectCleanup?.()
})

test('bundled DSH client renders Board, Outline, and Roadmap controls with project filter populated', async () => {
  const { panel } = await bootstrapProjectView()
  const viewButtons = findAll(panel, node => node.tagName === 'BUTTON' && ['Board', 'Outline', 'Roadmap'].includes(node.textContent))
  assert.equal(viewButtons.length, 3, 'expected three view toggle buttons')
  const projectSelect = find(panel, node => node.tagName === 'SELECT' && Array.from(node.children).some(child => child.attributes.get('value') === 'p1' && child.textContent === 'Project one'))
  assert.ok(projectSelect, 'expected project filter select to include p1')
  const milestoneSelect = find(panel, node => node.tagName === 'SELECT' && Array.from(node.children).some(child => child.attributes.get('value') === 'm1' && child.textContent === 'Milestone one'))
  assert.ok(milestoneSelect, 'expected milestone filter select to include m1')
})

test('bundled DSH client toggles to Outline view and renders project + milestone sections', async () => {
  const { panel, dispose } = await bootstrapProjectView()
  const outlineBtn = find(panel, n => n.tagName === 'BUTTON' && n.textContent === 'Outline')
  assert.ok(outlineBtn, 'Outline button missing')
  outlineBtn.listeners.get('click')()
  await Promise.resolve()
  const outlinePane = find(panel, n => n.classList?.values?.has('dsh-to-outline'))
  assert.ok(outlinePane, 'outline pane missing')
  assert.equal(outlinePane.classList.values.has('dsh-to-hidden'), false, 'outline pane should be visible after switching')
  assert.ok(find(outlinePane, n => n.tagName === 'H3' && n.textContent === 'Project one'), 'project heading missing in outline')
  assert.ok(find(outlinePane, n => n.tagName === 'H4' && n.textContent === 'Milestone one'), 'milestone heading missing in outline')
  dispose()
})
test('bundled DSH client toggles to Roadmap view and separates blocking deps from typed links', async () => {
  const { panel, dispose } = await bootstrapProjectView()
  const roadmapBtn = find(panel, n => n.tagName === 'BUTTON' && n.textContent === 'Roadmap')
  assert.ok(roadmapBtn, 'Roadmap button missing')
  roadmapBtn.listeners.get('click')()
  await Promise.resolve()
  const roadmapPane = find(panel, n => n.classList?.values?.has('dsh-to-roadmap'))
  assert.ok(roadmapPane, 'roadmap pane missing')
  assert.equal(roadmapPane.classList.values.has('dsh-to-hidden'), false, 'roadmap pane should be visible after switching')
  const sections = findAll(roadmapPane, n => n.attributes.get('data-kind'))
  const blockingSection = sections.find(s => s.attributes.get('data-kind') === 'blocking')
  const typedSection = sections.find(s => s.attributes.get('data-kind') === 'typed')
  assert.ok(blockingSection, 'expected a blocking-dependencies section')
  assert.ok(typedSection, 'expected a typed-links section')
  const blockingEdges = findAll(blockingSection, n => n.tagName === 'LI')
  assert.equal(blockingEdges.length, 1, 'expected exactly one blocking edge in the fixture')
  assert.match(blockingEdges[0].textContent, /Task A/)
  assert.match(blockingEdges[0].textContent, /Task B/)
  const emptyMessage = find(typedSection, n => n.classList?.values?.has('dsh-to-roadmap-empty'))
  assert.ok(emptyMessage, 'expected empty-state message for typed links')
  dispose()
})

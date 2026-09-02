import { TaskStore } from './store.js'
import { makeRoutes } from './routes.js'
import { createTaskTools } from './tools.js'
import { previewPlanImport, applyPlanImport } from './plan-import.js'
import { WorkerSpecRegistry } from './worker-specs.js'
import { preflightWorker } from './worker-preflight.js'
import { WorkerDispatcher, createWorkerLauncher } from './dispatcher.js'

export const name = 'task-orchestrator'
export const inject = ['webServer', 'tools']
export const TASK_ORCHESTRATOR_SERVICE = 'taskOrchestrator'

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const store = new TaskStore({
    dbPath: config.dbPath,
    defaultLeaseSeconds: config.defaultLeaseSeconds,
    maxAttemptsDefault: config.maxAttemptsDefault,
  })
  const workerRegistry = new WorkerSpecRegistry(config.workerSpecs ?? {})
  const preflight = (request = {}, options = {}) => preflightWorker(workerRegistry, request, {
    ...options,
    llm: options.llm ?? ctx.llm,
    workspaceRoots: options.workspaceRoots ?? config.workspaceRoots,
  })
  const api = Object.freeze({
    version: 2,
    dbPath: store.dbPath,
    store,
    create: store.create.bind(store),
    get: store.get.bind(store),
    list: store.list.bind(store),
    update: store.update.bind(store),
    delete: store.delete.bind(store),
    claim: store.claim.bind(store),
    release: store.release.bind(store),
    renewLease: store.renewLease.bind(store),
    start: store.start.bind(store),
    complete: store.complete.bind(store),
    fail: store.fail.bind(store),
    block: store.block.bind(store),
    unblock: store.unblock.bind(store),
    requestChanges: store.requestChanges.bind(store),
    addDependency: store.addDependency.bind(store),
    removeDependency: store.removeDependency.bind(store),
    addTaskLink: store.addTaskLink.bind(store),
    removeTaskLink: store.removeTaskLink.bind(store),
    listTaskLinks: store.listTaskLinks.bind(store),
    setCriterionResults: store.setCriterionResults.bind(store),
    addChild: store.addChild.bind(store),
    listChildren: store.listChildren.bind(store),
    listDescendants: store.listDescendants.bind(store),
    readyToRun: store.readyToRun.bind(store),
    blockedByDependencies: store.blockedByDependencies.bind(store),
    events: store.events.bind(store),
    subscribe: store.subscribe.bind(store),
    createProject: store.createProject.bind(store),
    getProject: store.getProject.bind(store),
    listProjects: store.listProjects.bind(store),
    updateProject: store.updateProject.bind(store),
    deleteProject: store.deleteProject.bind(store),
    createMilestone: store.createMilestone.bind(store),
    getMilestone: store.getMilestone.bind(store),
    listMilestones: store.listMilestones.bind(store),
    updateMilestone: store.updateMilestone.bind(store),
    deleteMilestone: store.deleteMilestone.bind(store),
    previewPlanImport: (markdown, options) => previewPlanImport(markdown, options),
    applyPlanImport: (markdown, options) => applyPlanImport(store, markdown, options),
    workerSpecs: workerRegistry.list.bind(workerRegistry),
    getWorkerSpec: workerRegistry.get.bind(workerRegistry),
    resolveWorkerSpec: workerRegistry.resolve.bind(workerRegistry),
    preflightWorker: preflight,
    createDispatcher: (options = {}) => new WorkerDispatcher({
      store,
      registry: workerRegistry,
      launcher: options.launcher ?? createWorkerLauncher(options.launcherOptions),
      preflight: options.preflight ?? preflight,
      preflightOptions: options.preflightOptions,
      actor: options.actor,
      idFactory: options.idFactory,
      clock: options.clock,
      outputLimit: options.outputLimit,
    }),
  })
  ctx.provide(TASK_ORCHESTRATOR_SERVICE, api)
  ctx.effect(() => {
    const routeDisposers = makeRoutes(store, { registry: workerRegistry, preflight }).map(route => ctx.webServer.register(route))
    const toolDisposers = createTaskTools(store).map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of routeDisposers) dispose()
      for (const dispose of toolDisposers) dispose()
      store.close()
    }
  }, 'task-orchestrator: store, routes, and tools')
}
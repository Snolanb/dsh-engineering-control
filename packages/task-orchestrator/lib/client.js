window.__ModuleLoader__.load({
  id: "dsh-task-orchestrator",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/client-api.js
const TASK_API_PREFIX = "/api/task-orchestrator";
Object.freeze([
	"planning",
	"active",
	"blocked",
	"completed",
	"cancelled"
]);
Object.freeze([
	"enables",
	"usually_follows",
	"benefits_from",
	"related_to"
]);
const BOARD_STATUSES = Object.freeze([
	"backlog",
	"planning",
	"ready",
	"claimed",
	"running",
	"in_review",
	"changes_requested",
	"blocked",
	"failed",
	"done",
	"cancelled"
]);
async function responseJson(response) {
	let body;
	try {
		body = await response.json();
	} catch {
		body = { error: "task orchestrator returned invalid JSON" };
	}
	if (!response.ok) {
		const error = new Error(body?.error ?? "task orchestrator request failed: " + response.status);
		error.status = response.status;
		error.code = body?.code;
		throw error;
	}
	return body;
}
function queryString(options = {}) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value === void 0) continue;
		if (value === null) {
			params.set(key, "");
			continue;
		}
		if (value === "") continue;
		if (Array.isArray(value)) params.set(key, value.join(","));
		else params.set(key, String(value));
	}
	const encoded = params.toString();
	return encoded === "" ? "" : "?" + encoded;
}
var TaskOrchestratorClient = class {
	constructor(fetcher = globalThis.fetch?.bind(globalThis), prefix = TASK_API_PREFIX) {
		if (typeof fetcher !== "function") throw new Error("fetch is unavailable");
		this.fetcher = fetcher;
		this.prefix = prefix.replace(/\/+$/, "");
	}
	async request(path, init = {}) {
		return await responseJson(await this.fetcher(this.prefix + path, {
			cache: "no-store",
			...init,
			headers: {
				accept: "application/json",
				...init.headers ?? {}
			}
		}));
	}
	async list(options = {}) {
		const query = { ...options };
		if (query.statuses !== void 0 && query.status === void 0) {
			query.status = query.statuses;
			delete query.statuses;
		}
		return (await this.request("/tasks" + queryString(query))).tasks ?? [];
	}
	async get(id) {
		return (await this.request("/tasks/" + encodeURIComponent(id))).task;
	}
	async create(task) {
		return (await this.request("/tasks", {
			method: "POST",
			body: JSON.stringify(task),
			headers: { "content-type": "application/json" }
		})).task;
	}
	async update(id, patch) {
		return (await this.request("/tasks/" + encodeURIComponent(id), {
			method: "PATCH",
			body: JSON.stringify(patch),
			headers: { "content-type": "application/json" }
		})).task;
	}
	async delete(id, actor) {
		const init = { method: "DELETE" };
		if (actor !== void 0 && actor !== null && actor !== "") init.body = JSON.stringify({ actor });
		return await this.request("/tasks/" + encodeURIComponent(id), init);
	}
	async action(id, action, payload = {}) {
		const result = await this.request("/tasks/" + encodeURIComponent(id) + "/" + action, {
			method: "POST",
			body: JSON.stringify(payload),
			headers: { "content-type": "application/json" }
		});
		return result.task ?? result;
	}
	async claim(id, worker, leaseSeconds) {
		return await this.action(id, "claim", {
			worker,
			...leaseSeconds === void 0 ? {} : { lease_seconds: leaseSeconds }
		});
	}
	async release(id, worker) {
		return await this.action(id, "release", { worker });
	}
	async renewLease(id, worker, leaseSeconds) {
		return await this.action(id, "renew-lease", {
			worker,
			...leaseSeconds === void 0 ? {} : { lease_seconds: leaseSeconds }
		});
	}
	async start(id, worker) {
		return await this.action(id, "start", { worker });
	}
	async complete(id, worker, result = {}) {
		return await this.action(id, "complete", {
			worker,
			...result
		});
	}
	async fail(id, worker, result = {}) {
		return await this.action(id, "fail", {
			worker,
			...result
		});
	}
	async block(id, reason, worker) {
		return await this.action(id, "block", {
			reason,
			...worker === void 0 ? {} : { worker }
		});
	}
	async unblock(id) {
		return await this.action(id, "unblock");
	}
	async requestChanges(id, reason) {
		return await this.action(id, "request-changes", { reason });
	}
	async children(id, descendants = false) {
		return (await this.request("/tasks/" + encodeURIComponent(id) + "/children" + queryString({ descendants: descendants ? "true" : void 0 }))).tasks ?? [];
	}
	async events(id, limit = 100) {
		return (await this.request("/tasks/" + encodeURIComponent(id) + "/events" + queryString({ limit }))).events ?? [];
	}
	async addDependency(id, dependsOn) {
		return await this.request("/tasks/" + encodeURIComponent(id) + "/dependencies", {
			method: "POST",
			body: JSON.stringify({ depends_on_task_id: dependsOn }),
			headers: { "content-type": "application/json" }
		});
	}
	async removeDependency(id, dependsOn) {
		return await this.request("/tasks/" + encodeURIComponent(id) + "/dependencies" + queryString({ depends_on_task_id: dependsOn }), { method: "DELETE" });
	}
	async addLink(id, linkedTaskId, linkType, options = {}) {
		return await this.request("/tasks/" + encodeURIComponent(id) + "/links", {
			method: "POST",
			body: JSON.stringify({
				linked_task_id: linkedTaskId,
				link_type: linkType,
				...options
			}),
			headers: { "content-type": "application/json" }
		});
	}
	async removeLink(id, linkedTaskId, linkType, options = {}) {
		return await this.request("/tasks/" + encodeURIComponent(id) + "/links" + queryString({
			linked_task_id: linkedTaskId,
			link_type: linkType,
			...options
		}), { method: "DELETE" });
	}
	async listLinks(id, linkType) {
		return (await this.request("/tasks/" + encodeURIComponent(id) + "/links" + queryString({ link_type: linkType }))).links ?? [];
	}
	async setCriterionResults(id, criterionResults) {
		return (await this.request("/tasks/" + encodeURIComponent(id) + "/criterion-results", {
			method: "PUT",
			body: JSON.stringify({ criterion_results: criterionResults }),
			headers: { "content-type": "application/json" }
		})).task;
	}
	async listProjects() {
		return (await this.request("/projects")).projects ?? [];
	}
	async getProject(id) {
		return (await this.request("/projects/" + encodeURIComponent(id))).project;
	}
	async createProject(project) {
		return (await this.request("/projects", {
			method: "POST",
			body: JSON.stringify(project),
			headers: { "content-type": "application/json" }
		})).project;
	}
	async updateProject(id, patch) {
		return (await this.request("/projects/" + encodeURIComponent(id), {
			method: "PATCH",
			body: JSON.stringify(patch),
			headers: { "content-type": "application/json" }
		})).project;
	}
	async deleteProject(id) {
		return await this.request("/projects/" + encodeURIComponent(id), { method: "DELETE" });
	}
	async listMilestones(projectId) {
		return (await this.request("/projects/" + encodeURIComponent(projectId) + "/milestones")).milestones ?? [];
	}
	async createMilestone(projectId, milestone) {
		return (await this.request("/projects/" + encodeURIComponent(projectId) + "/milestones", {
			method: "POST",
			body: JSON.stringify(milestone),
			headers: { "content-type": "application/json" }
		})).milestone;
	}
	async getMilestone(id) {
		return (await this.request("/milestones/" + encodeURIComponent(id))).milestone;
	}
	async updateMilestone(id, patch) {
		return (await this.request("/milestones/" + encodeURIComponent(id), {
			method: "PATCH",
			body: JSON.stringify(patch),
			headers: { "content-type": "application/json" }
		})).milestone;
	}
	async deleteMilestone(id) {
		return await this.request("/milestones/" + encodeURIComponent(id), { method: "DELETE" });
	}
	async previewPlanImport(markdown, sourceLabel) {
		return await this.request("/plan-import/preview", {
			method: "POST",
			body: JSON.stringify({
				markdown,
				source_label: sourceLabel
			}),
			headers: { "content-type": "application/json" }
		});
	}
	async applyPlanImport(markdown, options = {}) {
		return await this.request("/plan-import/apply", {
			method: "POST",
			body: JSON.stringify({
				markdown,
				...options
			}),
			headers: { "content-type": "application/json" }
		});
	}
};
//#endregion
//#region src/project-helpers.js
const TASK_LINK_TYPES = Object.freeze([
	"enables",
	"usually_follows",
	"benefits_from",
	"related_to"
]);
const ROADMAP_BLOCKING = "blocking_dependency";
const ROADMAP_TYPED = "typed_link";
const CRITERION_STATUSES = Object.freeze([
	"pending",
	"satisfied",
	"waived"
]);
function normalizeTask(task) {
	if (!task || typeof task !== "object") return null;
	return {
		id: String(task.id ?? ""),
		title: String(task.title ?? task.id ?? "Untitled"),
		description: typeof task.description === "string" ? task.description : "",
		status: typeof task.status === "string" ? task.status : "backlog",
		priority: typeof task.priority === "string" ? task.priority : "normal",
		parent_id: task.parent_id ?? null,
		project_id: task.project_id ?? null,
		milestone_id: task.milestone_id ?? null,
		relationship_type: task.relationship_type ?? "task",
		blocked_by: Array.isArray(task.blocked_by) ? task.blocked_by.slice() : [],
		dependencies: Array.isArray(task.dependencies) ? task.dependencies.slice() : [],
		ready_to_run: Boolean(task.ready_to_run),
		blocked_by_dependencies: Boolean(task.blocked_by_dependencies),
		worker_profile: task.worker_profile ?? null,
		claimed_by: task.claimed_by ?? null,
		acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.slice() : [],
		criterion_results: Array.isArray(task.criterion_results) ? task.criterion_results.slice() : [],
		specification: task.specification && typeof task.specification === "object" ? task.specification : {}
	};
}
function normalizeMilestone(milestone) {
	if (!milestone || typeof milestone !== "object") return null;
	return {
		id: String(milestone.id ?? ""),
		project_id: milestone.project_id ?? null,
		title: String(milestone.title ?? milestone.id ?? "Untitled milestone"),
		description: typeof milestone.description === "string" ? milestone.description : "",
		status: typeof milestone.status === "string" ? milestone.status : "planning",
		position: Number.isFinite(Number(milestone.position)) ? Number(milestone.position) : 0
	};
}
function normalizeProject(project) {
	if (!project || typeof project !== "object") return null;
	const milestones = Array.isArray(project.milestones) ? project.milestones.map(normalizeMilestone).filter(Boolean) : [];
	return {
		id: String(project.id ?? ""),
		title: String(project.title ?? project.id ?? "Untitled project"),
		description: typeof project.description === "string" ? project.description : "",
		status: typeof project.status === "string" ? project.status : "planning",
		specification: project.specification && typeof project.specification === "object" ? project.specification : {},
		roadmap: Array.isArray(project.roadmap) ? project.roadmap.slice() : [],
		outline: Array.isArray(project.outline) ? project.outline.slice() : [],
		milestones
	};
}
function projectKey(task, fallbackProjectId) {
	if (task.project_id) return task.project_id;
	return fallbackProjectId === void 0 ? "__no_project__" : fallbackProjectId;
}
function groupTasksByProjectMilestone(tasks, { projects = [], fallbackProjectId = "__no_project__", fallbackMilestoneId = "__no_milestone__" } = {}) {
	const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : [];
	const projectMap = /* @__PURE__ */ new Map();
	for (const project of projects.map(normalizeProject).filter(Boolean)) projectMap.set(project.id, {
		...project,
		milestones: new Map(project.milestones.map((milestone) => [milestone.id, {
			...milestone,
			tasks: [],
			childTasks: []
		}])),
		noMilestone: {
			id: fallbackMilestoneId,
			title: "Unassigned to milestone",
			status: "planning",
			tasks: [],
			childTasks: []
		}
	});
	for (const task of safeTasks) {
		const pId = projectKey(task, fallbackProjectId);
		let project = projectMap.get(pId);
		if (project === void 0) {
			if (pId === fallbackProjectId) project = {
				id: fallbackProjectId,
				title: "No project",
				description: "",
				status: "planning",
				specification: {},
				roadmap: [],
				outline: [],
				milestones: /* @__PURE__ */ new Map(),
				noMilestone: {
					id: fallbackMilestoneId,
					title: "Unassigned to milestone",
					status: "planning",
					tasks: [],
					childTasks: []
				}
			};
			else project = {
				id: pId,
				title: "(unknown project)",
				description: "",
				status: "planning",
				specification: {},
				roadmap: [],
				outline: [],
				milestones: /* @__PURE__ */ new Map(),
				noMilestone: {
					id: fallbackMilestoneId,
					title: "Unassigned to milestone",
					status: "planning",
					tasks: [],
					childTasks: []
				}
			};
			projectMap.set(pId, project);
		}
		const mId = task.milestone_id ?? fallbackMilestoneId;
		let bucket = mId === fallbackMilestoneId ? project.noMilestone : project.milestones.get(mId);
		if (bucket === void 0) {
			bucket = {
				id: mId,
				title: "(unknown milestone)",
				status: "planning",
				tasks: [],
				childTasks: []
			};
			project.milestones.set(mId, bucket);
		}
		bucket.tasks.push(task);
		if (task.parent_id) bucket.childTasks.push(task);
	}
	const result = [];
	for (const project of projectMap.values()) {
		const milestones = Array.from(project.milestones.values()).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
		milestones.forEach((milestone) => milestone.tasks.sort((a, b) => a.id.localeCompare(b.id)));
		if (project.noMilestone.tasks.length > 0) {
			project.noMilestone.tasks.sort((a, b) => a.id.localeCompare(b.id));
			milestones.push(project.noMilestone);
		}
		result.push({
			...project,
			milestones
		});
	}
	return result;
}
function buildHierarchy(tasks) {
	const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : [];
	const byId = new Map(safeTasks.map((task) => [task.id, {
		...task,
		children: []
	}]));
	const roots = [];
	for (const task of byId.values()) if (task.parent_id && byId.has(task.parent_id)) byId.get(task.parent_id).children.push(task);
	else roots.push(task);
	const sortById = (a, b) => a.id.localeCompare(b.id);
	roots.sort(sortById);
	for (const task of byId.values()) task.children.sort(sortById);
	return roots;
}
function summarizeStatuses(tasks) {
	const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : [];
	const counts = {};
	let cancelled = 0;
	for (const task of safeTasks) {
		counts[task.status] = (counts[task.status] ?? 0) + 1;
		if (task.status === "cancelled") cancelled++;
	}
	const total = safeTasks.length;
	const activeTotal = total - cancelled;
	const done = counts.done ?? 0;
	return {
		counts,
		total,
		done,
		cancelled,
		active_total: activeTotal,
		completion_percent: activeTotal === 0 ? 0 : Math.round(done * 1e4 / activeTotal) / 100
	};
}
function isReadyToRun(task) {
	const safe = normalizeTask(task);
	if (!safe) return false;
	if (safe.ready_to_run) return true;
	return safe.status === "ready" && safe.blocked_by.length === 0;
}
function isDependencyBlocked(task) {
	const safe = normalizeTask(task);
	if (!safe) return false;
	if (safe.blocked_by_dependencies) return true;
	return safe.blocked_by.length > 0;
}
function unmetCriteria(task) {
	const safe = normalizeTask(task);
	if (!safe) return [];
	return safe.criterion_results.filter((entry) => entry.status !== "satisfied" && entry.status !== "waived");
}
function summarizeCriteria(tasks) {
	const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : [];
	const counts = {
		pending: 0,
		satisfied: 0,
		waived: 0,
		other: 0,
		total: 0
	};
	for (const task of safeTasks) for (const entry of task.criterion_results) {
		counts.total++;
		if (entry.status === "satisfied") counts.satisfied++;
		else if (entry.status === "waived") counts.waived++;
		else if (entry.status === "pending") counts.pending++;
		else counts.other++;
	}
	return counts;
}
function milestoneExitCriteria(milestone, childTasks) {
	if (!milestone) return [];
	const metadataCriteria = Array.isArray(milestone.exit_criteria) ? milestone.exit_criteria : milestone.metadata && Array.isArray(milestone.metadata.exit_criteria) ? milestone.metadata.exit_criteria : [];
	if (!metadataCriteria.length) return [];
	const safeChildren = Array.isArray(childTasks) ? childTasks.map(normalizeTask).filter(Boolean) : [];
	return metadataCriteria.map((criterion, index) => {
		const text = typeof criterion === "string" ? criterion : criterion && typeof criterion === "object" ? criterion.criterion ?? criterion.text ?? JSON.stringify(criterion) : String(criterion);
		const matched = safeChildren.find((task) => task.criterion_results.some((entry) => entry.criterion === text && (entry.status === "satisfied" || entry.status === "waived")));
		return {
			index,
			criterion: text,
			met: Boolean(matched),
			evidence_task_id: matched?.id ?? null
		};
	});
}
function buildRoadmapEdges(tasks, linksByTask = {}) {
	const safeTasks = Array.isArray(tasks) ? tasks.map(normalizeTask).filter(Boolean) : [];
	const byId = new Map(safeTasks.map((task) => [task.id, task]));
	const blocking = [];
	const typed = [];
	for (const task of safeTasks) {
		for (const blockerId of task.blocked_by) blocking.push({
			kind: ROADMAP_BLOCKING,
			from_id: blockerId,
			to_id: task.id,
			from: byId.get(blockerId) ? {
				id: blockerId,
				title: byId.get(blockerId).title,
				status: byId.get(blockerId).status
			} : null,
			to: {
				id: task.id,
				title: task.title,
				status: task.status
			},
			link_type: "depends_on"
		});
		const links = Array.isArray(linksByTask[task.id]) ? linksByTask[task.id] : [];
		for (const link of links) {
			const linked = byId.get(link.linked_task_id);
			typed.push({
				kind: ROADMAP_TYPED,
				from_id: task.id,
				to_id: link.linked_task_id,
				from: {
					id: task.id,
					title: task.title,
					status: task.status
				},
				to: linked ? {
					id: linked.id,
					title: linked.title,
					status: linked.status
				} : null,
				link_type: link.link_type
			});
		}
	}
	blocking.sort((a, b) => (a.from_id + "|" + a.to_id).localeCompare(b.from_id + "|" + b.to_id));
	typed.sort((a, b) => (a.from_id + "|" + a.to_id + "|" + a.link_type).localeCompare(b.from_id + "|" + b.to_id + "|" + b.link_type));
	return {
		blocking,
		typed
	};
}
function matchesFilter(value, selector) {
	if (selector === void 0 || selector === null || selector === "") {
		if (selector === "") return value === null || value === void 0;
		return true;
	}
	return value === selector;
}
function buildCriterionResultsPayload(entries) {
	if (!Array.isArray(entries)) return {
		ok: false,
		error: "criterion_results must be an array",
		normalized: []
	};
	const normalized = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {
			ok: false,
			error: "criterion_results[" + index + "] must be an object",
			normalized
		};
		const status = entry.status ?? "pending";
		if (!CRITERION_STATUSES.includes(status)) return {
			ok: false,
			error: "criterion_results[" + index + "].status must be one of: " + CRITERION_STATUSES.join(", "),
			normalized
		};
		normalized.push({
			index: Number.isInteger(entry.index) ? entry.index : index,
			criterion: typeof entry.criterion === "string" ? entry.criterion : "",
			status,
			evidence: typeof entry.evidence === "string" ? entry.evidence : "",
			updated_at: entry.updated_at ?? null
		});
	}
	return {
		ok: true,
		normalized
	};
}
function projectCompletionCriteria(project) {
	if (!project || typeof project !== "object") return [];
	if (Array.isArray(project.completion_criteria)) return project.completion_criteria.slice();
	if (project.metadata && Array.isArray(project.metadata.completion_criteria)) return project.metadata.completion_criteria.slice();
	if (project.specification && Array.isArray(project.specification.completion_criteria)) return project.specification.completion_criteria.slice();
	return [];
}
//#endregion
//#region src/client.js
const name = "task-orchestrator-board";
const inject = [];
const VIEW_MODES = Object.freeze([
	"board",
	"outline",
	"roadmap"
]);
const STATUS_LABELS = {
	backlog: "Backlog",
	planning: "Planning",
	ready: "Ready",
	claimed: "Claimed",
	running: "Running",
	in_review: "In review",
	changes_requested: "Changes requested",
	blocked: "Blocked",
	failed: "Failed",
	done: "Done",
	cancelled: "Cancelled"
};
const VIEW_LABELS = {
	board: "Board",
	outline: "Outline",
	roadmap: "Roadmap"
};
const CSS = [
	".dsh-to-panel,.dsh-to-sidebar-entry{font-family:var(--ds-font-family-sans,Inter,system-ui,sans-serif)}",
	".dsh-to-sidebar-entry{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#c2c4ca);cursor:pointer;padding:8px 12px;text-align:left;font:inherit;font-size:12px}",
	".dsh-to-sidebar-entry:hover,.dsh-to-sidebar-entry[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,#343740);color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-sidebar-icon{display:flex;width:16px;height:16px;align-items:center;justify-content:center;flex:none}",
	".dsh-to-sidebar-icon svg{width:14px;height:14px}",
	".dsh-to-sidebar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-to-panel{position:fixed;z-index:10040;left:72px;top:16px;bottom:16px;width:min(1180px,calc(100vw - 88px));height:auto;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#1c1e23);color:var(--dsw-alias-label-primary,#f5f6f7);box-shadow:0 12px 44px #0008}",
	".dsh-to-hidden{display:none!important}",
	".dsh-to-header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#3b3e46);background:var(--dsw-alias-bg-layer-2,#24262c)}",
	".dsh-to-title{font-size:15px;font-weight:650;margin-right:auto}",
	".dsh-to-button{border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:7px;background:transparent;color:inherit;cursor:pointer;padding:5px 9px;font:inherit;font-size:12px}",
	".dsh-to-button:hover{background:var(--dsw-alias-interactive-bg-hover,#343740)}",
	".dsh-to-button-primary{background:var(--dsw-alias-button-primary-fill,#3975e8);border-color:transparent;color:#fff}",
	".dsh-to-button-danger{color:var(--dsw-alias-state-error-primary,#f27777)}",
	".dsh-to-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#3b3e46)}",
	".dsh-to-toolbar-group{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:7px;padding:2px}",
	".dsh-to-toolbar-group .dsh-to-button{border:0;background:transparent}",
	".dsh-to-toolbar-group .dsh-to-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,#343740);color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-input,.dsh-to-select,.dsh-to-textarea{box-sizing:border-box;min-height:30px;border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#25272d);color:inherit;padding:5px 8px;font:inherit;font-size:12px}",
	".dsh-to-input:focus,.dsh-to-select:focus,.dsh-to-textarea:focus{border-color:var(--dsw-alias-brand-primary,#668cf3);outline:none}",
	".dsh-to-input-small{width:120px}.dsh-to-select{min-width:125px}",
	".dsh-to-notice{min-height:18px;color:var(--dsw-alias-label-tertiary,#a5a8b0);font-size:11px;padding:4px 13px}",
	".dsh-to-notice-error{color:var(--dsw-alias-state-error-primary,#f27777)}",
	".dsh-to-content{display:flex;min-height:0;flex:1}",
	".dsh-to-board{display:flex;gap:9px;min-width:0;flex:1;overflow:auto;padding:10px}",
	".dsh-to-column{display:flex;flex:0 0 166px;flex-direction:column;min-height:100%;border:1px solid var(--dsw-alias-border-l2,#363941);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#23252b)}",
	".dsh-to-column-header{display:flex;align-items:center;gap:6px;padding:8px 9px;border-bottom:1px solid var(--dsw-alias-border-l2,#363941);font-size:11px;font-weight:650}",
	".dsh-to-count{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9ea1ab);font-weight:500}",
	".dsh-to-column-cards{display:flex;flex-direction:column;gap:7px;min-height:45px;padding:7px}",
	".dsh-to-card{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#1e2025);cursor:pointer;padding:8px}",
	".dsh-to-card:hover,.dsh-to-card-selected{border-color:var(--dsw-alias-brand-primary,#668cf3)}",
	".dsh-to-card-title{font-size:12px;font-weight:600;line-height:17px;overflow-wrap:anywhere}",
	".dsh-to-card-meta{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;color:var(--dsw-alias-label-tertiary,#a5a8b0);font-size:10px}",
	".dsh-to-badge{border-radius:4px;background:var(--dsw-alias-bg-module-platform,#30323a);padding:2px 4px}",
	".dsh-to-badge-warn{color:var(--dsw-alias-state-warn-label,#e9bd66)}",
	".dsh-to-badge-success{color:var(--dsw-alias-state-success-label,#7ad88e)}",
	".dsh-to-badge-error{color:var(--dsw-alias-state-error-primary,#f27777)}",
	".dsh-to-card-actions{display:flex;gap:4px;margin-top:7px}",
	".dsh-to-card-actions .dsh-to-button{padding:3px 5px;font-size:10px}",
	".dsh-to-detail{display:flex;flex:0 0 315px;flex-direction:column;gap:9px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l2,#3b3e46);padding:12px}",
	".dsh-to-detail h3{font-size:14px;margin:0;overflow-wrap:anywhere}.dsh-to-detail h4{font-size:11px;color:var(--dsw-alias-label-secondary,#c2c4ca);margin:6px 0 2px}",
	".dsh-to-muted{color:var(--dsw-alias-label-tertiary,#a5a8b0);font-size:11px;line-height:16px}",
	".dsh-to-list{margin:0;padding-left:17px;color:var(--dsw-alias-label-secondary,#c2c4ca);font-size:11px;line-height:17px}",
	".dsh-to-form{display:flex;flex-direction:column;gap:7px}.dsh-to-form-row{display:flex;gap:6px}.dsh-to-form-row>*{flex:1;min-width:0}",
	".dsh-to-section{border-top:1px solid var(--dsw-alias-border-l2,#3b3e46);padding-top:7px}",
	".dsh-to-event{padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#30323a);font-size:10px}.dsh-to-event strong{color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-outline{display:flex;flex-direction:column;gap:11px;min-width:0;flex:1;overflow:auto;padding:12px}",
	".dsh-to-outline-project{border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#23252b);padding:10px 11px}",
	".dsh-to-outline-header{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
	".dsh-to-outline-header h3{margin:0;font-size:13px;flex:1 1 auto;overflow-wrap:anywhere}",
	".dsh-to-outline-progress{display:flex;gap:6px;font-size:10px;color:var(--dsw-alias-label-tertiary,#a5a8b0)}",
	".dsh-to-outline-progress strong{color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-outline-milestones{display:flex;flex-direction:column;gap:8px;margin-top:9px}",
	".dsh-to-outline-milestone{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1e2025);padding:8px 9px}",
	".dsh-to-outline-milestone-header{display:flex;align-items:baseline;gap:8px}",
	".dsh-to-outline-milestone-header h4{margin:0;font-size:12px;flex:1 1 auto;overflow-wrap:anywhere}",
	".dsh-to-outline-exit{margin:6px 0 0;padding:0;list-style:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#a5a8b0)}",
	".dsh-to-outline-exit li{display:flex;align-items:baseline;gap:6px;padding:1px 0}",
	".dsh-to-outline-exit li[data-met=true]{color:var(--dsw-alias-state-success-label,#7ad88e)}",
	".dsh-to-outline-tasks{display:flex;flex-direction:column;gap:5px;margin-top:7px}",
	".dsh-to-outline-task{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#363941);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#24262c);font-size:11px}",
	".dsh-to-outline-task[data-selected=true]{border-color:var(--dsw-alias-brand-primary,#668cf3)}",
	".dsh-to-outline-task-title{flex:1 1 auto;cursor:pointer;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-outline-task-child{margin-left:18px}",
	".dsh-to-roadmap{display:flex;flex-direction:column;gap:12px;min-width:0;flex:1;overflow:auto;padding:12px}",
	".dsh-to-roadmap-section{border:1px solid var(--dsw-alias-border-l2,#3b3e46);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#23252b);padding:10px 11px}",
	".dsh-to-roadmap-section h3{margin:0 0 6px;font-size:13px}",
	".dsh-to-roadmap-section[data-kind=blocking] h3{color:var(--dsw-alias-state-warn-label,#e9bd66)}",
	".dsh-to-roadmap-section[data-kind=typed] h3{color:var(--dsw-alias-label-secondary,#c2c4ca)}",
	".dsh-to-roadmap-edges{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}",
	".dsh-to-roadmap-edge{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#1e2025);font-size:11px}",
	".dsh-to-roadmap-arrow{font-weight:650;color:var(--dsw-alias-label-tertiary,#a5a8b0)}",
	".dsh-to-roadmap-task{cursor:pointer;color:var(--dsw-alias-label-primary,#f5f6f7);overflow-wrap:anywhere}",
	".dsh-to-roadmap-task[data-missing=true]{color:var(--dsw-alias-state-error-primary,#f27777);font-style:italic}",
	".dsh-to-roadmap-empty{color:var(--dsw-alias-label-tertiary,#a5a8b0);font-size:11px;padding:4px 7px}",
	".dsh-to-criterion{display:flex;flex-direction:column;gap:4px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#363941);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#1e2025);margin-bottom:4px}",
	".dsh-to-criterion-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
	".dsh-to-criterion-criterion{flex:1 1 200px;font-size:11px;color:var(--dsw-alias-label-primary,#f5f6f7)}",
	".dsh-to-criterion-evidence{width:100%;min-height:46px}",
	"@media(max-width:800px){.dsh-to-panel{left:8px;right:8px;width:auto;top:8px;bottom:8px}.dsh-to-detail{flex-basis:270px}.dsh-to-column{flex-basis:150px}}"
].join("\n");
function node(tag, props = {}, children = []) {
	const value = document.createElement(tag);
	for (const [key, prop] of Object.entries(props)) applyProp(value, key, prop);
	for (const child of children) value.append(child instanceof Node ? child : document.createTextNode(String(child)));
	return value;
}
function applyProp(value, key, prop) {
	if (key === "className") value.className = prop;
	else if (key === "text") value.textContent = prop;
	else if (key.startsWith("on")) value.addEventListener(key.slice(2).toLowerCase(), prop);
	else if (key === "value") value.value = prop;
	else if (key === "checked") value.checked = Boolean(prop);
	else if (key === "selected") {
		if (prop) value.setAttribute("selected", "");
	} else if (key === "ariaPressed") value.setAttribute("aria-pressed", String(prop));
	else if (key === "dataset") for (const [dataKey, dataValue] of Object.entries(prop)) value.dataset[dataKey] = String(dataValue);
	else value.setAttribute(key, prop);
}
function clear(value) {
	while (value.firstChild) value.removeChild(value.firstChild);
}
function button(label, handler, className = "dsh-to-button") {
	return node("button", {
		type: "button",
		className,
		text: label,
		onClick: handler
	});
}
function field(label, input) {
	return node("label", { className: "dsh-to-form" }, [node("span", {
		className: "dsh-to-muted",
		text: label
	}), input]);
}
function statusSelect(value, onChange) {
	const select = node("select", {
		className: "dsh-to-select",
		onChange: (event) => onChange(event.target.value)
	});
	for (const status of BOARD_STATUSES) select.append(node("option", {
		value: status,
		text: STATUS_LABELS[status]
	}));
	select.value = value;
	return select;
}
function sidebarRoot() {
	const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
	if (column === null) return void 0;
	return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild ?? void 0;
}
function newSessionButton(root) {
	const nested = root.querySelector("button[class*=\"newSession\"]");
	if (nested !== null) return nested;
	for (const child of root.children) if (child.tagName === "BUTTON") return child;
}
function mountSidebarEntry(onToggle) {
	if (typeof document === "undefined" || document.querySelector("[data-dsh-task-orchestrator-entry]") !== null) return () => {};
	if (typeof MutationObserver === "undefined" || document.body === null) return () => {};
	const entry = document.createElement("button");
	entry.type = "button";
	entry.setAttribute("data-dsh-task-orchestrator-entry", "");
	entry.setAttribute("data-dsh-plugin", "task-orchestrator");
	entry.setAttribute("data-dsh-part", "sidebar-entry");
	entry.className = "dsh-to-sidebar-entry";
	entry.setAttribute("aria-label", "Open task orchestrator board");
	entry.title = "Task orchestrator";
	const icon = document.createElement("span");
	icon.className = "dsh-to-sidebar-icon";
	icon.innerHTML = "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2.5\" width=\"12\" height=\"11\" rx=\"1.5\"/><path d=\"M2 6.5h12M6.5 6.5v7\"/></svg>";
	const label = document.createElement("span");
	label.className = "dsh-to-sidebar-label";
	label.textContent = "Tasks";
	entry.append(icon, label);
	entry.addEventListener("click", onToggle);
	let root;
	let placed = false;
	const place = () => {
		root ?? (root = sidebarRoot());
		if (root === void 0) return;
		const button = newSessionButton(root);
		if (button === void 0) return;
		if (entry.parentElement !== root) {
			const row = button.closest("[class*=\"logoRow\"]");
			const base = row?.parentElement === root ? row : button;
			const family = Array.from(root.children).filter((child) => child.matches?.("[data-dsh-task-orchestrator-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]"));
			const anchor = family.length > 0 ? family[0] : base.nextElementSibling;
			root.insertBefore(entry, anchor ?? null);
		}
		placed = true;
	};
	const waitObserver = new MutationObserver(place);
	const rootObserver = new MutationObserver(() => {
		if (root === void 0 || !root.contains(entry)) {
			placed = false;
			place();
		}
	});
	waitObserver.observe(document.body, {
		childList: true,
		subtree: true
	});
	place();
	if (placed) rootObserver.observe(root, { childList: true });
	return () => {
		waitObserver.disconnect();
		rootObserver.disconnect();
		entry.remove();
	};
}
var TaskBoardView = class {
	constructor(client = new TaskOrchestratorClient()) {
		this.client = client;
		this.tasks = [];
		this.projects = [];
		this.linksByTask = {};
		this.selectedId = void 0;
		this.selectedProjectId = void 0;
		this.open = false;
		this.disposers = [];
		this.view = "board";
		this.filterStatus = "";
		this.filterProfile = "";
		this.filterProjectId = null;
		this.filterMilestoneId = null;
		this.worker = "board-worker";
		this.notice = "";
		this.noticeError = false;
		this.loadError = "";
	}
	mount() {
		if (typeof document === "undefined" || document.querySelector("[data-dsh-task-orchestrator-board]") !== null) return () => {};
		const style = node("style", { "data-dsh-task-orchestrator-style": "" }, [CSS]);
		document.head.append(style);
		this.panel = node("section", {
			className: "dsh-to-panel dsh-to-hidden",
			"data-dsh-task-orchestrator-board": "",
			"aria-label": "Task orchestrator board"
		});
		this.buildShell();
		document.body.append(this.panel);
		this.sidebarDisposer = mountSidebarEntry(() => this.toggle());
		this.disposers.push(() => style.remove(), () => this.sidebarDisposer?.(), () => this.panel.remove());
		this.refresh();
		return () => {
			for (const dispose of this.disposers.splice(0)) dispose();
		};
	}
	buildShell() {
		this.header = node("header", { className: "dsh-to-header" }, [
			node("div", {
				className: "dsh-to-title",
				text: "Task Orchestrator"
			}),
			button("Refresh", () => this.refresh()),
			button("New task", () => this.showCreate()),
			button("×", () => this.toggle(), "dsh-to-button dsh-to-button-danger")
		]);
		this.statusFilter = node("select", {
			className: "dsh-to-select",
			onChange: (event) => {
				this.filterStatus = event.target.value;
				this.renderActive();
			}
		});
		this.statusFilter.append(node("option", {
			value: "",
			text: "All statuses"
		}));
		for (const status of BOARD_STATUSES) this.statusFilter.append(node("option", {
			value: status,
			text: STATUS_LABELS[status]
		}));
		this.profileFilter = node("input", {
			className: "dsh-to-input dsh-to-input-small",
			placeholder: "worker profile",
			onInput: (event) => {
				this.filterProfile = event.target.value;
				this.renderActive();
			}
		});
		this.workerInput = node("input", {
			className: "dsh-to-input dsh-to-input-small",
			value: this.worker,
			placeholder: "worker id",
			onInput: (event) => {
				this.worker = event.target.value || "board-worker";
			}
		});
		this.projectFilter = node("select", {
			className: "dsh-to-select",
			onChange: (event) => {
				this.filterProjectId = event.target.value || null;
				this.renderActive();
			}
		});
		this.projectFilter.append(node("option", {
			value: "",
			text: "All projects"
		}), node("option", {
			value: "__none__",
			text: "No project"
		}));
		this.milestoneFilter = node("select", {
			className: "dsh-to-select",
			onChange: (event) => {
				this.filterMilestoneId = event.target.value || null;
				this.renderActive();
			}
		});
		this.milestoneFilter.append(node("option", {
			value: "",
			text: "All milestones"
		}), node("option", {
			value: "__none__",
			text: "No milestone"
		}));
		this.viewGroup = node("div", {
			className: "dsh-to-toolbar-group",
			role: "group",
			"aria-label": "View mode"
		});
		for (const mode of VIEW_MODES) this.viewGroup.append(button(VIEW_LABELS[mode], () => {
			this.view = mode;
			this.renderActive();
		}, "dsh-to-button"));
		this.toolbar = node("div", { className: "dsh-to-toolbar" }, [
			this.viewGroup,
			node("span", {
				className: "dsh-to-muted",
				text: "Filter"
			}),
			this.statusFilter,
			this.profileFilter,
			this.projectFilter,
			this.milestoneFilter,
			node("span", {
				className: "dsh-to-muted",
				text: "Worker"
			}),
			this.workerInput
		]);
		this.noticeNode = node("div", { className: "dsh-to-notice" });
		this.board = node("div", { className: "dsh-to-board" });
		this.outlinePane = node("div", { className: "dsh-to-outline dsh-to-hidden" });
		this.roadmapPane = node("div", { className: "dsh-to-roadmap dsh-to-hidden" });
		this.detail = node("aside", { className: "dsh-to-detail" });
		this.content = node("div", { className: "dsh-to-content" }, [
			this.board,
			this.outlinePane,
			this.roadmapPane,
			this.detail
		]);
		this.panel.append(this.header, this.toolbar, this.noticeNode, this.content);
		this.renderDetail();
	}
	toggle() {
		this.open = !this.open;
		this.panel?.classList.toggle("dsh-to-hidden", !this.open);
		if (this.open) this.refresh();
	}
	async refresh() {
		try {
			this.setNotice("Loading…");
			this.loadError = "";
			const [tasks, projects] = await Promise.all([this.client.list({ limit: 500 }), this.client.listProjects().catch(() => [])]);
			this.tasks = Array.isArray(tasks) ? tasks : [];
			this.projects = Array.isArray(projects) ? projects : [];
			if (this.selectedId !== void 0 && !this.tasks.some((task) => task.id === this.selectedId)) this.selectedId = void 0;
			this.populateProjectFilter();
			this.populateMilestoneFilter();
			this.renderActive();
			this.setNotice(this.tasks.length + " tasks · " + this.projects.length + " projects");
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
			this.setNotice(this.loadError, true);
		}
	}
	populateProjectFilter() {
		if (!this.projectFilter) return;
		while (this.projectFilter.children.length > 2) this.projectFilter.removeChild(this.projectFilter.lastChild);
		for (const project of this.projects) this.projectFilter.append(node("option", {
			value: project.id,
			text: project.name ?? project.title
		}));
		this.projectFilter.value = this.filterProjectId;
	}
	populateMilestoneFilter() {
		if (!this.milestoneFilter) return;
		while (this.milestoneFilter.children.length > 2) this.milestoneFilter.removeChild(this.milestoneFilter.lastChild);
		const milestones = this.collectMilestones();
		for (const milestone of milestones) this.milestoneFilter.append(node("option", {
			value: milestone.id,
			text: milestone.name ?? milestone.title
		}));
		this.milestoneFilter.value = this.filterMilestoneId;
	}
	collectMilestones() {
		const map = /* @__PURE__ */ new Map();
		for (const project of this.projects) for (const milestone of project.milestones ?? []) map.set(milestone.id, milestone);
		return Array.from(map.values()).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
	}
	setNotice(message, error = false) {
		if (this.noticeNode) {
			this.noticeNode.textContent = message;
			this.noticeNode.classList.toggle("dsh-to-notice-error", error);
		}
	}
	task(id) {
		return this.tasks.find((task) => task.id === id);
	}
	selectedProject() {
		return this.projects.find((project) => project.id === this.selectedProjectId);
	}
	visibleTasks() {
		return this.tasks.filter((task) => (this.filterStatus === "" || task.status === this.filterStatus) && (this.filterProfile === "" || task.worker_profile === this.filterProfile) && matchesFilter(task.project_id ?? null, this.filterProjectId) && matchesFilter(task.milestone_id ?? null, this.filterMilestoneId));
	}
	setView(mode) {
		if (!VIEW_MODES.includes(mode)) return;
		this.view = mode;
		this.renderActive();
	}
	renderActive() {
		if (this.viewGroup) {
			for (const child of this.viewGroup.children) if (child.tagName === "BUTTON") child.setAttribute("aria-pressed", String(child.textContent === VIEW_LABELS[this.view]));
		}
		if (this.board) this.board.classList.toggle("dsh-to-hidden", this.view !== "board");
		if (this.outlinePane) this.outlinePane.classList.toggle("dsh-to-hidden", this.view !== "outline");
		if (this.roadmapPane) this.roadmapPane.classList.toggle("dsh-to-hidden", this.view !== "roadmap");
		if (this.view === "board") this.renderBoard();
		else if (this.view === "outline") this.renderOutline();
		else if (this.view === "roadmap") this.renderRoadmap();
		this.renderDetail();
	}
	renderBoard() {
		if (!this.board) return;
		clear(this.board);
		for (const status of BOARD_STATUSES) {
			const tasks = this.visibleTasks().filter((task) => task.status === status);
			const cards = node("div", { className: "dsh-to-column-cards" });
			for (const task of tasks) cards.append(this.renderCard(task));
			this.board.append(node("section", { className: "dsh-to-column" }, [node("div", { className: "dsh-to-column-header" }, [STATUS_LABELS[status], node("span", {
				className: "dsh-to-count",
				text: String(tasks.length)
			})]), cards]));
		}
	}
	renderCard(task) {
		const card = node("article", {
			className: "dsh-to-card" + (task.id === this.selectedId ? " dsh-to-card-selected" : ""),
			onClick: () => {
				this.selectedId = task.id;
				this.renderActive();
			}
		});
		const meta = [];
		if (task.priority && task.priority !== "normal") meta.push(task.priority);
		if (task.worker_profile) meta.push(task.worker_profile);
		if (task.blocked_by?.length) meta.push("blocked: " + task.blocked_by.length);
		card.append(node("div", {
			className: "dsh-to-card-title",
			text: task.title
		}), node("div", {
			className: "dsh-to-muted",
			text: task.id
		}), node("div", { className: "dsh-to-card-meta" }, meta.map((value) => node("span", {
			className: "dsh-to-badge" + (value.startsWith("blocked") ? " dsh-to-badge-warn" : ""),
			text: value
		}))));
		const actions = node("div", { className: "dsh-to-card-actions" });
		if (task.status === "ready" && !task.blocked_by?.length) actions.append(button("Claim", () => this.run(() => this.client.claim(task.id, this.worker))));
		if (task.status === "claimed" && task.claimed_by === this.worker) actions.append(button("Start", () => this.run(() => this.client.start(task.id, this.worker))));
		if (task.status === "running" && task.claimed_by === this.worker) actions.append(button("Complete", () => {
			this.selectedId = task.id;
			this.renderActive();
		}));
		if (task.status === "blocked") actions.append(button("Unblock", () => this.run(() => this.client.unblock(task.id))));
		if (task.status === "in_review") actions.append(button("Done", () => this.run(() => this.client.update(task.id, { status: "done" }), task.id)));
		if (actions.childElementCount) card.append(actions);
		return card;
	}
	renderOutline() {
		if (!this.outlinePane) return;
		clear(this.outlinePane);
		const filtered = this.visibleTasks();
		const grouped = groupTasksByProjectMilestone(filtered, { projects: this.projects.length > 0 ? this.projects : Array.from(new Set(filtered.map((task) => task.project_id).filter(Boolean))).map((id) => ({
			id,
			title: id,
			milestones: []
		})) });
		if (grouped.length === 0) {
			this.outlinePane.append(this.renderEmptyState("No tasks match the current filters. Create a task or clear the filters."));
			return;
		}
		for (const project of grouped) {
			const projectTasks = project.milestones.flatMap((milestone) => milestone.tasks);
			const projectSummary = summarizeStatuses(projectTasks);
			const projectCriteria = projectCompletionCriteria(project);
			const unmetProjectCriteria = projectCriteria.filter((criterion, index) => {
				const text = typeof criterion === "string" ? criterion : criterion && typeof criterion === "object" ? criterion.criterion ?? criterion.text ?? JSON.stringify(criterion) : String(criterion);
				return !projectTasks.some((task) => task.criterion_results?.some((entry) => (entry.criterion === text || entry.index === index) && (entry.status === "satisfied" || entry.status === "waived")));
			});
			const section = node("section", { className: "dsh-to-outline-project" });
			const header = node("div", { className: "dsh-to-outline-header" }, [
				node("h3", { text: project.name ?? project.title }),
				node("span", {
					className: "dsh-to-muted",
					text: project.id
				}),
				button("View detail", () => {
					this.selectedProjectId = project.id;
					this.renderDetail();
				}, "dsh-to-button")
			]);
			const progress = node("div", { className: "dsh-to-outline-progress" });
			progress.append(node("strong", { text: projectSummary.completion_percent + "%" }), node("span", { text: " · " + projectSummary.done + "/" + projectSummary.active_total + " done" }));
			if (projectCriteria.length) progress.append(node("span", { text: " · " + (projectCriteria.length - unmetProjectCriteria.length) + "/" + projectCriteria.length + " criteria met" }));
			section.append(header, progress);
			if (project.description) section.append(node("p", {
				className: "dsh-to-muted",
				text: project.description
			}));
			if (projectCriteria.length) section.append(node("div", { className: "dsh-to-section" }, [node("h4", { text: "Project completion criteria" }), this.renderCriteriaList(projectCriteria, unmetProjectCriteria, projectTasks)]));
			const milestoneContainer = node("div", { className: "dsh-to-outline-milestones" });
			if (project.milestones.length === 0) milestoneContainer.append(this.renderEmptyState("No milestones or unassigned tasks in this project."));
			for (const milestone of project.milestones) milestoneContainer.append(this.renderOutlineMilestone(milestone));
			section.append(milestoneContainer);
			this.outlinePane.append(section);
		}
	}
	renderOutlineMilestone(milestone) {
		const milestoneSummary = summarizeStatuses(milestone.tasks);
		const criteriaCounts = summarizeCriteria(milestone.tasks);
		const exitCriteria = milestoneExitCriteria(milestone, milestone.tasks);
		const container = node("section", { className: "dsh-to-outline-milestone" });
		const header = node("div", { className: "dsh-to-outline-milestone-header" }, [node("h4", { text: milestone.name ?? milestone.title }), node("span", {
			className: "dsh-to-muted",
			text: milestone.id
		})]);
		const summary = node("div", { className: "dsh-to-outline-progress" });
		summary.append(node("strong", { text: milestoneSummary.completion_percent + "%" }), node("span", { text: " · " + milestoneSummary.done + "/" + milestoneSummary.active_total + " done" }));
		if (criteriaCounts.total > 0) summary.append(node("span", { text: " · " + criteriaCounts.satisfied + "/" + criteriaCounts.total + " criteria satisfied" }));
		container.append(header, summary);
		if (exitCriteria.length > 0) {
			const list = node("ul", { className: "dsh-to-outline-exit" });
			for (const entry of exitCriteria) list.append(node("li", {
				dataset: { met: String(entry.met) },
				text: (entry.met ? "✓ " : "• ") + entry.criterion + (entry.met && entry.evidence_task_id ? " (see " + entry.evidence_task_id + ")" : "")
			}));
			container.append(node("div", { className: "dsh-to-section" }, [node("h4", { text: "Exit criteria" }), list]));
		}
		if (milestone.tasks.length === 0) container.append(this.renderEmptyState("No tasks in this milestone yet."));
		else {
			const tree = buildHierarchy(milestone.tasks);
			const taskContainer = node("div", { className: "dsh-to-outline-tasks" });
			const renderNode = (task, depth) => {
				taskContainer.append(this.renderOutlineTask(task, depth));
				for (const child of task.children) renderNode(child, depth + 1);
			};
			for (const root of tree) renderNode(root, 0);
			container.append(taskContainer);
		}
		return container;
	}
	renderOutlineTask(task, depth) {
		const ready = isReadyToRun(task);
		const blocked = isDependencyBlocked(task);
		const unmet = unmetCriteria(task);
		const container = node("div", {
			className: "dsh-to-outline-task" + (depth > 0 ? " dsh-to-outline-task-child" : ""),
			dataset: { selected: String(task.id === this.selectedId) }
		});
		const title = node("span", {
			className: "dsh-to-outline-task-title",
			text: task.title,
			onClick: () => {
				this.selectedId = task.id;
				this.renderActive();
			}
		});
		container.append(title);
		container.append(node("span", {
			className: "dsh-to-badge",
			text: STATUS_LABELS[task.status] ?? task.status
		}));
		if (ready) container.append(node("span", {
			className: "dsh-to-badge dsh-to-badge-success",
			text: "ready"
		}));
		if (blocked) container.append(node("span", {
			className: "dsh-to-badge dsh-to-badge-warn",
			text: "blocked"
		}));
		if (unmet.length > 0) container.append(node("span", {
			className: "dsh-to-badge dsh-to-badge-warn",
			text: unmet.length + " unmet"
		}));
		return container;
	}
	renderRoadmap() {
		if (!this.roadmapPane) return;
		clear(this.roadmapPane);
		const tasks = this.visibleTasks();
		if (tasks.length === 0) {
			this.roadmapPane.append(this.renderEmptyState("No tasks match the current filters."));
			return;
		}
		const edges = buildRoadmapEdges(tasks, this.linksByTask);
		const blockingSection = node("section", {
			className: "dsh-to-roadmap-section",
			dataset: { kind: "blocking" }
		}, [node("h3", { text: "Blocking dependencies (readiness-gating)" })]);
		if (edges.blocking.length === 0) blockingSection.append(this.renderEmptyState("No blocking dependencies in this slice."));
		else blockingSection.append(this.renderEdgesList(edges.blocking));
		const typedSection = node("section", {
			className: "dsh-to-roadmap-section",
			dataset: { kind: "typed" }
		}, [node("h3", { text: "Typed nonblocking relationships" })]);
		if (edges.typed.length === 0) typedSection.append(this.renderEmptyState("No typed links in this slice. Use task links (enables, usually_follows, benefits_from, related_to) to surface advisory relationships here."));
		else {
			const grouped = /* @__PURE__ */ new Map();
			for (const edge of edges.typed) {
				const list = grouped.get(edge.link_type) ?? [];
				list.push(edge);
				grouped.set(edge.link_type, list);
			}
			for (const linkType of TASK_LINK_TYPES) {
				const list = grouped.get(linkType);
				if (!list?.length) continue;
				typedSection.append(node("h4", {
					className: "dsh-to-muted",
					text: linkType + " (" + list.length + ")"
				}));
				typedSection.append(this.renderEdgesList(list));
			}
		}
		this.roadmapPane.append(blockingSection, typedSection);
	}
	renderEdgesList(edges) {
		const list = node("ul", { className: "dsh-to-roadmap-edges" });
		for (const edge of edges) {
			const item = node("li", { className: "dsh-to-roadmap-edge" });
			const fromText = edge.from ? edge.from.title : "(missing " + edge.from_id + ")";
			const toText = edge.to ? edge.to.title : "(missing " + edge.to_id + ")";
			const fromNode = node("span", {
				className: "dsh-to-roadmap-task",
				text: fromText,
				dataset: { missing: String(!edge.from) },
				onClick: () => this.selectEdgeEndpoint(edge, "from")
			});
			const toNode = node("span", {
				className: "dsh-to-roadmap-task",
				text: toText,
				dataset: { missing: String(!edge.to) },
				onClick: () => this.selectEdgeEndpoint(edge, "to")
			});
			const arrow = node("span", {
				className: "dsh-to-roadmap-arrow",
				text: edge.kind === "blocking_dependency" ? " → blocks → " : " — " + edge.link_type + " —> "
			});
			item.append(fromNode, arrow, toNode);
			if (edge.kind === "typed_link") item.append(node("span", {
				className: "dsh-to-badge",
				text: edge.link_type
			}));
			list.append(item);
		}
		return list;
	}
	selectEdgeEndpoint(edge, side) {
		const id = side === "from" ? edge.from_id : edge.to_id;
		if (!id || !this.tasks.some((task) => task.id === id)) {
			this.setNotice("Task " + id + " is outside the current filter slice.", true);
			return;
		}
		this.selectedId = id;
		this.setView("board");
		this.renderActive();
	}
	renderEmptyState(message) {
		return node("div", {
			className: "dsh-to-roadmap-empty",
			text: message
		});
	}
	renderCriteriaList(criteria, unmet, tasks) {
		const container = node("div", { className: "dsh-to-criteria" });
		for (let index = 0; index < criteria.length; index++) {
			const criterion = criteria[index];
			const text = typeof criterion === "string" ? criterion : criterion && typeof criterion === "object" ? criterion.criterion ?? criterion.text ?? JSON.stringify(criterion) : String(criterion);
			const isUnmet = unmet.some((item) => {
				if (typeof item === "string") return item === text;
				return (typeof item === "object" && item !== null ? item.criterion ?? item.text ?? "" : "") === text;
			});
			const evidenceTask = tasks.find((task) => task.criterion_results?.some((entry) => (entry.criterion === text || entry.index === index) && (entry.status === "satisfied" || entry.status === "waived")));
			const row = node("div", { className: "dsh-to-criterion-row" }, [
				node("span", {
					className: "dsh-to-badge " + (isUnmet ? "dsh-to-badge-warn" : "dsh-to-badge-success"),
					text: isUnmet ? "unmet" : "met"
				}),
				node("span", {
					className: "dsh-to-criterion-criterion",
					text
				}),
				evidenceTask ? node("span", {
					className: "dsh-to-muted",
					text: "evidence: " + evidenceTask.id
				}) : null
			].filter(Boolean));
			container.append(row);
		}
		return container;
	}
	renderDetail() {
		if (!this.detail) return;
		clear(this.detail);
		if (this.selectedProjectId !== void 0 && this.selectedProject() !== void 0) {
			this.renderProjectDetail(this.selectedProject());
			return;
		}
		const task = this.selectedId === void 0 ? void 0 : this.task(this.selectedId);
		if (task === void 0) {
			this.detail.append(node("div", {
				className: "dsh-to-muted",
				text: "Select a task or project to inspect it, or create a new task."
			}));
			return;
		}
		this.detail.append(node("h3", { text: task.title }), node("div", {
			className: "dsh-to-muted",
			text: task.id + " · " + STATUS_LABELS[task.status]
		}));
		if (task.project_id || task.milestone_id) {
			const parts = [];
			if (task.project_id) parts.push("project: " + task.project_id);
			if (task.milestone_id) parts.push("milestone: " + task.milestone_id);
			this.detail.append(node("div", {
				className: "dsh-to-muted",
				text: parts.join(" · ")
			}));
		}
		this.detail.append(node("p", {
			className: "dsh-to-muted",
			text: task.description || "No description."
		}));
		this.detail.append(node("div", { className: "dsh-to-form-row" }, [statusSelect(task.status, (value) => this.run(() => this.client.update(task.id, { status: value }), task.id)), button("Reload", () => this.refresh())]));
		this.detail.append(node("section", { className: "dsh-to-section" }, [node("h4", { text: "Acceptance criteria" }), task.acceptance_criteria?.length ? node("ul", { className: "dsh-to-list" }, task.acceptance_criteria.map((value) => node("li", { text: value }))) : node("div", {
			className: "dsh-to-muted",
			text: "None recorded."
		})]));
		this.appendCriterionResults(task);
		const controls = node("div", { className: "dsh-to-form-row" });
		if (task.status === "ready" && task.ready_to_run) controls.append(button("Claim", () => this.run(() => this.client.claim(task.id, this.worker), task.id)));
		if (task.status === "claimed" && task.claimed_by === this.worker) controls.append(button("Start", () => this.run(() => this.client.start(task.id, this.worker), task.id)), button("Release", () => this.run(() => this.client.release(task.id, this.worker), task.id)));
		if (task.status === "running" && task.claimed_by === this.worker) controls.append(button("Renew lease", () => this.run(() => this.client.renewLease(task.id, this.worker), task.id)));
		if (task.status === "in_review") controls.append(button("Mark done", () => this.run(() => this.client.update(task.id, { status: "done" }), task.id)), button("Request changes", () => this.requestChanges(task)));
		if (task.status === "blocked") controls.append(button("Unblock", () => this.run(() => this.client.unblock(task.id), task.id)));
		if (controls.childElementCount) this.detail.append(controls);
		if (task.status === "running" && task.claimed_by === this.worker) this.appendCompletionForm(task);
		this.appendDependencies(task);
		this.appendLinks(task);
		this.appendEvents(task);
	}
	renderProjectDetail(project) {
		this.detail.append(node("h3", { text: project.name ?? project.title }), node("div", {
			className: "dsh-to-muted",
			text: project.id + " · " + (project.status ?? "planning")
		}));
		if (project.description) this.detail.append(node("p", {
			className: "dsh-to-muted",
			text: project.description
		}));
		const tasks = this.tasks.filter((task) => task.project_id === project.id);
		const summary = summarizeStatuses(tasks);
		const criteria = summarizeCriteria(tasks);
		const completionCriteria = projectCompletionCriteria(project);
		this.detail.append(node("section", { className: "dsh-to-section" }, [node("h4", { text: "Progress" }), node("div", {
			className: "dsh-to-muted",
			text: summary.completion_percent + "% · " + summary.done + "/" + summary.active_total + " done · " + summary.cancelled + " cancelled"
		})]));
		if (criteria.total > 0) this.detail.append(node("section", { className: "dsh-to-section" }, [node("h4", { text: "Criterion status" }), node("div", {
			className: "dsh-to-muted",
			text: "satisfied " + criteria.satisfied + " · pending " + criteria.pending + " · waived " + criteria.waived + " · other " + criteria.other
		})]));
		if (completionCriteria.length) {
			const unmet = completionCriteria.filter((criterion, index) => {
				const text = typeof criterion === "string" ? criterion : criterion && typeof criterion === "object" ? criterion.criterion ?? criterion.text ?? JSON.stringify(criterion) : String(criterion);
				return !tasks.some((task) => task.criterion_results?.some((entry) => (entry.criterion === text || entry.index === index) && (entry.status === "satisfied" || entry.status === "waived")));
			});
			this.detail.append(node("section", { className: "dsh-to-section" }, [
				node("h4", { text: "Completion criteria" }),
				this.renderCriteriaList(completionCriteria, unmet, tasks),
				node("div", {
					className: "dsh-to-muted",
					text: completionCriteria.length - unmet.length + "/" + completionCriteria.length + " met"
				})
			]));
		}
		const milestones = project.milestones ?? [];
		if (milestones.length) {
			const list = node("ul", { className: "dsh-to-list" }, milestones.map((milestone) => {
				const ms = summarizeStatuses(tasks.filter((task) => task.milestone_id === milestone.id));
				return node("li", { text: (milestone.name ?? milestone.title) + " · " + ms.done + "/" + ms.active_total + " done · " + (milestone.status ?? "planning") });
			}));
			this.detail.append(node("section", { className: "dsh-to-section" }, [node("h4", { text: "Milestones" }), list]));
		}
		const specSection = node("section", { className: "dsh-to-section" }, [node("h4", { text: "Specification" })]);
		const spec = project.specification ?? {};
		if (spec && Object.keys(spec).length > 0) {
			const rows = [];
			for (const [key, value] of Object.entries(spec)) {
				if (value === null || value === void 0 || value === "") continue;
				const text = Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
				rows.push(node("div", {
					className: "dsh-to-muted",
					text: key + ": " + text
				}));
			}
			if (rows.length === 0) specSection.append(node("div", {
				className: "dsh-to-muted",
				text: "No specification recorded."
			}));
			else rows.forEach((row) => specSection.append(row));
		} else specSection.append(node("div", {
			className: "dsh-to-muted",
			text: "No specification recorded."
		}));
		this.detail.append(specSection);
		const actions = node("div", { className: "dsh-to-form-row" }, [
			button("Open in outline", () => {
				this.setView("outline");
				this.renderActive();
			}),
			button("Open roadmap", () => {
				this.setView("roadmap");
				this.renderActive();
			}),
			button("Close", () => {
				this.selectedProjectId = void 0;
				this.renderDetail();
			})
		]);
		this.detail.append(actions);
	}
	appendCriterionResults(task) {
		const list = node("section", { className: "dsh-to-section" }, [node("h4", { text: "Criterion results" })]);
		if (!Array.isArray(task.criterion_results) || task.criterion_results.length === 0) list.append(node("div", {
			className: "dsh-to-muted",
			text: "No criterion results recorded. Use the form below to record evidence."
		}));
		else for (const entry of task.criterion_results) {
			const row = node("div", { className: "dsh-to-criterion" }, [node("div", { className: "dsh-to-criterion-row" }, [node("span", {
				className: "dsh-to-badge " + (entry.status === "satisfied" ? "dsh-to-badge-success" : entry.status === "pending" ? "dsh-to-badge-warn" : ""),
				text: entry.status
			}), node("span", {
				className: "dsh-to-criterion-criterion",
				text: entry.criterion || "(unnamed criterion)"
			})]), entry.evidence ? node("div", {
				className: "dsh-to-muted",
				text: entry.evidence
			}) : node("div", {
				className: "dsh-to-muted",
				text: "No evidence recorded."
			})]);
			list.append(row);
		}
		const form = this.buildCriterionResultsForm(task);
		if (form) list.append(form);
		this.detail.append(list);
	}
	buildCriterionResultsForm(task) {
		const criteria = Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [];
		if (criteria.length === 0) return null;
		const state = criteria.map((criterion, index) => {
			const existing = (task.criterion_results ?? []).find((entry) => entry.criterion === criterion || entry.index === index);
			return {
				index,
				criterion,
				status: existing?.status ?? "pending",
				evidence: existing?.evidence ?? ""
			};
		});
		const rowsContainer = node("div");
		const renderRows = () => {
			clear(rowsContainer);
			for (let index = 0; index < state.length; index++) {
				const entry = state[index];
				const statusSelectEl = node("select", {
					className: "dsh-to-select",
					onChange: (event) => {
						entry.status = event.target.value;
					}
				});
				for (const status of CRITERION_STATUSES) {
					const opt = node("option", {
						value: status,
						text: status
					});
					if (status === entry.status) opt.setAttribute("selected", "");
					statusSelectEl.append(opt);
				}
				const evidence = node("textarea", {
					className: "dsh-to-textarea dsh-to-criterion-evidence",
					rows: "2",
					placeholder: "Evidence, command output, or note",
					onInput: (event) => {
						entry.evidence = event.target.value;
					}
				});
				evidence.value = entry.evidence;
				rowsContainer.append(node("div", { className: "dsh-to-criterion" }, [node("div", { className: "dsh-to-criterion-row" }, [node("span", {
					className: "dsh-to-criterion-criterion",
					text: entry.criterion
				}), statusSelectEl]), evidence]));
			}
		};
		renderRows();
		return node("form", {
			className: "dsh-to-form",
			onSubmit: (event) => {
				event.preventDefault();
				const validated = buildCriterionResultsPayload(state.map((entry) => ({
					index: entry.index,
					criterion: entry.criterion,
					status: entry.status,
					evidence: entry.evidence
				})));
				if (!validated.ok) {
					this.setNotice(validated.error, true);
					return;
				}
				this.run(() => this.client.setCriterionResults(task.id, validated.normalized), task.id);
			}
		}, [
			node("h4", { text: "Update criterion results" }),
			rowsContainer,
			node("button", {
				type: "submit",
				className: "dsh-to-button dsh-to-button-primary",
				text: "Save criterion results"
			})
		]);
	}
	appendCompletionForm(task) {
		const summary = node("textarea", {
			className: "dsh-to-textarea",
			rows: "3",
			placeholder: "Result summary"
		});
		const commit = node("input", {
			className: "dsh-to-input",
			placeholder: "Commit SHA (optional)"
		});
		const tests = node("textarea", {
			className: "dsh-to-textarea",
			rows: "2",
			placeholder: "Tests run, one per line"
		});
		const form = node("form", {
			className: "dsh-to-form dsh-to-section",
			onSubmit: (event) => {
				event.preventDefault();
				this.run(() => this.client.complete(task.id, this.worker, {
					result_summary: summary.value,
					commit_sha: commit.value || void 0,
					tests_run: tests.value.split("\n").map((value) => value.trim()).filter(Boolean)
				}), task.id);
			}
		}, [
			node("h4", { text: "Structured completion" }),
			summary,
			commit,
			tests,
			node("button", {
				type: "submit",
				className: "dsh-to-button dsh-to-button-primary",
				text: "Complete → review"
			})
		]);
		this.detail.append(form);
	}
	appendDependencies(task) {
		const dependencyInput = node("input", {
			className: "dsh-to-input",
			placeholder: "Task ID to add as dependency"
		});
		const form = node("form", {
			className: "dsh-to-form dsh-to-section",
			onSubmit: (event) => {
				event.preventDefault();
				if (dependencyInput.value) this.run(() => this.client.addDependency(task.id, dependencyInput.value), task.id);
			}
		}, [
			node("h4", { text: "Blocking dependencies" }),
			node("div", {
				className: "dsh-to-muted",
				text: task.blocked_by?.length ? "Blocked by: " + task.blocked_by.join(", ") : "No unfinished blockers."
			}),
			node("div", { className: "dsh-to-form-row" }, [dependencyInput, node("button", {
				type: "submit",
				className: "dsh-to-button",
				text: "Add"
			})])
		]);
		this.detail.append(form);
	}
	appendLinks(task) {
		const list = node("section", { className: "dsh-to-section" }, [node("h4", { text: "Typed nonblocking links" })]);
		const known = this.linksByTask[task.id] ?? [];
		if (known.length === 0) list.append(node("div", {
			className: "dsh-to-muted",
			text: "No typed links recorded. Links are advisory and never gate readiness."
		}));
		else {
			const ul = node("ul", { className: "dsh-to-list" }, known.map((link) => node("li", { text: link.link_type + " → " + link.linked_task_id })));
			list.append(ul);
		}
		const linkedId = node("input", {
			className: "dsh-to-input",
			placeholder: "Linked task ID"
		});
		const typeSelect = node("select", { className: "dsh-to-select" });
		for (const linkType of TASK_LINK_TYPES) typeSelect.append(node("option", {
			value: linkType,
			text: linkType
		}));
		const addForm = node("form", {
			className: "dsh-to-form",
			onSubmit: (event) => {
				event.preventDefault();
				if (!linkedId.value) return;
				this.run(async () => {
					await this.client.addLink(task.id, linkedId.value, typeSelect.value);
					this.linksByTask[task.id] = await this.client.listLinks(task.id);
					this.renderDetail();
				}, task.id);
			}
		}, [node("div", { className: "dsh-to-form-row" }, [
			linkedId,
			typeSelect,
			node("button", {
				type: "submit",
				className: "dsh-to-button",
				text: "Add link"
			})
		])]);
		list.append(addForm);
		this.detail.append(list);
	}
	async appendEvents(task) {
		try {
			const events = await this.client.events(task.id, 12);
			const list = node("div", { className: "dsh-to-section" }, [node("h4", { text: "Recent events" })]);
			for (const event of events) list.append(node("div", { className: "dsh-to-event" }, [node("strong", { text: event.event_type }), " · " + (event.actor || "system")]));
			this.detail.append(list);
		} catch {}
	}
	showCreate() {
		this.selectedId = void 0;
		this.selectedProjectId = void 0;
		clear(this.detail);
		const title = node("input", {
			className: "dsh-to-input",
			placeholder: "Task title",
			required: "true"
		});
		const description = node("textarea", {
			className: "dsh-to-textarea",
			rows: "4",
			placeholder: "Description"
		});
		const profile = node("input", {
			className: "dsh-to-input",
			placeholder: "Worker profile (optional)"
		});
		const criteria = node("textarea", {
			className: "dsh-to-textarea",
			rows: "4",
			placeholder: "Acceptance criteria, one per line"
		});
		const status = statusSelect("backlog", () => {});
		const projectSelect = node("select", { className: "dsh-to-select" });
		projectSelect.append(node("option", {
			value: "",
			text: "No project"
		}));
		for (const project of this.projects) projectSelect.append(node("option", {
			value: project.id,
			text: project.name ?? project.title
		}));
		const milestoneSelect = node("select", { className: "dsh-to-select" });
		const refreshMilestones = () => {
			while (milestoneSelect.children.length > 1) milestoneSelect.removeChild(milestoneSelect.lastChild);
			milestoneSelect.append(node("option", {
				value: "",
				text: "No milestone"
			}));
			const project = this.projects.find((p) => p.id === projectSelect.value);
			for (const milestone of project?.milestones ?? []) milestoneSelect.append(node("option", {
				value: milestone.id,
				text: milestone.name ?? milestone.title
			}));
		};
		refreshMilestones();
		projectSelect.addEventListener("change", refreshMilestones);
		const form = node("form", {
			className: "dsh-to-form",
			onSubmit: (event) => {
				event.preventDefault();
				this.run(async () => {
					const payload = {
						title: title.value,
						description: description.value,
						status: status.value,
						worker_profile: profile.value || void 0,
						acceptance_criteria: criteria.value.split("\n").map((value) => value.trim()).filter(Boolean)
					};
					if (projectSelect.value) payload.project_id = projectSelect.value;
					if (milestoneSelect.value) payload.milestone_id = milestoneSelect.value;
					const task = await this.client.create(payload);
					this.selectedId = task.id;
					return task;
				}, void 0, true);
			}
		}, [
			node("h3", { text: "New task" }),
			field("Title", title),
			field("Description", description),
			field("Initial status", status),
			field("Project", projectSelect),
			field("Milestone", milestoneSelect),
			field("Worker profile", profile),
			field("Acceptance criteria", criteria),
			node("button", {
				type: "submit",
				className: "dsh-to-button dsh-to-button-primary",
				text: "Create task"
			})
		]);
		this.detail.append(form);
	}
	showEdit(task) {
		this.selectedId = task.id;
		this.selectedProjectId = void 0;
		clear(this.detail);
		const title = node("input", {
			className: "dsh-to-input",
			value: task.title
		});
		const description = node("textarea", {
			className: "dsh-to-textarea",
			rows: "4"
		});
		description.value = task.description ?? "";
		const profile = node("input", {
			className: "dsh-to-input",
			value: task.worker_profile ?? ""
		});
		const status = statusSelect(task.status, () => {});
		const projectSelect = node("select", { className: "dsh-to-select" });
		projectSelect.append(node("option", {
			value: "",
			text: "No project"
		}));
		for (const project of this.projects) projectSelect.append(node("option", {
			value: project.id,
			text: project.name ?? project.title
		}));
		projectSelect.value = task.project_id ?? "";
		const milestoneSelect = node("select", { className: "dsh-to-select" });
		const refreshMilestones = () => {
			while (milestoneSelect.children.length > 1) milestoneSelect.removeChild(milestoneSelect.lastChild);
			milestoneSelect.append(node("option", {
				value: "",
				text: "No milestone"
			}));
			const project = this.projects.find((p) => p.id === projectSelect.value);
			for (const milestone of project?.milestones ?? []) milestoneSelect.append(node("option", {
				value: milestone.id,
				text: milestone.name ?? milestone.title
			}));
			milestoneSelect.value = task.milestone_id ?? "";
		};
		refreshMilestones();
		projectSelect.addEventListener("change", refreshMilestones);
		const form = node("form", {
			className: "dsh-to-form",
			onSubmit: (event) => {
				event.preventDefault();
				this.run(async () => {
					const patch = {
						title: title.value,
						description: description.value,
						status: status.value,
						worker_profile: profile.value || void 0
					};
					patch.project_id = projectSelect.value || null;
					patch.milestone_id = milestoneSelect.value || null;
					await this.client.update(task.id, patch);
				}, task.id);
			}
		}, [
			node("h3", { text: "Edit task" }),
			field("Title", title),
			field("Description", description),
			field("Status", status),
			field("Project", projectSelect),
			field("Milestone", milestoneSelect),
			field("Worker profile", profile),
			node("button", {
				type: "submit",
				className: "dsh-to-button dsh-to-button-primary",
				text: "Save changes"
			})
		]);
		this.detail.append(form);
	}
	requestChanges(task) {
		const reason = globalThis.prompt?.("What needs changing?", "Please address the review notes.");
		if (reason) this.run(() => this.client.requestChanges(task.id, reason), task.id);
	}
	async loadLinksForTask(taskId) {
		try {
			this.linksByTask[taskId] = await this.client.listLinks(taskId);
		} catch {
			this.linksByTask[taskId] = [];
		}
	}
	async run(operation, selectedId = this.selectedId, keepDetail = false) {
		try {
			this.setNotice("Saving…");
			await operation();
			if (selectedId !== void 0) this.selectedId = selectedId;
			await this.refresh();
			if (selectedId !== void 0) await this.loadLinksForTask(selectedId);
			if (keepDetail) this.renderDetail();
		} catch (error) {
			this.setNotice(error instanceof Error ? error.message : String(error), true);
		}
	}
};
function apply(ctx) {
	const view = new TaskBoardView();
	ctx.effect(() => view.mount(), "task-orchestrator-board: browser UI");
}
//#endregion
exports.TaskBoardView = TaskBoardView;
exports.VIEW_MODES = VIEW_MODES;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

    return module.exports
  },
})
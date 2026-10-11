import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { descendantsOf, executionResultKey, getCachedRecords, isTerminalStatus, isUnclaimableCorpse, listFooterDismissed, registryDir } from "./registry.ts";
import type { AgentRecord } from "./types.ts";

/** How often the live activity line is refreshed. 2s: the line is passive
 * status, and every tick runs on the TUI thread (select/copy stutter if hot).
 * Freshness is exact anyway: registry writes bump the runs-dir mtime, which
 * the shared record cache checks on every tick. */
export const POLL_MS = 2000;

function statusIcon(record: AgentRecord): string {
	switch (record.status) {
		case "completed":
		case "cancelled":
			return "✓";
		case "failed":
			return "✗";
		case "queued":
			return "◌";
		case "idle":
			return "◐";
		default:
			return "●";
	}
}

function statusColor(record: AgentRecord): "success" | "error" | "warning" | "accent" {
	if (record.status === "completed") return "success";
	if (record.status === "failed" || record.status === "cancelled") return "error";
	if (record.status === "idle") return "warning";
	return "accent";
}

/**
 * Passive subagent status footer. Shows one indented line per descendant whose
 * result the parent has not consumed yet: running children, plus finished ones
 * whose report is still outstanding. A child disappears the moment its result
 * is delivered to its direct parent (resultsDelivered) — i.e. once the parent
 * has read it. No interaction: control flow is the tools, not the UI.
 */
export class SubagentStatusWidget implements Component {
	private lines: string[] = [];
	private lastKey = "";
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private theme: Theme,
		private readonly agentDir: string,
		private readonly currentRunId: string,
		private readonly hideUnclaimableAfterDays: number = 7,
	) {
		this.refresh();
		this.timer = setInterval(() => this.refresh(), POLL_MS);
		this.timer.unref?.();
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		this.refresh();
	}

	/** Outstanding descendants: not yet read by their direct parent. */
	private dismissedCache: { mtimeMs: number; keys: Set<string> } = { mtimeMs: -1, keys: new Set() };

	/** Runs I dismissed, memoized on the runs-dir mtime so idle refreshes scan nothing. */
	private dismissedByMe(): Set<string> {
		let mtimeMs = this.dismissedCache.mtimeMs;
		try {
			mtimeMs = statSync(registryDir(this.agentDir)).mtimeMs;
		} catch {
			return this.dismissedCache.keys;
		}
		if (mtimeMs !== this.dismissedCache.mtimeMs) {
			try {
				this.dismissedCache = { mtimeMs, keys: new Set(listFooterDismissed(this.agentDir, this.currentRunId)) };
			} catch {
				// Keep the stale set; the next tick retries.
			}
		}
		return this.dismissedCache.keys;
	}

	private outstanding(): AgentRecord[] {
		// Runs I dismissed (viewed read-only) stay hidden across reloads, like
		// delivered ones; a new execution resurfaces under a new key.
		const dismissed = this.dismissedByMe();
		const all = getCachedRecords(this.agentDir);
		const byId = new Map(all.map((record) => [record.runId, record]));
		const visible = descendantsOf(all, this.currentRunId).filter(
			(record) => !(isTerminalStatus(record.status) && (record.resultsDelivered || dismissed.has(executionResultKey(record))))
				&& !isUnclaimableCorpse(record, (() => { const parent = byId.get(record.parentRunId); return !!parent && isTerminalStatus(parent.status); })(), Date.now(), this.hideUnclaimableAfterDays),
		);
		// Keep every visible row's ancestry: a live grandchild must never
		// render as a root-level run after its parents are collected.
		const keep = new Set(visible.map((record) => record.runId));
		for (const record of visible) {
			let parentId = record.parentRunId;
			while (parentId && parentId !== this.currentRunId && !keep.has(parentId)) {
				const parent = byId.get(parentId);
				if (!parent) break;
				keep.add(parentId);
				parentId = parent.parentRunId;
			}
		}
		// Parent-first, family-grouped: registry order is arbitrary, so sort
		// by (direct-child family, depth) for a readable top-down tree.
		const index = new Map(all.map((record, i) => [record.runId, i]));
		const familyRoot = (record) => {
			let node = record;
			for (;;) {
				const parent = byId.get(node.parentRunId);
				if (!parent || parent.runId === this.currentRunId) return node.runId;
				node = parent;
			}
		};
		return all
			.filter((record) => keep.has(record.runId))
			.sort((a, b) => index.get(familyRoot(a))! - index.get(familyRoot(b))! || a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	private build(): string[] {
		const rows = this.outstanding();
		if (rows.length === 0) return [];
		// Compact box-drawing tree: roots bare, children on ├─/└─ branches,
		// deeper levels guided by │ only where a sibling follows below.
		// Rows arrive parent-first and family-grouped with siblings ordered
		// by name, so branch positions are deterministic.
		const byId = new Map(rows.map((record) => [record.runId, record]));
		const isRoot = (record: AgentRecord) =>
			record.parentRunId === this.currentRunId || !byId.has(record.parentRunId);
		const lastSibling = new Map<string, string>();
		for (const record of rows) {
			if (!isRoot(record)) lastSibling.set(record.parentRunId, record.runId);
		}
		const prefixFor = (record: AgentRecord): string => {
			if (isRoot(record)) return "";
			const ancestors: AgentRecord[] = [];
			let id = record.parentRunId;
			while (id && id !== this.currentRunId) {
				const parent = byId.get(id);
				if (!parent) break;
				ancestors.unshift(parent);
				id = parent.parentRunId;
			}
			// Guides cover every ancestor below the family root, which is bare.
			const guides = ancestors
				.slice(1)
				.map((ancestor) => (lastSibling.get(ancestor.parentRunId) === ancestor.runId ? "   " : "│  "))
				.join("");
			return guides + (lastSibling.get(record.parentRunId) === record.runId ? "└─ " : "├─ ");
		};
		return rows.map((record) => {
			const icon = this.theme.fg(statusColor(record), statusIcon(record));
			const activity = record.currentTool || record.activity || record.status;
			const adopted = record.adoptedFrom ? ` · adopted` : "";
			// Short model id (provider prefix dropped) plus thinking level.
			const model = record.model.split("/").pop() || record.model;
			const thinking = record.thinking ? ` · ${record.thinking}` : "";
			return `${prefixFor(record)}${icon} ${record.name} ${this.theme.fg("dim", `${model}${thinking} · ${activity}${adopted}`)}`;
		});
	}

	private refresh(): void {
		const lines = this.build();
		const key = lines.join("\n");
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.lines = lines;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {
		this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}

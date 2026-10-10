import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { descendantsOf, executionResultKey, getCachedRecords, isTerminalStatus, listFooterDismissed, registryDir, relativeDepths } from "./registry.ts";
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
		return descendantsOf(getCachedRecords(this.agentDir), this.currentRunId).filter(
			(record) => !(isTerminalStatus(record.status) && (record.resultsDelivered || dismissed.has(executionResultKey(record)))),
		);
	}

	private build(): string[] {
		const rows = this.outstanding();
		if (rows.length === 0) return [];
		const depths = relativeDepths(rows, this.currentRunId);
		const byId = new Map(getCachedRecords(this.agentDir).map((record) => [record.runId, record]));
		return rows.map((record) => {
			const indent = "  ".repeat(depths.get(record.runId) ?? 0);
			const icon = this.theme.fg(statusColor(record), statusIcon(record));
			const activity = record.currentTool || record.activity || record.status;
			const adopted = record.adoptedFrom ? ` · adopted` : "";
			// Non-direct rows name their parent so an orphaned run never
			// looks like a promoted child once its parent is collected.
			const via = record.parentRunId !== this.currentRunId ? ` · via ${byId.get(record.parentRunId)?.name ?? record.parentRunId}` : "";
			return `${indent}${icon} ${record.name} ${this.theme.fg("dim", `${via} · ${record.model} · ${activity}${adopted}`)}`;
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

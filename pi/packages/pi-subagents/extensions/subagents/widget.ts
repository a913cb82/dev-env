import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { descendantsOf, isTerminalStatus, readRecords, relativeDepths } from "./registry.ts";
import type { AgentRecord } from "./types.ts";

/** How often the live activity line is refreshed. */
const POLL_MS = 500;

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
	private outstanding(): AgentRecord[] {
		return descendantsOf(readRecords(this.agentDir), this.currentRunId).filter(
			(record) => !(isTerminalStatus(record.status) && record.resultsDelivered),
		);
	}

	private build(): string[] {
		const rows = this.outstanding();
		if (rows.length === 0) return [];
		const depths = relativeDepths(rows, this.currentRunId);
		return rows.map((record) => {
			const indent = "  ".repeat(depths.get(record.runId) ?? 0);
			const icon = this.theme.fg(statusColor(record), statusIcon(record));
			const activity = record.currentTool || record.activity || record.status;
			return `${indent}${icon} ${record.name} ${this.theme.fg("dim", `· ${record.model} · ${activity}`)}`;
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

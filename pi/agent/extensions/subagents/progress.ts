import { descendantsOf, getCachedRecords, isTerminalStatus } from "./registry.ts";

/** True while any descendant still works (not terminal). Dismissed-but-
 * running rows count: dismissal hides the row, not the work. */
export function subtreeBusy(agentDir: string, currentRunId: string): boolean {
	let all;
	try {
		all = getCachedRecords(agentDir);
	} catch {
		return false;
	}
	return descendantsOf(all, currentRunId).some((record) => !isTerminalStatus(record.status));
}

/** The pi-tui terminal surface the widget drives: TUI.terminal. */
export interface TerminalProgress {
	setProgress(active: boolean): void;
}

export interface ProgressSyncState {
	asserted: boolean;
}

export function newProgressSyncState(): ProgressSyncState {
	return { asserted: false };
}

/** Edge-triggered OSC 9;4 driver. Pi owns the indicator across its own
 * turn (turn_start→agent_end) and goes quiet on agent_end even with
 * subagents still busy, so the widget asserts progress exactly while Pi
 * does not: busy and idle main session turns it on, a drained subtree
 * turns it off. Ownership rules: the setting off clears our own assertion
 * and otherwise stays silent (never touching Pi's); a driving main session
 * yields silently so Pi's indicator survives; repeats never re-emit. */
export function syncTerminalProgress(
	state: ProgressSyncState,
	terminal: TerminalProgress | undefined,
	opts: { showProgress: boolean; mainDriving: boolean; busy: boolean },
): void {
	if (!terminal || typeof terminal.setProgress !== "function") return;
	const release = () => {
		try {
			terminal.setProgress(false);
		} catch {
			// Best effort: a dying terminal must not break the tick.
		}
		state.asserted = false;
	};
	if (!opts.showProgress) {
		if (state.asserted) release();
		return;
	}
	if (opts.mainDriving) {
		state.asserted = false;
		return;
	}
	if (opts.busy && !state.asserted) {
		try {
			terminal.setProgress(true);
		} catch {
			// Best effort.
		}
		state.asserted = true;
	} else if (!opts.busy && state.asserted) {
		release();
	}
}

/** Pi's own progress window (its turn_start→agent_end) is tracked by the
 * extension instance and handed to the widget as a reader: while it drives,
 * the widget yields the indicator silently. Kept out of this module so the
 * driver stays a pure edge-triggered function of its inputs. */

/**
 * Tokens-per-second meter.
 *
 * Renders a live braille line graph of output tokens/sec while the model streams,
 * with the response average (and current rate) to the right of it.
 *
 * - Live rate is estimated from streamed deltas (~4 chars/token) over a sliding window.
 * - When each assistant message finishes, the estimate is corrected using the
 *   provider-reported `usage.output`, so the average is accurate.
 * - Only time spent generating (first token → message end) is counted; TTFT and
 *   tool execution are excluded from the headline average. A second average that
 *   includes model wait (request -> first token, never tool time) is shown beneath it.
 *
 * Commands: /tps          toggle the meter
 *           /tps on|off   show / hide the meter
 *           /tps clear    reset the graph
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const TICK_MS = 250; // one sample per tick (2 samples per braille column)
const WINDOW_MS = 1000; // sliding window for the instantaneous rate
const CHARS_PER_TOKEN = 4;
const GRAPH_ROWS = 3; // terminal rows (each = 4 braille dots tall)
const PANEL_WIDTH = 38;
const AXIS_WIDTH = 5;
const STASH_KEY = Symbol.for("pi.tps-meter.stash");

// Braille dot bits indexed [y][x] within a 2x4 cell.
const DOTS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

interface State {
	samples: number[]; // tok/s, one per tick while generating
	windowEvents: { t: number; tokens: number }[];
	current: number;
	// response totals (corrected with real usage at message end)
	totalTokens: number;
	genMs: number;
	waitMs: number; // time between message start and first token (excluded from avg)
	// per-message streaming state
	streaming: boolean;
	msgStartAt?: number;
	turnStartAt?: number; // set right before each model request (after tools finish)
	msgFirstTokenAt?: number;
	msgEstimated: number;
	active: boolean; // agent run in progress
	model?: string;
}

function freshState(): State {
	return {
		samples: [],
		windowEvents: [],
		current: 0,
		totalTokens: 0,
		genMs: 0,
		waitMs: 0,
		streaming: false,
		msgEstimated: 0,
		active: false,
	};
}

function niceMax(v: number): number {
	if (v <= 0) return 10;
	const exp = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
	return 10 * exp;
}

function fmtRate(v: number): string {
	return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function fmtCount(n: number): string {
	return n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`;
}

/** Draw samples as a connected braille line. Returns `rows` strings of `cols` chars. */
function brailleLine(samples: number[], cols: number, rows: number, max: number): string[] {
	const w = cols * 2;
	const h = rows * 4;
	const grid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
	const data = samples.slice(-w);
	const offset = w - data.length; // right-align: newest on the right
	const set = (x: number, y: number) => {
		if (x < 0 || x >= w || y < 0 || y >= h) return;
		grid[Math.floor(y / 4)][Math.floor(x / 2)] |= DOTS[y % 4][x % 2];
	};
	const toY = (v: number) => h - 1 - Math.round((Math.min(v, max) / max) * (h - 1));
	let prevY: number | undefined;
	for (let i = 0; i < data.length; i++) {
		const x = offset + i;
		const y = toY(data[i]);
		if (prevY === undefined) set(x, y);
		else {
			// Split the vertical jump between the previous and current column so the line stays continuous
			const mid = (prevY + y) / 2;
			const step = y > prevY ? 1 : -1;
			for (let yy = prevY; yy !== y + step; yy += step) set(step * (yy - mid) <= 0 ? x - 1 : x, yy);
		}
		prevY = y;
	}
	return grid.map((row) => row.map((bits) => String.fromCharCode(0x2800 + bits)).join(""));
}

export default function (pi: ExtensionAPI) {
	// /reload replaces this runtime; carry the meter across it via a process-global stash.
	const stash = (globalThis as any)[STASH_KEY] as { enabled: boolean; state: State } | undefined;
	delete (globalThis as any)[STASH_KEY];
	let enabled = stash?.enabled ?? true;
	let state = stash?.state ?? freshState();
	// Nothing can be in flight across a reload.
	state.active = false;
	state.streaming = false;
	state.turnStartAt = undefined;
	state.msgStartAt = undefined;
	state.msgFirstTokenAt = undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;

	const pruneWindow = (now: number) => {
		while (state.windowEvents.length && now - state.windowEvents[0].t > WINDOW_MS) state.windowEvents.shift();
	};

	const tick = () => {
		const now = Date.now();
		pruneWindow(now);
		if (state.streaming && state.msgFirstTokenAt !== undefined) {
			const span = Math.max(TICK_MS, Math.min(WINDOW_MS, now - state.msgFirstTokenAt));
			const tokens = state.windowEvents.reduce((s, e) => s + e.tokens, 0);
			state.current = span > 0 ? (tokens / span) * 1000 : 0;
			state.samples.push(state.current);
			if (state.samples.length > 2000) state.samples.splice(0, state.samples.length - 2000);
		} else if (!state.streaming) {
			state.current = 0;
		}
		requestRender?.();
	};

	const startTimer = () => {
		if (!timer) timer = setInterval(tick, TICK_MS);
	};
	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("tps-meter", (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				dispose() {
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (state.samples.length === 0 && !state.active) {
						const cols = Math.max(8, width - AXIS_WIDTH - PANEL_WIDTH - 3);
						const idle = [
							theme.fg("muted", "— tok/s avg"),
							theme.fg("dim", "no response yet"),
							theme.fg("dim", "○ idle"),
						];
						const axis = ["", "", "0"];
						return idle.map((p, r) =>
							truncateToWidth(
								theme.fg("dim", `${axis[r].padStart(AXIS_WIDTH - 1)} ┤`) +
									theme.fg("dim", (r === GRAPH_ROWS - 1 ? "⣀" : "⠀").repeat(cols)) +
									"  " +
									p,
								width,
							),
						);
					}

					const liveGen = state.streaming && state.msgFirstTokenAt !== undefined;
					const liveMs = liveGen ? Date.now() - state.msgFirstTokenAt! : 0;
					const tokens = state.totalTokens + (liveGen ? state.msgEstimated : 0);
					const ms = state.genMs + liveMs;
					const avg = ms > 0 ? (tokens / ms) * 1000 : 0;
					const liveWait =
						state.streaming && state.msgStartAt !== undefined
							? (state.msgFirstTokenAt ?? Date.now()) - state.msgStartAt
							: state.active && state.turnStartAt !== undefined
								? Date.now() - state.turnStartAt
								: 0;
					const waitMs = state.waitMs + liveWait;
					const avgInclWait = ms + waitMs > 0 ? (tokens / (ms + waitMs)) * 1000 : 0;

					const graphCols = Math.max(8, width - AXIS_WIDTH - PANEL_WIDTH - 3);
					const visible = state.samples.slice(-graphCols * 2);
					const max = niceMax(Math.max(avg, ...visible, 1) * 1.1);
					const graph = brailleLine(state.samples, graphCols, GRAPH_ROWS, max);

					const axis = [String(Math.round(max)), "", "0"].map((s) => s.padStart(AXIS_WIDTH - 1));

					const status = state.streaming
						? state.msgFirstTokenAt === undefined
							? theme.fg("warning", "● waiting")
							: theme.fg("success", "● streaming")
						: state.active && state.turnStartAt !== undefined
							? theme.fg("warning", "● waiting")
							: state.active
								? theme.fg("muted", "◌ tools")
							: theme.fg("dim", "○ done");
					const panel = [
						theme.style(`${fmtRate(avg)}`, { fg: "accent", bold: true }) +
							theme.fg("muted", " tok/s avg ") +
							theme.fg("dim", `(excl. ${(waitMs / 1000).toFixed(1)}s model wait)`),
						theme.fg("text", `${fmtRate(avgInclWait)}`) +
							theme.fg("muted", " incl. wait · ") +
							theme.fg("text", `${fmtRate(state.current)}`) +
							theme.fg("muted", " now"),
						status + theme.fg("dim", `  ${fmtCount(tokens)} tok · ${(ms / 1000).toFixed(1)}s gen`),
					];

					const lines: string[] = [];
					for (let r = 0; r < GRAPH_ROWS; r++) {
						const line =
							theme.fg("dim", `${axis[r]} ┤`) +
							theme.fg("accent", graph[r]) +
							"  " +
							(panel[r] ?? "");
						lines.push(truncateToWidth(line, width));
					}
					return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
				},
			};
		});
	};

	pi.on("session_start", (e, ctx) => {
		// A different session's graph is stale; keep it only across startup/reload.
		if (e.reason === "new" || e.reason === "resume" || e.reason === "fork") state = freshState();
		if (enabled) install(ctx);
	});

	pi.on("session_shutdown", (e) => {
		if (e.reason === "reload") (globalThis as any)[STASH_KEY] = { enabled, state };
		stopTimer();
		requestRender = undefined;
	});

	pi.on("agent_start", () => {
		state = freshState();
		state.active = true;
		startTimer();
	});

	pi.on("agent_end", () => {
		state.active = false;
		state.streaming = false;
		stopTimer();
		tick();
	});

	pi.on("turn_start", () => {
		state.turnStartAt = Date.now();
	});

	pi.on("message_start", (e) => {
		if (e.message.role !== "assistant") return;
		state.streaming = true;
		// Wait = model request -> first token. Measured from turn_start (which follows tool
		// execution), so tool time is never counted as waiting.
		state.msgStartAt = state.turnStartAt ?? Date.now();
		state.turnStartAt = undefined;
		state.msgFirstTokenAt = undefined;
		state.msgEstimated = 0;
		state.windowEvents = [];
	});

	pi.on("message_update", (e) => {
		const ev = e.assistantMessageEvent;
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
		const now = Date.now();
		if (state.msgFirstTokenAt === undefined) state.msgFirstTokenAt = now;
		const tokens = ev.delta.length / CHARS_PER_TOKEN;
		state.msgEstimated += tokens;
		state.windowEvents.push({ t: now, tokens });
	});

	pi.on("message_end", (e) => {
		if (e.message.role !== "assistant") return;
		const msg = e.message as AssistantMessage;
		if (state.msgStartAt !== undefined) state.waitMs += (state.msgFirstTokenAt ?? Date.now()) - state.msgStartAt;
		if (state.msgFirstTokenAt !== undefined) {
			const ms = Date.now() - state.msgFirstTokenAt;
			const reported = msg.usage?.output ?? 0;
			state.totalTokens += reported > 0 ? reported : state.msgEstimated;
			state.genMs += ms;
		}
		state.streaming = false;
		state.msgStartAt = undefined;
		state.msgFirstTokenAt = undefined;
		state.msgEstimated = 0;
		state.windowEvents = [];
		requestRender?.();
	});

	pi.registerCommand("tps", {
		description: "Tokens-per-second meter: /tps [on|off|clear] (no arg toggles)",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "on", label: "on", description: "Show the meter" },
				{ value: "off", label: "off", description: "Hide the meter" },
				{ value: "clear", label: "clear", description: "Reset the graph" },
			].filter((i) => i.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "clear") {
				state = freshState();
				requestRender?.();
				return;
			}
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg === "") enabled = !enabled;
			else {
				ctx.ui.notify(`Unknown /tps argument "${arg}". Use on, off, or clear.`, "warning");
				return;
			}
			if (enabled) install(ctx);
			else {
				ctx.ui.setWidget("tps-meter", undefined);
				requestRender = undefined;
			}
			ctx.ui.notify(`TPS meter ${enabled ? "on" : "off"}`, "info");
		},
	});
}

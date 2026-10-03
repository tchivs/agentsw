import pc from "picocolors";
import { isJson, isQuiet, note } from "./ui.js";

const FRAMES = ["|", "/", "-", "\\"];
const CLEAR = "\r\u001b[2K";

export interface ProgressHandle {
  update(message: string): void;
  stop(): void;
  succeed(message?: string): void;
  fail(message?: string): void;
}

export interface ProgressOptions {
  enabled?: boolean;
  stream?: NodeJS.WriteStream;
  intervalMs?: number;
  delayMs?: number;
  frames?: string[];
}

/** `npm test` frequently runs in a real terminal, where stderr is still a TTY — never animate under it. */
function isTestRunner(): boolean {
  return process.env.NODE_TEST_CONTEXT !== undefined || process.argv.includes("--test");
}

export function progressEnabled(options: ProgressOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  const stream = options.stream ?? process.stderr;
  return stream.isTTY === true
    && !isJson()
    && !isQuiet()
    && !isTestRunner()
    && process.env.AGENTSW_NO_PROGRESS !== "1";
}

interface Live {
  handle: ProgressHandle;
  /** Returns the message it replaced, so a nested borrower can restore it. */
  setText(next: string): string;
}

let live: Live | undefined;

/**
 * Progress feedback for slow awaits. Renders one animated stderr line on a TTY; everywhere else it degrades
 * to the single dim line the CLI printed before, so pipes and CI logs keep exactly the same content.
 */
export function startProgress(message: string, options: ProgressOptions = {}): ProgressHandle {
  // A nested caller borrows the live line: it may retitle it, but stopping must not tear down the owner.
  if (live) {
    const owner = live;
    const previous = owner.setText(message);
    let finished = false;
    return {
      update(next: string) { owner.setText(next); },
      stop() {
        if (finished) return;
        finished = true;
        owner.setText(previous);
      },
      succeed() {},
      fail() {},
    };
  }

  const enabled = progressEnabled(options);
  const stream = options.stream ?? process.stderr;
  const intervalMs = options.intervalMs ?? 80;
  const delayMs = options.delayMs ?? 150;
  const frames = options.frames ?? FRAMES;

  let text = message;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  let painted = false;
  let stopped = false;

  // Disabled path: reproduce the old static line exactly once. Callers no longer print it themselves.
  if (!enabled) note(message);

  const clear = (): void => {
    if (painted) stream.write(CLEAR);
    painted = false;
  };
  const paint = (): void => {
    stream.write(`${CLEAR}${pc.dim(frames[frame % frames.length]!)} ${pc.dim(text)}`);
    painted = true;
    frame++;
  };
  const onInterrupt = (): void => {
    clear();
    process.exit(130);
  };

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = undefined;
    }
    if (enabled) process.removeListener("SIGINT", onInterrupt);
    clear();
    if (live?.handle === handle) live = undefined;
  };

  const handle: ProgressHandle = {
    update(next: string) { text = next; },
    stop: finish,
    succeed(message?: string) { finish(); if (message) note(message); },
    fail(message?: string) { finish(); if (message) stream.write(pc.red(message) + "\n"); },
  };

  live = { handle, setText(next: string) { const previous = text; text = next; return previous; } };

  if (enabled) {
    process.once("SIGINT", onInterrupt);
    // Nothing is painted until the delay elapses, so cached and local work never flickers.
    timer = setTimeout(() => {
      if (stopped) return;
      paint();
      timer = setInterval(() => { if (!stopped) paint(); }, intervalMs);
      timer.unref();
    }, delayMs);
    timer.unref();
  }

  return handle;
}

export async function withProgress<T>(
  message: string,
  fn: (handle: ProgressHandle) => Promise<T>,
  options?: ProgressOptions,
): Promise<T> {
  const handle = startProgress(message, options);
  try {
    return await fn(handle);
  } finally {
    handle.stop();
  }
}

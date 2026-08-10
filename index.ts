#!/usr/bin/env bun

import path from "path";

const STATE_FILE = "/tmp/csharpierd-state.json";
const LOCK_FILE = "/tmp/csharpierd.lock";
// CSharpier >= 1.3.0 serves via HttpListener, which matches requests against the
// registered prefix `http://127.0.0.1:<port>/` by Host header. A request sent to
// "localhost" carries `Host: localhost:<port>`, does not match, and gets a 404.
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 18912;
const MIN_CSHARPIER_VERSION = "1.3.0";
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Color utilities using Bun.color
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const colorize = (text: string, color: string): string => {
  return `${Bun.color(color, "ansi")}${text}${RESET}`;
};

const bold = (text: string): string => {
  return `${BOLD}${text}${RESET}`;
};

interface ServerState {
  pid: number;
  port: number;
  lastAccess: number;
}

// Expected failures (bad setup, CSharpier rejecting a file). These are reported
// as a plain message, since a stack trace only adds noise to an editor's log.
class CsharpierdError extends Error {}

// Acquire lock to prevent race conditions
async function acquireLock(): Promise<boolean> {
  try {
    const lockFile = Bun.file(LOCK_FILE);
    if (await lockFile.exists()) {
      // Check if lock is stale (older than 10 seconds)
      const stat = await Bun.file(LOCK_FILE).stat();
      if (Date.now() - stat.mtime.getTime() > 10000) {
        await Bun.$`rm -f ${LOCK_FILE}`;
      } else {
        return false;
      }
    }
    await Bun.write(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await Bun.$`rm -f ${LOCK_FILE}`.quiet();
}

// Load server state
async function loadState(): Promise<ServerState | null> {
  try {
    const file = Bun.file(STATE_FILE);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}

// Save server state
async function saveState(state: ServerState): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

// Check if process is running
async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    const result = await Bun.$`kill -0 ${pid}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// Check if server is responsive
async function isServerResponsive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${SERVER_HOST}:${port}/`, {
      signal: AbortSignal.timeout(50),
    });
    // CSharpier answers GET / with 405 (only POST is allowed), so any response
    // means the server is up. A 404 means we reached something that is not a
    // CSharpier server, so don't treat it as healthy.
    return response.status !== 404;
  } catch {
    return false;
  }
}

// Collect a process and all of its descendants, deepest first
async function collectTree(pid: number): Promise<number[]> {
  const children = await Bun.$`pgrep -P ${pid}`
    .quiet()
    .nothrow()
    .text()
    .then((out) =>
      out
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((child) => Number.isInteger(child) && child > 0),
    )
    .catch(() => [] as number[]);

  const descendants = await Promise.all(children.map(collectTree));
  return [...descendants.flat(), pid];
}

// Kill a server process together with its children. `dotnet csharpier` is only a
// launcher: it spawns the real CSharpier.dll process, which owns the port. Killing
// the launcher alone leaves that child orphaned and still holding SERVER_PORT.
async function killServer(pid: number): Promise<void> {
  try {
    const tree = await collectTree(pid);
    await Bun.$`kill ${tree}`.quiet().nothrow();
    // Wait a bit and force kill whatever survived
    await Bun.sleep(500);
    const survivors: number[] = [];
    for (const treePid of tree) {
      if (await isProcessRunning(treePid)) survivors.push(treePid);
    }
    if (survivors.length > 0) {
      await Bun.$`kill -9 ${survivors}`.quiet().nothrow();
    }
  } catch {
    // Ignore errors
  }
}

// Find the process listening on a port, if any
async function findPortOwner(port: number): Promise<number | null> {
  const output = await Bun.$`ss -ltnpH sport = :${port}`
    .quiet()
    .nothrow()
    .text()
    .catch(() => "");
  const match = output.match(/pid=(\d+)/);
  return match ? Number(match[1]) : null;
}

// Reclaim the port from a server we no longer track, so the new one can bind it
async function reclaimPort(): Promise<void> {
  const owner = await findPortOwner(SERVER_PORT);
  if (owner === null) return;
  console.error(
    `Port ${SERVER_PORT} held by untracked process ${owner}, reclaiming...`,
  );
  await killServer(owner);
}

// Verify the installed CSharpier speaks the protocol this daemon targets.
// 1.3.0 moved server mode onto HttpListener, which changed how requests are
// routed; older releases are not supported.
async function assertSupportedCSharpier(): Promise<void> {
  const output = await Bun.$`dotnet csharpier --version`
    .quiet()
    .nothrow()
    .text()
    .catch(() => "");
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    throw new CsharpierdError(
      "Could not determine the CSharpier version. Is CSharpier installed? " +
        `csharpierd requires CSharpier ${MIN_CSHARPIER_VERSION} or newer (1.x).`,
    );
  }

  const [, major, minor] = match.map(Number) as [unknown, number, number];
  if (major !== 1 || minor < 3) {
    throw new CsharpierdError(
      `CSharpier ${match[0]} is not supported. csharpierd requires ` +
        `CSharpier ${MIN_CSHARPIER_VERSION} or newer (1.x).`,
    );
  }
}

// Start CSharpier server
async function startServer(): Promise<number> {
  await assertSupportedCSharpier();

  console.error("Starting CSharpier server...");

  // A stale server would keep the port and silently answer our health checks
  // while the process we spawn dies with "address already in use".
  await reclaimPort();

  // Start server in background
  const proc = Bun.spawn(
    ["dotnet", "csharpier", "server", "--server-port", String(SERVER_PORT)],
    {
      stdout: null,
      stderr: null,
    },
  );

  const pid = proc.pid;
  proc.unref(); // Allow parent to exit without waiting

  // Wait for server to be ready (max 10 seconds)
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200);
    if (await isServerResponsive(SERVER_PORT)) {
      console.error(`CSharpier server started with PID ${pid}`);
      return pid;
    }
  }

  throw new Error("Server failed to start within timeout");
}

// Cleanup idle servers
async function cleanupIdleServer(state: ServerState): Promise<void> {
  const idleTime = Date.now() - state.lastAccess;
  if (idleTime > IDLE_TIMEOUT_MS) {
    console.error(
      `Server idle for ${Math.floor(idleTime / 1000)}s, shutting down...`,
    );
    await killServer(state.pid);
    await Bun.$`rm -f ${STATE_FILE}`.quiet();
  }
}

// Ensure server is running
async function ensureServer(): Promise<ServerState> {
  // Try to acquire lock with retries
  for (let i = 0; i < 5; i++) {
    if (await acquireLock()) break;
    await Bun.sleep(100);
  }

  try {
    let state = await loadState();

    // Check if we have a running server
    if (state) {
      // Check idle timeout
      await cleanupIdleServer(state);

      // Responsiveness is what actually matters; the tracked PID is only used to
      // shut the server down later.
      if (await isServerResponsive(state.port)) {
        if (!(await isProcessRunning(state.pid))) {
          // The launcher exited but the server it spawned is still serving.
          // Re-point the state at the process that owns the port so --stop works.
          const owner = await findPortOwner(state.port);
          if (owner !== null) {
            state.pid = owner;
            await saveState(state);
          }
        }
        return state;
      }

      console.error("Server not responsive, restarting...");
      if (await isProcessRunning(state.pid)) {
        await killServer(state.pid);
      }
    }

    // Start new server
    const pid = await startServer();
    state = {
      pid,
      port: SERVER_PORT,
      lastAccess: Date.now(),
    };
    await saveState(state);
    return state;
  } finally {
    await releaseLock();
  }
}

interface FormatResult {
  formattedFile?: string;
  errorMessage?: string;
  status: "Formatted" | "Ignored" | "Failed" | "UnsupportedFile";
}

// Format code
async function formatCode(
  fileName: string,
  fileContents: string,
): Promise<string> {
  const state = await ensureServer();
  const filePath = path.isAbsolute(fileName)
    ? fileName
    : path.join(process.cwd(), fileName);

  const response = await fetch(`http://${SERVER_HOST}:${state.port}/format`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: filePath,
      fileContents,
    }),
  });

  if (!response.ok) {
    throw new CsharpierdError(
      `CSharpier server returned ${response.status}: ${await response.text()}`,
    );
  }

  const result = (await response.json()) as FormatResult;

  // Update last access time
  state.lastAccess = Date.now();
  await saveState(state);

  if (!result.formattedFile) {
    throw new CsharpierdError(
      result.errorMessage ?? `CSharpier returned status "${result.status}"`,
    );
  }

  return result.formattedFile;
}

// Show help message
function showHelp(): void {
  console.log(`csharpierd - CSharpier formatting daemon

Usage:
  csharpierd <filename> < input.cs    Format C# code from stdin
  csharpierd --start                  Start and prewarm the server
  csharpierd --status                 Show server status
  csharpierd --stop                   Stop the background server
  csharpierd --help                   Show this help message

Description:
  A persistent CSharpier formatting daemon that starts a background server
  on first use and reuses it for subsequent formatting requests. The server
  automatically shuts down after 1 hour of inactivity.

Examples:
  # Start and prewarm the server
  csharpierd --start

  # Format a C# file
  csharpierd Program.cs < Program.cs

  # Format and save to a new file
  csharpierd MyFile.cs < MyFile.cs > MyFile.formatted.cs

  # Using cat
  cat Program.cs | csharpierd Program.cs

  # Check server status
  csharpierd --status

  # Stop the background server
  csharpierd --stop

Server Details:
  Port:          ${SERVER_PORT}
  State File:    ${STATE_FILE}
  Lock File:     ${LOCK_FILE}
  Idle Timeout:  ${IDLE_TIMEOUT_MS / 1000 / 60} minutes
`);
}

// Stop the server
async function stopServer(): Promise<void> {
  const state = await loadState();

  if (!state) {
    console.error("No server is currently running");
    return;
  }

  console.error(`Stopping CSharpier server (PID ${state.pid})...`);
  await killServer(state.pid);
  await Bun.$`rm -f ${STATE_FILE} ${LOCK_FILE}`.quiet();
  console.error("Server stopped successfully");
}

// Show server status
async function showStatus(): Promise<void> {
  const state = await loadState();

  console.log(bold("\nCSharpier Server Status"));
  console.log("═".repeat(50));

  if (!state) {
    console.log(colorize("Status:", "cyan"), colorize("NOT RUNNING", "red"));
    console.log("\nNo server is currently active.");
    console.log(
      "The server will start automatically on the first format request.",
    );
    return;
  }

  // Check if process is actually running
  const isRunning = await isProcessRunning(state.pid);
  const isResponsive = isRunning ? await isServerResponsive(state.port) : false;

  if (isRunning && isResponsive) {
    console.log(colorize("Status:", "cyan"), colorize("RUNNING", "green"));
  } else if (isRunning && !isResponsive) {
    console.log(colorize("Status:", "cyan"), colorize("STARTING", "yellow"));
  } else {
    console.log(colorize("Status:", "cyan"), colorize("STOPPED", "red"));
  }

  console.log(colorize("PID:", "cyan"), state.pid);
  console.log(colorize("Port:", "cyan"), state.port);

  // Calculate and display uptime
  const now = Date.now();
  const lastAccess = new Date(state.lastAccess);
  const idleTime = now - state.lastAccess;
  const idleMinutes = Math.floor(idleTime / 1000 / 60);
  const idleSeconds = Math.floor((idleTime / 1000) % 60);

  console.log(colorize("Last Access:", "cyan"), lastAccess.toLocaleString());

  const idleTimeStr = `${idleMinutes}m ${idleSeconds}s`;
  const timeoutMinutes = IDLE_TIMEOUT_MS / 1000 / 60;

  if (idleMinutes >= timeoutMinutes) {
    console.log(
      colorize("Idle Time:", "cyan"),
      colorize(idleTimeStr, "red"),
      "(will shutdown)",
    );
  } else if (idleMinutes >= timeoutMinutes * 0.75) {
    console.log(
      colorize("Idle Time:", "cyan"),
      colorize(idleTimeStr, "yellow"),
      `(${timeoutMinutes - idleMinutes}m until timeout)`,
    );
  } else {
    console.log(colorize("Idle Time:", "cyan"), colorize(idleTimeStr, "green"));
  }

  console.log(colorize("State File:", "cyan"), STATE_FILE);
  console.log(colorize("Lock File:", "cyan"), LOCK_FILE);
  console.log(colorize("Idle Timeout:", "cyan"), `${timeoutMinutes} minutes`);
  console.log("");
}

// Main
async function main() {
  const arg = process.argv[2];

  // Handle --help flag
  if (arg === "--help" || arg === "-h") {
    showHelp();
    process.exit(0);
  }

  // Handle --status flag
  if (arg === "--status") {
    await showStatus();
    process.exit(0);
  }

  // Handle --stop flag
  if (arg === "--stop") {
    await stopServer();
    process.exit(0);
  }

  // Handle --start flag
  if (arg === "--start") {
    await ensureServer();
    console.error("CSharpier server is ready");
    process.exit(0);
  }

  // Normal formatting mode
  const fileName = arg;
  if (!fileName) {
    console.error("Usage: csharpierd <filename> < input.cs");
    console.error("Try 'csharpierd --help' for more information");
    process.exit(1);
  }

  // Read stdin
  const reader = process.stdin;
  const chunks: Buffer[] = [];

  for await (const chunk of reader) {
    chunks.push(chunk);
  }

  const fileContents = Buffer.concat(chunks).toString("utf-8");

  if (!fileContents) {
    console.error("Error: No input provided via stdin");
    process.exit(1);
  }

  // Format and output
  const formatted = await formatCode(fileName, fileContents);
  process.stdout.write(formatted);
}

main().catch((error) => {
  if (error instanceof CsharpierdError) {
    console.error(`csharpierd: ${error.message}`);
  } else {
    console.error("Fatal error:", error);
  }
  process.exit(1);
});

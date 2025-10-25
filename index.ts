#!/usr/bin/env bun

import path from "path";

const STATE_FILE = "/tmp/csharpierd-state.json";
const LOCK_FILE = "/tmp/csharpierd.lock";
const SERVER_PORT = 18912;
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
    const response = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(50),
    });
    return response.ok || response.status === 404; // Server is up if it responds at all
  } catch {
    return false;
  }
}

// Kill server process
async function killServer(pid: number): Promise<void> {
  try {
    await Bun.$`kill ${pid}`.quiet();
    // Wait a bit and force kill if needed
    await Bun.sleep(500);
    if (await isProcessRunning(pid)) {
      await Bun.$`kill -9 ${pid}`.quiet();
    }
  } catch {
    // Ignore errors
  }
}

// Start CSharpier server
async function startServer(): Promise<number> {
  console.error("Starting CSharpier server...");

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

      // Verify server is still running and responsive
      if (
        (await isProcessRunning(state.pid)) &&
        (await isServerResponsive(state.port))
      ) {
        return state;
      } else {
        console.error(
          "Server process not found or not responsive, restarting...",
        );
        if (await isProcessRunning(state.pid)) {
          await killServer(state.pid);
        }
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

  try {
    const response = await fetch(`http://localhost:${state.port}/format`, {
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
      throw new Error(
        `Server returned ${response.status}: ${await response.text()}`,
      );
    }

    const result = (await response.json()) as FormatResult;

    // Update last access time
    state.lastAccess = Date.now();
    await saveState(state);

    if (!result.formattedFile) {
      throw new Error(result.errorMessage);
    }

    return result.formattedFile;
  } catch (error) {
    console.error("Error formatting code:", error);
    throw error;
  }
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
  console.error("Fatal error:", error);
  process.exit(1);
});

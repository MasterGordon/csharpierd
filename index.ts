#!/usr/bin/env bun

const STATE_FILE = "/tmp/csharpierd-state.json";
const LOCK_FILE = "/tmp/csharpierd.lock";
const SERVER_PORT = 18912;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

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
      signal: AbortSignal.timeout(2000),
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
      stdout: "inherit",
      stderr: "inherit",
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

  try {
    const response = await fetch(`http://localhost:${state.port}/format`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: `/tmp/${fileName}`,
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

// Main
async function main() {
  const fileName = process.argv[2];
  if (!fileName) {
    console.error("Usage: bun index.ts <filename> < input.cs");
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

# csharpierd

A persistent CSharpier formatting daemon with automatic server management and idle timeout.

## Features

- Starts CSharpier server in background on first use
- Reuses existing server for subsequent formatting requests
- Automatically shuts down after 1 hour of inactivity
- Thread-safe with file locking mechanism
- Auto-recovery if server crashes

## Requirements

- [Bun](https://bun.sh) runtime (>= 1.0.0)
- [CSharpier](https://csharpier.com/) installed globally or locally

## Installation

### Global Installation

```bash
# Bun
bun install -g csharpierd

# npm
npm install -g csharpierd

# Yarn
yarn global add csharpierd

# pnpm
pnpm install -g csharpierd
```

### Local Development

```bash
bun install
```

## Usage

### Command Line Options

```bash
csharpierd <filename> < input.cs    # Format C# code from stdin
csharpierd --status                 # Show server status
csharpierd --stop                   # Stop the background server
csharpierd --help                   # Show help message
```

### As Global Command

After global installation:

```bash
# Format a C# file
csharpierd Program.cs < Program.cs

# Or using cat
cat MyFile.cs | csharpierd MyFile.cs

# Output formatted code to a new file
csharpierd MyFile.cs < MyFile.cs > MyFile.formatted.cs

# Check server status
csharpierd --status

# Stop the background server
csharpierd --stop

# Show help
csharpierd --help
```

### Local Development

```bash
# Format a file
bun index.ts Program.cs < Program.cs

# Check server status
bun index.ts --status

# Stop the server
bun index.ts --stop

# Show help
bun index.ts --help
```

### Server Management

#### Check Server Status

The `--status` flag shows detailed information about the server including:

- Running state (RUNNING, STARTING, STOPPED, or NOT RUNNING)
- Process ID and port
- Last access time
- Idle time with color-coded warnings (green < 75% timeout, yellow >= 75%, red >= 100%)
- Configuration details

```bash
csharpierd --status
```

#### Stopping the Server

The server will automatically shut down after 1 hour of inactivity, but you can manually stop it:

```bash
csharpierd --stop
```

## Building

You can compile the TypeScript code to a standalone binary:

```bash
bun run build
```

This creates a `csharpierd` binary in the current directory that can be distributed without requiring Bun to be installed. The binary is self-contained and includes all dependencies.

```bash
# Run the compiled binary
./csharpierd Program.cs < Program.cs
```

## Editor Integration

### Neovim with conform.nvim

[conform.nvim](https://github.com/stevearc/conform.nvim) is a popular formatter plugin for Neovim. Here's how to configure it to use `csharpierd`:

#### Basic Configuration

```lua
require("conform").setup({
  formatters_by_ft = {
    cs = { "csharpierd" },
  },
  formatters = {
    csharpierd = {
      command = "csharpierd",
      args = { "$FILENAME" },
      stdin = true,
    },
  },
})
```

#### With Lazy.nvim

```lua
{
  "stevearc/conform.nvim",
  event = { "BufWritePre" },
  cmd = { "ConformInfo" },
  opts = {
    formatters_by_ft = {
      cs = { "csharpierd" },
    },
    formatters = {
      csharpierd = {
        command = "csharpierd",
        args = { "$FILENAME" },
        stdin = true,
      },
    },
    format_on_save = {
      timeout_ms = 5000,
      lsp_fallback = true,
    },
  },
}
```

### Benefits of using csharpierd with conform.nvim

- **Fast formatting**: Reuses the CSharpier server process, avoiding startup overhead
- **Automatic server management**: Server starts on first use and stops after 1 hour of inactivity

## How It Works

1. **First Call**: Starts `dotnet csharpier server --server-port 78912` in the background
2. **Subsequent Calls**: Reuses the existing server process
3. **Idle Timeout**: Server automatically shuts down after 1 hour of inactivity
4. **State Management**: Server state (PID, port, last access time) stored in `/tmp/csharpierd-state.json`
5. **Concurrency**: Lock file prevents race conditions when multiple instances run simultaneously

## Server Details

- **Port**: 78912 (hardcoded)
- **State File**: `/tmp/csharpierd-state.json`
- **Lock File**: `/tmp/csharpierd.lock`
- **Idle Timeout**: 1 hour (3600000ms)

## Publishing

To publish this package to npm:

```bash
bun publish
```

## License

MIT

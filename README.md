# claude-llama

Run **Claude Code CLI** with **local llama.cpp models** — zero API costs, full privacy.

```
Claude Code CLI ──→ llama-shim (proxy) ──→ llama.cpp ──→ Your Local Model
   Anthropic API        translates           OpenAI API      (GGUF)
```

## Features

- **Full Anthropic ↔ OpenAI translation** — streaming SSE, tool calls, everything
- **Tool support** — Write, Read, Edit, Bash work through Claude Code's permission system
- **Smart auto-save** — detects code in text output and creates file-write tool calls
- **`<think>` tag stripping** — handles Qwen3/DeepSeek reasoning models cleanly
- **Tool loop detection** — prevents small models from getting stuck in infinite loops
- **ToolSearch interception** — automatically discovers the right tools for file operations
- **Zero dependencies** — pure Node.js, no npm install needed

## Quick Start

### 1. Install llama.cpp

<details>
<summary><b>Windows</b></summary>

**Option A: Download prebuilt binary**
```powershell
# Download from https://github.com/ggml-org/llama.cpp/releases
# Extract to a folder (e.g., C:\llama-cpp)
# You need: llama-server.exe
```

**Option B: Build from source**
```powershell
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release
# Binary at: build\bin\Release\llama-server.exe
```

</details>

<details>
<summary><b>macOS</b></summary>

**Option A: Homebrew**
```bash
brew install llama.cpp
```

**Option B: Build from source**
```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release
# Binary at: build/bin/llama-server
```

</details>

<details>
<summary><b>Linux</b></summary>

**Build from source:**
```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build
cmake --build build --config Release
# Binary at: build/bin/llama-server

# Optional: install system-wide
sudo cp build/bin/llama-server /usr/local/bin/
```

**With CUDA (NVIDIA GPU):**
```bash
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release
```

**With ROCm (AMD GPU):**
```bash
cmake -B build -DGGML_HIP=ON
cmake --build build --config Release
```

</details>

### 2. Start llama.cpp with a model

You can either download a model first, or let llama.cpp pull it from Hugging Face:

**Option A: Auto-download from Hugging Face (easiest)**
```bash
# Windows
.\llama-server.exe -hf unsloth/Qwen3.5-0.8B-GGUF:Q8_0 --port 8081 -c 262144

# macOS / Linux
llama-server -hf unsloth/Qwen3.5-0.8B-GGUF:Q8_0 --port 8081 -c 262144
```

**Option B: Use a local GGUF file**
```bash
# Windows
.\llama-server.exe -m Qwen3.5-0.8B-Q8_0.gguf --port 8081 -c 262144

# macOS / Linux
llama-server -m Qwen3.5-0.8B-Q8_0.gguf --port 8081 -c 262144
```

> **Context size (`-c`):** Claude Code sends large prompts. Use at least `-c 65536`. For the best experience, use the model's maximum context (Qwen3.5 supports 262144).

### 3. Install Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 4. Clone and run the shim

```bash
git clone https://github.com/user/claude-llama.git
cd claude-llama
```

**Terminal 1 — Start the proxy:**
```bash
node llama-shim.js
```

**Terminal 2 — Run Claude Code:**

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
$env:ANTHROPIC_AUTH_TOKEN="llama"
$env:ANTHROPIC_API_KEY=""
$env:ANTHROPIC_BASE_URL="http://localhost:8082"
claude --model Qwen3.5-0.8B-Q8_0.gguf
```

</details>

<details>
<summary><b>macOS / Linux (Bash)</b></summary>

```bash
export ANTHROPIC_AUTH_TOKEN="llama"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_BASE_URL="http://localhost:8082"
claude --model Qwen3.5-0.8B-Q8_0.gguf
```

</details>

## How It Works

```
┌─────────────┐     Anthropic API      ┌──────────────┐     OpenAI API     ┌───────────┐
│  Claude Code │ ──── /v1/messages ───→ │  llama-shim  │ ── /v1/chat/comp → │ llama.cpp │
│     CLI      │ ←── SSE stream ─────  │   (proxy)    │ ←── SSE stream ──  │  server   │
└─────────────┘                        └──────────────┘                    └───────────┘
```

The shim translates between:
- **Anthropic Messages API** (what Claude Code speaks)
- **OpenAI Chat Completions API** (what llama.cpp speaks)

Including: streaming events, tool/function calls, tool results, stop reasons, and usage stats.

### Smart Features

| Feature | What it does |
|---------|-------------|
| **Auto ToolSearch init** | Synthesizes a ToolSearch call on first request to load all deferred tools (no LLM call) |
| **ToolSearch interception** | Overrides model's ToolSearch query to discover Write/Read/Edit/Bash/WebSearch/WebFetch |
| **Smart tool selection** | Only shows WebSearch/WebFetch when user asks for web stuff — fewer tools = better decisions |
| **Path correction** | Buffers Write/Edit/Bash calls and auto-fixes wrong file paths to the working directory |
| **Nudge system** | After 4+ non-Write tools, injects "STOP exploring, use Write NOW" to prevent loops |
| **Auto-save** | When model outputs code as text, auto-creates a Write tool call so Claude CLI prompts to save |
| **`<think>` stripping** | Removes Qwen3/DeepSeek `<think>...</think>` reasoning blocks, shows only the answer |
| **Loop breaker** | Forces text summary after successful Write; hard stop at 15 consecutive tools |
| **Schema simplification** | Strips verbose tool schemas to minimal params so small models don't choke |
| **MCP filter** | Removes MCP server tools (HuggingFace etc.) that small models misuse |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LLAMA_CPP_URL` | `http://localhost:8081` | llama.cpp server URL |
| `SHIM_PORT` | `8082` | Proxy port |
| `MODEL_NAME` | `Qwen3.5-0.8B-Q8_0.gguf` | Model name reported to Claude Code |

```bash
# Example: custom llama server on another machine
LLAMA_CPP_URL=http://192.168.1.100:8080 SHIM_PORT=9000 node llama-shim.js
```

## Recommended Models

### Qwen3.5 Family (Recommended)

The **Qwen3.5** series is the recommended model family — multimodal, strong tool-calling, and available from tiny to large:

| Model | Size (Q8_0) | Good for | Context | Command |
|-------|-------------|----------|---------|---------|
| Qwen3.5-0.8B | ~0.9 GB | Quick tasks, simple code, low RAM | 262K | `-hf unsloth/Qwen3.5-0.8B-GGUF:Q8_0` |
| Qwen3.5-2B | ~2.3 GB | Light coding, faster responses | 262K | `-hf unsloth/Qwen3.5-2B-GGUF:Q8_0` |
| Qwen3.5-4B | ~4.5 GB | Balanced speed/quality | 262K | `-hf unsloth/Qwen3.5-4B-GGUF:Q8_0` |
| Qwen3.5-9B | ~9.5 GB | Best quality, reliable tool use | 262K | `-hf unsloth/Qwen3.5-9B-GGUF:Q8_0` |

### Other Compatible Models

| Model | Size (Q8_0) | Good for | Context | Command |
|-------|-------------|----------|---------|---------|
| Qwen2.5-Coder-7B | ~7.7 GB | Code-focused tasks | 128K | `-hf unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q8_0` |
| DeepSeek-R1-8B | ~8.5 GB | Complex reasoning | 128K | `-hf unsloth/DeepSeek-R1-Distill-Qwen-8B-GGUF:Q8_0` |

> **Note:** Larger models (4B+) handle tool calling much more reliably. The 0.8B model works but needs the shim's guardrails (auto-save, loop detection, nudge system, path correction). For the best experience, use **Qwen3.5-9B** or higher.

## Quantization Guide

Smaller quantizations = less RAM, faster, slightly lower quality:

| Quantization | Size (7B model) | Quality | Speed |
|-------------|-----------------|---------|-------|
| Q8_0 | ~8 GB | Best | Slower |
| Q6_K | ~6.5 GB | Very good | Medium |
| Q5_K_M | ~5.5 GB | Good | Medium |
| Q4_K_M | ~4.5 GB | Decent | Fast |
| Q3_K_M | ~3.5 GB | Acceptable | Fastest |

```bash
# Example: use Q4 quantization for less RAM
llama-server -hf unsloth/Qwen3-8B-GGUF:Q4_K_M --port 8081 -c 65536
```

## Troubleshooting

### llama.cpp crashes or "context length exceeded"

Your context size (`-c`) is too small. Claude Code sends large system prompts.

```bash
# Minimum recommended
llama-server -m model.gguf --port 8081 -c 65536

# Maximum (if you have enough RAM)
llama-server -m model.gguf --port 8081 -c 262144
```

**RAM needed for context** (approximate):
- `-c 65536` → ~2 GB extra RAM
- `-c 131072` → ~4 GB extra RAM
- `-c 262144` → ~8 GB extra RAM

### "Connection Refused" or "ECONNRESET"

1. Make sure llama.cpp is running: `curl http://localhost:8081/v1/models`
2. If it crashed, restart it — small models can OOM with large contexts
3. Check if the port matches (`--port 8081` and `LLAMA_CPP_URL`)

### Empty responses from Claude Code

- The shim handles `<think>` tags. If the model ONLY outputs thinking with no answer, the thinking content is forwarded as text.
- Check the shim logs — it shows exactly what content was generated.

### Model loops calling the same tool

The shim auto-detects loops and forces a text response. If it keeps happening, your model may be too small for tool-calling tasks. Try a 4B+ model.

### Slow generation

- Use a smaller quantization: `Q4_K_M` instead of `Q8_0`
- Use a smaller model: 0.8B or 4B instead of 8B
- Enable GPU offloading: `llama-server -m model.gguf --port 8081 -c 65536 -ngl 99`
- The `-ngl 99` flag offloads all layers to GPU (CUDA/Metal/ROCm)

## Project Structure

```
claude-llama/
├── llama-shim.js    # The proxy (this is the only file you need)
├── package.json
└── README.md
```

## How Tool Calling Works

```
1. First request → shim auto-synthesizes ToolSearch (no LLM call, instant)
2. Claude CLI discovers Write, Read, Edit, Bash, WebSearch, WebFetch tools
3. Model calls Write(file_path, content) → shim fixes path → Claude CLI shows permission prompt
4. User accepts → file is saved
5. Shim detects successful Write → forces text summary (prevents loop)
```

If the model outputs code as plain text instead of using Write:
```
1. Model generates HTML/JS/Python as text
2. Shim detects code in output (HTML tags, ``` blocks)
3. Shim auto-creates a Write tool call with detected filename
4. Claude CLI shows the file save permission prompt
```

## License

MIT

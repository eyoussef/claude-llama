#!/usr/bin/env node
/**
 * LLAMA SHIM v5.0 - Full Tool Support + Smart Auto-Save
 */

const http = require('http');
const path = require('path');

const CONFIG = {
    LLAMA_URL: process.env.LLAMA_CPP_URL || 'http://localhost:8081',
    SHIM_PORT: parseInt(process.env.SHIM_PORT || '8082'),
    MODEL: process.env.MODEL_NAME || 'Qwen3.5-0.8B-Q8_0.gguf'
};

const C = {
    cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m',
    yellow: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m',
    dim: '\x1b[2m'
};
const log = (m, c='reset') => console.log(`${C[c]}${m}${C.reset}`);

function generateId(prefix = 'msg') {
    return `${prefix}_${Date.now()}${Math.random().toString(36).substring(2, 10)}`;
}

// --- Smart Code Detection ---

const EXT_MAP = {
    html: '.html', htm: '.html', javascript: '.js', js: '.js', jsx: '.jsx',
    typescript: '.ts', ts: '.ts', tsx: '.tsx', python: '.py', py: '.py',
    css: '.css', scss: '.scss', json: '.json', yaml: '.yaml', yml: '.yml',
    markdown: '.md', md: '.md', sql: '.sql', sh: '.sh', bash: '.sh',
    shell: '.sh', powershell: '.ps1', xml: '.xml', svg: '.svg',
    java: '.java', cpp: '.cpp', c: '.c', cs: '.cs', go: '.go',
    rust: '.rs', rs: '.rs', ruby: '.rb', rb: '.rb', php: '.php',
    swift: '.swift', kotlin: '.kt', toml: '.toml', ini: '.ini',
    dockerfile: 'Dockerfile', docker: 'Dockerfile', makefile: 'Makefile'
};

function extractFilenamesFromText(text) {
    const names = [];
    // Match patterns like: `filename.ext`, 'filename.ext', "filename.ext", filename.ext:
    const patterns = [
        /[`'"]([\w\-./]+\.\w{1,10})[`'"]/g,           // quoted filenames
        /(?:create|save|write|update|edit|modify|name[d]?)\s+(?:it\s+)?(?:as\s+)?[`'"]([\w\-./]+\.\w{1,10})[`'"]/gi,
        /(?:file|called|named)\s+[`'"]([\w\-./]+\.\w{1,10})[`'"]/gi,
        /(?:>|>>)\s+([\w\-./]+\.\w{1,10})/g,           // shell redirect
    ];
    for (const pat of patterns) {
        let m;
        while ((m = pat.exec(text)) !== null) {
            const name = m[1];
            if (name && !name.startsWith('.') && name.includes('.')) {
                names.push(name);
            }
        }
    }
    return [...new Set(names)];
}

function detectAllCodeBlocks(text) {
    const blocks = [];

    // 1. Fenced code blocks: ```lang\n...\n```
    const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
        if (m[2].trim().length > 100) {
            const lang = m[1].toLowerCase();
            blocks.push({ lang, code: m[2], start: m.index, end: m.index + m[0].length });
        }
    }

    // 2. Raw HTML (not inside a code block)
    if (blocks.length === 0 && (text.includes('<!DOCTYPE html>') || text.includes('<html'))) {
        const htmlMatch = text.match(/(<!DOCTYPE html>[\s\S]*<\/html>)/i) ||
                          text.match(/(<html[\s\S]*<\/html>)/i);
        if (htmlMatch && htmlMatch[1].length > 100) {
            blocks.push({ lang: 'html', code: htmlMatch[1], start: text.indexOf(htmlMatch[1]), end: 0 });
        }
    }

    return blocks;
}

function guessFilename(lang, code, surroundingText, existingNames) {
    // Check surrounding text for filename hints
    const names = extractFilenamesFromText(surroundingText);
    const ext = EXT_MAP[lang] || `.${lang || 'txt'}`;

    // Find a name matching the extension
    for (const name of names) {
        if (name.endsWith(ext) || (lang === 'html' && name.endsWith('.html'))) {
            return name;
        }
    }
    // If any filename was mentioned, use the first one
    if (names.length > 0) return names[0];

    // Auto-generate based on content
    if (lang === 'html' || code.includes('<!DOCTYPE html>')) {
        if (code.includes('<title>')) {
            const titleMatch = code.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) {
                const slug = titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30).replace(/-$/, '');
                if (slug.length > 2) return `${slug}.html`;
            }
        }
        return 'index.html';
    }

    // Use existing names to avoid collision
    let base = `output${ext}`;
    let i = 1;
    while (existingNames.includes(base)) {
        base = `output${i}${ext}`;
        i++;
    }
    return base;
}

function detectCodeForAutoSave(fullText, conversationContext) {
    const blocks = detectAllCodeBlocks(fullText);
    if (blocks.length === 0) return [];

    const results = [];
    const usedNames = [];

    for (const block of blocks) {
        // Get surrounding text for filename hints (200 chars before the block)
        const before = fullText.substring(Math.max(0, block.start - 300), block.start);
        const after = fullText.substring(block.end, Math.min(fullText.length, block.end + 200));
        const surrounding = before + after + (conversationContext || '');

        const filename = guessFilename(block.lang, block.code, surrounding, usedNames);
        usedNames.push(filename);
        results.push({ filename, code: block.code, lang: block.lang });
    }

    return results;
}

// --- Request Translation ---

function translateRequest(body) {
    const messages = [];

    // Build single system message (Qwen3.5 requires system at the beginning only)
    let systemText = '';
    if (body.system) {
        systemText = typeof body.system === 'string'
            ? body.system
            : body.system.filter(s => s.type === 'text').map(s => s.text).join(' ');
    }
    // Extract working directory from system prompt FIRST
    let workDir = '';
    if (systemText.includes('working directory:')) {
        const wdMatch = systemText.match(/working directory:\s*(\S+)/);
        if (wdMatch) workDir = wdMatch[1];
    }
    const wd = workDir ? workDir.replace(/\\/g, '/') : 'C:/Users/pc/Desktop';

    systemText += `\n\nWORKING DIRECTORY: ${wd}\nThis directory already exists. Do NOT run mkdir.\n\n` +
        'RULES:\n' +
        '1. For QUESTIONS (what, how, why, etc.): answer with text. Do NOT create files for questions.\n' +
        `2. For CREATE/BUILD requests: use Write tool. file_path="${wd}/FILENAME". content=the full file.\n` +
        '3. Do NOT run ls, pwd, mkdir before creating files. The directory exists.\n' +
        '4. Do NOT use Bash to create files. Use the Write tool.\n' +
        '5. NEVER output large code as text. Use Write tool for code files.\n' +
        '6. Edit tool: file_path, old_string, new_string.\n' +
        '7. Keep responses SHORT. Act first, explain after.';
    messages.push({ role: 'system', content: systemText.trim() });

    for (const msg of body.messages || []) {
        if (Array.isArray(msg.content)) {
            const textParts = msg.content.filter(c => c.type === 'text');
            const toolUseParts = msg.content.filter(c => c.type === 'tool_use');
            const toolResults = msg.content.filter(c => c.type === 'tool_result');
            const text = textParts.map(c => c.text).join(' ');

            if (msg.role === 'assistant' && toolUseParts.length > 0) {
                messages.push({
                    role: 'assistant',
                    content: text || null,
                    tool_calls: toolUseParts.map(tu => ({
                        id: tu.id,
                        type: 'function',
                        function: {
                            name: tu.name,
                            arguments: JSON.stringify(tu.input || {})
                        }
                    }))
                });
            } else if (text) {
                messages.push({ role: msg.role, content: text });
            }

            for (const tr of toolResults) {
                let rc = '';
                if (typeof tr.content === 'string') rc = tr.content;
                else if (Array.isArray(tr.content)) rc = tr.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
                messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: rc || '' });
            }
        } else if (msg.content) {
            messages.push({ role: msg.role, content: msg.content });
        }
    }

    const req = {
        model: body.model || CONFIG.MODEL,
        messages,
        max_tokens: body.max_tokens || 4096,
        temperature: body.temperature ?? 0.7,
        stream: body.stream ?? true,
        top_p: body.top_p,
        stop: body.stop_sequences,
        _workDir: workDir
    };

    // Detect tool call loops, errors, and duplicate writes
    let consecutiveToolCalls = 0;
    const recentToolNames = [];
    const writtenFiles = new Set();
    let lastToolFailed = false;
    for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        const content = Array.isArray(m.content) ? m.content : [];
        const hasToolUse = content.some(c => c.type === 'tool_use');
        const hasToolResult = content.some(c => c.type === 'tool_result');
        if (hasToolUse || hasToolResult) {
            consecutiveToolCalls++;
            if (hasToolUse) {
                for (const c of content.filter(c => c.type === 'tool_use')) {
                    recentToolNames.push(c.name);
                    if (c.name === 'Write' && c.input?.file_path) {
                        writtenFiles.add(c.input.file_path);
                    }
                }
            }
        } else {
            break;
        }
    }

    // Only check the LAST message for errors (not the whole history — avoids false positives from ToolSearch results)
    const lastMsg = body.messages[body.messages.length - 1];
    const lastContent = Array.isArray(lastMsg?.content) ? lastMsg.content : [];
    for (const c of lastContent.filter(c => c.type === 'tool_result')) {
        // Skip ToolSearch results — they contain tool descriptions with words like "error"
        if (c.tool_use_id && recentToolNames.includes('ToolSearch')) {
            const toolUseMsg = body.messages.find(m =>
                Array.isArray(m.content) && m.content.some(p => p.type === 'tool_use' && p.id === c.tool_use_id && p.name === 'ToolSearch'));
            if (toolUseMsg) continue;
        }
        if (c.is_error) {
            lastToolFailed = true;
            break;
        }
        const resultText = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '';
        // Only match clear error patterns, not words in descriptions
        if (/^error:|ENOENT|EACCES|EPERM|Invalid tool|not a valid|cannot find/i.test(resultText.trim())) {
            lastToolFailed = true;
            break;
        }
    }

    const toolSearchUsed = recentToolNames.includes('ToolSearch');
    const writeCount = recentToolNames.filter(n => n === 'Write').length;
    const lastToolName = recentToolNames[0];

    // Detect user intent from last user message
    const userMsgsAll = (body.messages || []).filter(m => m.role === 'user');
    const lastUserContent = userMsgsAll.length > 0 ? (typeof userMsgsAll[userMsgsAll.length - 1].content === 'string'
        ? userMsgsAll[userMsgsAll.length - 1].content
        : Array.isArray(userMsgsAll[userMsgsAll.length - 1].content)
            ? userMsgsAll[userMsgsAll.length - 1].content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '') : '';
    const wantsCreate = /\b(create|make|build|generate|write|add|implement|develop|setup|init)\b/i.test(lastUserContent);
    const isQuestion = /^(what|how|why|when|where|who|which|is|are|can|do|does|tell|show|explain|find|get|check)\b/i.test(lastUserContent.trim());

    // NUDGE: Only push Write when user asked to CREATE something
    if (consecutiveToolCalls >= 4 && writeCount === 0 && !lastToolFailed && wantsCreate && !isQuestion) {
        log(`  Nudging model to use Write (${consecutiveToolCalls} tools, 0 writes)`, 'yellow');
        messages.push({ role: 'user', content:
            `[SYSTEM: STOP exploring. You have all the information you need. ` +
            `Use the Write tool NOW to create the file. file_path="${wd}/FILENAME", content=the full file content.]`
        });
    }
    // For questions: nudge to just respond with text
    if (consecutiveToolCalls >= 4 && writeCount === 0 && isQuestion && !wantsCreate) {
        log(`  Nudging model to answer with text (question detected)`, 'yellow');
        messages.push({ role: 'user', content:
            '[SYSTEM: You have enough information now. Answer the question with text. Do NOT create any files.]'
        });
    }

    // Count consecutive Write failures
    const failedWriteCount = recentToolNames.filter(n => n === 'Write').length;
    const bashWriteCount = recentToolNames.filter(n => n === 'Bash').length;

    // PATH FIX hint for first Write/Edit failure only
    if (lastToolFailed && (lastToolName === 'Write' || lastToolName === 'Edit') && failedWriteCount <= 1) {
        log(`  Last ${lastToolName} failed — injecting path hint`, 'yellow');
        messages.push({ role: 'user', content:
            `[SYSTEM: ${lastToolName} failed. Use exact path: "${wd}/FILENAME". Try again.]`
        });
    }

    // After 2+ failed Writes: stop retrying, use Bash as fallback
    if (lastToolFailed && failedWriteCount >= 2) {
        log(`  Write failed ${failedWriteCount} times — switching to Bash fallback`, 'red');
        messages.push({ role: 'user', content:
            `[SYSTEM: Write tool keeps failing. Use Bash instead: cat > "${wd}/FILENAME" << 'ENDOFFILE'\n...content...\nENDOFFILE\nThen summarize what you created.]`
        });
    }

    // FORCE TEXT only after successful Write (not after exploration with 0 writes)
    const successfulWrites = writeCount > 0 && !lastToolFailed;
    if (successfulWrites) {
        log(`  Forcing text response (${writeCount} successful writes)`, 'yellow');
        const fileList = [...writtenFiles].map(f => path.basename(f)).join(', ');
        messages.push({ role: 'user', content:
            `[SYSTEM: Files saved: ${fileList || 'done'}. Summarize briefly. Do NOT call more tools.]`
        });
        return req;
    }

    // HARD STOP at 15 consecutive tools with no writes — model is stuck
    if (consecutiveToolCalls >= 15) {
        log(`  Hard stop: ${consecutiveToolCalls} tools with no writes — forcing text`, 'red');
        messages.push({ role: 'user', content:
            '[SYSTEM: Too many tool calls without creating a file. Respond with text only and explain what happened.]'
        });
        return req;
    }

    if (body.tools && body.tools.length > 0) {
        // Smart tool selection: only include web tools when user asks for web stuff
        const userMsgs = (body.messages || []).filter(m => m.role === 'user');
        const lastUserText = userMsgs.reduce((txt, m) => {
            const c = typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '';
            return txt + ' ' + c;
        }, '');
        const wantsWeb = /\b(search|web|fetch|url|https?:|find online|look up|google|browse|internet|research|price|weather|news|today|latest|current|stock|crypto|bitcoin)\b/i.test(lastUserText);

        const CORE_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'ToolSearch'];
        if (wantsWeb) {
            CORE_TOOLS.push('WebSearch', 'WebFetch');
            log(`  Web tools enabled (user requested web)`, 'cyan');
        }
        const SIMPLE_SCHEMAS = {
            Write: { type: 'object', required: ['file_path', 'content'], properties: {
                file_path: { type: 'string', description: 'Absolute path to file' },
                content: { type: 'string', description: 'File content to write' }
            }},
            Read: { type: 'object', required: ['file_path'], properties: {
                file_path: { type: 'string', description: 'Absolute path to file' }
            }},
            Edit: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: {
                file_path: { type: 'string', description: 'Absolute path to file' },
                old_string: { type: 'string', description: 'Text to find and replace' },
                new_string: { type: 'string', description: 'Replacement text' }
            }},
            Bash: { type: 'object', required: ['command'], properties: {
                command: { type: 'string', description: 'Shell command to run' }
            }},
            WebSearch: { type: 'object', required: ['query'], additionalProperties: false, properties: {
                query: { type: 'string', description: 'Search query' }
            }},
            WebFetch: { type: 'object', required: ['url', 'prompt'], additionalProperties: false, properties: {
                url: { type: 'string', description: 'URL to fetch' },
                prompt: { type: 'string', description: 'What to extract from the page' }
            }},
        };

        req.tools = body.tools
            .filter(t => {
                if (t.name === 'ToolSearch' && toolSearchUsed) return false;
                if (t.name.startsWith('mcp__')) return false;
                if (!CORE_TOOLS.includes(t.name)) return false;
                return true;
            })
            .map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description ? t.description.substring(0, 150) : '',
                    parameters: SIMPLE_SCHEMAS[t.name] || t.input_schema || { type: 'object', properties: {} }
                }
            }));
        if (req.tools.length > 0) {
            log(`  Tools: ${req.tools.length} (${req.tools.map(t => t.function.name).join(', ')})`, 'cyan');
        }
    }

    return req;
}

// --- SSE Parser ---

class SSEParser {
    constructor() { this.buffer = ''; }

    feed(chunk) {
        this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const events = [];
        while (true) {
            const idx = this.buffer.indexOf('\n\n');
            if (idx === -1) break;
            const eventText = this.buffer.substring(0, idx).trim();
            this.buffer = this.buffer.substring(idx + 2);
            if (eventText) {
                for (const line of eventText.split('\n')) {
                    if (line.startsWith('data: ')) events.push(line.slice(6).trim());
                    else if (line.startsWith('data:')) events.push(line.slice(5).trim());
                }
            }
        }
        return events;
    }

    flush() {
        const events = [];
        if (this.buffer.trim()) {
            for (const line of this.buffer.trim().split('\n')) {
                if (line.startsWith('data: ')) events.push(line.slice(6).trim());
                else if (line.startsWith('data:')) events.push(line.slice(5).trim());
            }
        }
        this.buffer = '';
        return events;
    }
}

// --- Streaming Handler ---

function handleStreaming(openaiReq, anthropicReq, res) {
    const data = JSON.stringify(openaiReq);
    const messageId = generateId('msg');
    const model = anthropicReq.model || CONFIG.MODEL;
    const startTime = Date.now();
    const workDir = openaiReq._workDir || '';

    // Get user's last message for context
    const userMsgs = (anthropicReq.messages || []).filter(m => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const userContext = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : (Array.isArray(lastUserMsg?.content) ? lastUserMsg.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': messageId
    });

    function sse(eventType, obj) {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(obj)}\n\n`);
    }

    sse('message_start', {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }}
    });

    sse('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
    });

    let tokenCount = 0;
    let firstToken = true;
    const parser = new SSEParser();
    let ended = false;
    let fullText = '';
    let rawAccum = '';
    let thinkResolved = false;
    let textBlockClosed = false;
    let stopReason = 'end_turn';

    // Tool call tracking
    let toolCalls = {};
    let toolBlockIndices = {};
    let nextBlockIndex = 1;
    let hasToolCalls = false;

    function closeTextBlock() {
        if (!textBlockClosed) {
            textBlockClosed = true;
            if (!thinkResolved && rawAccum.trim()) {
                let fallback = rawAccum.replace(/<\/?think>/g, '').trim();
                if (fallback) {
                    fullText += fallback;
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fallback }
                    });
                }
            }
            sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
    }

    function emitAutoSaveToolCalls() {
        // Detect code in text output and auto-create Write tool calls
        const files = detectCodeForAutoSave(fullText, userContext);
        if (files.length === 0) return;

        for (const file of files) {
            const toolId = generateId('toolu');
            const blockIdx = nextBlockIndex++;

            // Resolve path relative to working directory
            let filePath = file.filename;
            if (workDir && !path.isAbsolute(filePath)) {
                filePath = path.join(workDir, filePath).replace(/\\/g, '/');
            }

            log(`  Auto-save: ${filePath} (${file.code.length} chars, ${file.lang})`, 'yellow');

            sse('content_block_start', {
                type: 'content_block_start', index: blockIdx,
                content_block: { type: 'tool_use', id: toolId, name: 'Write', input: {} }
            });

            const input = JSON.stringify({ file_path: filePath, content: file.code });
            // Send in chunks to avoid huge single events
            const CHUNK = 8000;
            for (let i = 0; i < input.length; i += CHUNK) {
                sse('content_block_delta', {
                    type: 'content_block_delta', index: blockIdx,
                    delta: { type: 'input_json_delta', partial_json: input.substring(i, i + CHUNK) }
                });
            }

            sse('content_block_stop', { type: 'content_block_stop', index: blockIdx });
        }

        hasToolCalls = true;
        stopReason = 'tool_use';
    }

    function sendStop() {
        if (ended) return;
        ended = true;

        // Flush buffered think content
        if (!textBlockClosed && !fullText.trim() && rawAccum.trim()) {
            let fallback = rawAccum.replace(/<\/?think>/g, '').trim();
            if (fallback) {
                sse('content_block_delta', {
                    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fallback }
                });
                fullText = fallback;
            }
        }

        closeTextBlock();

        // Auto-save code blocks if model didn't use tools
        if (!hasToolCalls && fullText.length > 200) {
            emitAutoSaveToolCalls();
        }

        // Flush any tool calls still in buffer (short calls that never hit the streaming threshold)
        const wdNorm = workDir ? workDir.replace(/\\/g, '/') : '';
        for (const idx in toolCalls) {
            if (toolCalls[idx]._buffered && !toolCalls[idx]._flushed && toolCalls[idx].arguments) {
                let args = toolCalls[idx].arguments;
                try {
                    const parsed = JSON.parse(args);
                    if (parsed.file_path && wdNorm) {
                        const fp = parsed.file_path.replace(/\\/g, '/');
                        if (!fp.startsWith(wdNorm)) {
                            const filename = path.basename(fp);
                            parsed.file_path = wdNorm + '/' + filename;
                            log(`  Path fix: ${fp} → ${parsed.file_path}`, 'yellow');
                            args = JSON.stringify(parsed);
                        }
                    }
                    if (parsed.command && wdNorm && toolCalls[idx].name === 'Bash') {
                        const wdParts = wdNorm.split('/');
                        const wdTail = wdParts.slice(-2).join('/');
                        const tailEscaped = wdTail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const tailRe = new RegExp('[/\\\\a-zA-Z:]*[/\\\\]' + tailEscaped, 'g');
                        const fixed = args.replace(tailRe, wdNorm);
                        if (fixed !== args) {
                            log(`  Bash path fix applied`, 'yellow');
                            args = fixed;
                        }
                    }
                } catch (e) { /* partial JSON, send as-is */ }
                const CHUNK = 8000;
                for (let i = 0; i < args.length; i += CHUNK) {
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: toolBlockIndices[idx],
                        delta: { type: 'input_json_delta', partial_json: args.substring(i, i + CHUNK) }
                    });
                }
            }
        }

        // Close model's tool call blocks
        for (const idx in toolCalls) {
            if (toolBlockIndices[idx] !== undefined) {
                sse('content_block_stop', { type: 'content_block_stop', index: toolBlockIndices[idx] });
            }
        }

        sse('message_delta', {
            type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: tokenCount }
        });
        sse('message_stop', { type: 'message_stop' });
        res.write('data: [DONE]\n\n');

        const duration = Date.now() - startTime;
        log(`Complete: ${tokenCount} tokens in ${duration}ms (${stopReason})`, 'green');
        if (fullText) log(`  Text: "${fullText.substring(0, 120)}${fullText.length > 120 ? '...' : ''}"`, 'dim');
        for (const idx in toolCalls) {
            const tc = toolCalls[idx];
            log(`  Tool: ${tc.name}(${tc.arguments.substring(0, 80)}${tc.arguments.length > 80 ? '...' : ''})`, 'cyan');
        }
        res.end();
    }

    function processContent(content) {
        if (!content) return;
        tokenCount++;

        if (thinkResolved) {
            fullText += content;
            sse('content_block_delta', {
                type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content }
            });
        } else {
            rawAccum += content;
            if (rawAccum.includes('</think>')) {
                thinkResolved = true;
                const remaining = rawAccum.substring(rawAccum.indexOf('</think>') + 8);
                log(`  Stripped <think> (${rawAccum.indexOf('</think>')} chars)`, 'yellow');
                if (remaining.trim()) {
                    fullText += remaining;
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: remaining }
                    });
                }
            } else if (!rawAccum.trimStart().startsWith('<') && rawAccum.length > 1) {
                thinkResolved = true;
                fullText += rawAccum;
                sse('content_block_delta', {
                    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: rawAccum }
                });
            }
        }
    }

    let toolSearchIntercepted = false;

    function processToolCalls(toolCallDeltas) {
        if (!toolCallDeltas) return;
        hasToolCalls = true;
        closeTextBlock();

        for (const tc of toolCallDeltas) {
            const idx = tc.index;
            if (tc.id) {
                let name = tc.function?.name || '';

                // Intercept ToolSearch: override with correct query to discover file tools
                if (name === 'ToolSearch' && !toolSearchIntercepted) {
                    toolSearchIntercepted = true;
                    log(`  Intercepting ToolSearch → forcing "select:Write,Read,Edit,Bash,Grep,Glob,WebSearch,WebFetch"`, 'yellow');
                    toolCalls[idx] = { id: tc.id, name, arguments: '' };
                    toolBlockIndices[idx] = nextBlockIndex++;
                    sse('content_block_start', {
                        type: 'content_block_start', index: toolBlockIndices[idx],
                        content_block: { type: 'tool_use', id: tc.id, name, input: {} }
                    });
                    const overrideArgs = '{"query":"select:Write,Read,Edit,Bash,Grep,Glob,WebSearch,WebFetch","max_results":5}';
                    toolCalls[idx].arguments = overrideArgs;
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: toolBlockIndices[idx],
                        delta: { type: 'input_json_delta', partial_json: overrideArgs }
                    });
                    // Skip any further argument chunks for this tool call
                    toolCalls[idx]._overridden = true;
                    return;
                }

                toolCalls[idx] = { id: tc.id, name, arguments: '' };
                toolBlockIndices[idx] = nextBlockIndex++;
                // Smart buffer: only buffer until file_path is captured, then stream the rest
                toolCalls[idx]._buffered = ['Write', 'Edit', 'Read', 'Bash'].includes(name);
                toolCalls[idx]._flushed = false;
                sse('content_block_start', {
                    type: 'content_block_start', index: toolBlockIndices[idx],
                    content_block: { type: 'tool_use', id: tc.id, name, input: {} }
                });
            }
            if (tc.function?.arguments && toolCalls[idx] && !toolCalls[idx]._overridden) {
                toolCalls[idx].arguments += tc.function.arguments;

                if (toolCalls[idx]._buffered && !toolCalls[idx]._flushed) {
                    // Still buffering — check if we've captured the file_path/command
                    const acc = toolCalls[idx].arguments;
                    const pathCaptured = acc.includes('"content"') || acc.includes('"old_string"') ||
                                         acc.includes('"command"') || acc.length > 500;
                    if (pathCaptured) {
                        // Fix the path in accumulated args and flush
                        let fixedAcc = acc;
                        const wdN = workDir ? workDir.replace(/\\/g, '/') : '';
                        try {
                            // Quick path fix in the accumulated portion
                            if (wdN) {
                                // Fix file_path
                                fixedAcc = fixedAcc.replace(/"file_path"\s*:\s*"([^"]+)"/, (match, fp) => {
                                    const fpNorm = fp.replace(/\\/g, '/');
                                    if (!fpNorm.startsWith(wdN)) {
                                        const filename = path.basename(fpNorm);
                                        const fixed = wdN + '/' + filename;
                                        log(`  Path fix: ${fpNorm} → ${fixed}`, 'yellow');
                                        return `"file_path":"${fixed}"`;
                                    }
                                    return match;
                                });
                                // Fix Bash command paths
                                if (toolCalls[idx].name === 'Bash') {
                                    const wdParts = wdN.split('/');
                                    const wdTail = wdParts.slice(-2).join('/');
                                    const tailEscaped = wdTail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    const tailRe = new RegExp('[/\\\\a-zA-Z:]*[/\\\\]' + tailEscaped, 'g');
                                    const before = fixedAcc;
                                    fixedAcc = fixedAcc.replace(tailRe, wdN);
                                    if (fixedAcc !== before) log(`  Bash path fix applied`, 'yellow');
                                }
                            }
                        } catch (e) { /* use original */ }
                        // Send the fixed accumulated portion
                        sse('content_block_delta', {
                            type: 'content_block_delta', index: toolBlockIndices[idx],
                            delta: { type: 'input_json_delta', partial_json: fixedAcc }
                        });
                        toolCalls[idx]._flushed = true;
                        toolCalls[idx]._buffered = false;
                        log(`  Buffer flushed → streaming mode (${acc.length} chars buffered)`, 'dim');
                    } else {
                        res.write(': keepalive\n\n');
                    }
                } else if (toolCalls[idx]._flushed) {
                    // Already flushed — stream directly
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: toolBlockIndices[idx],
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                    });
                } else {
                    // Not buffered at all — stream directly
                    sse('content_block_delta', {
                        type: 'content_block_delta', index: toolBlockIndices[idx],
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                    });
                }
            }
        }
    }

    function processEvent(event) {
        if (event === '[DONE]') { sendStop(); return true; }
        try {
            const parsed = JSON.parse(event);
            const choice = parsed.choices?.[0];
            if (!choice) return false;

            const content = choice.delta?.content || '';
            const finishReason = choice.finish_reason;
            const toolCallDeltas = choice.delta?.tool_calls;

            if (firstToken && (content || toolCallDeltas)) {
                log(`First token: ${Date.now() - startTime}ms`, 'yellow');
                firstToken = false;
            }

            if (content) processContent(content);
            if (toolCallDeltas) processToolCalls(toolCallDeltas);

            if (finishReason) {
                if (finishReason === 'tool_calls') stopReason = 'tool_use';
                else if (finishReason === 'length') stopReason = 'max_tokens';
                sendStop();
                return true;
            }
        } catch (e) {
            log(`Parse error: ${e.message.substring(0, 80)}`, 'red');
        }
        return false;
    }

    const llamaReq = http.request(`${CONFIG.LLAMA_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Accept': 'text/event-stream'
        },
        timeout: 600000
    }, (llamaRes) => {
        llamaRes.setEncoding('utf8');
        llamaRes.on('data', (chunk) => {
            for (const event of parser.feed(chunk)) { if (processEvent(event)) return; }
        });
        llamaRes.on('end', () => {
            for (const event of parser.flush()) { if (processEvent(event)) return; }
            sendStop();
        });
        llamaRes.on('error', (err) => {
            log(`Stream error: ${err.message}`, 'red');
            if (!ended) sendStop();
        });
    });

    llamaReq.on('error', (err) => {
        log(`Request error: ${err.message}`, 'red');
        if (!ended) { try { res.writeHead(500); } catch {} res.end(JSON.stringify({ error: err.message })); }
    });

    llamaReq.write(data);
    llamaReq.end();
}

// --- Non-Streaming Handler ---

async function handleNonStreaming(openaiReq, anthropicReq, res) {
    openaiReq.stream = false;
    const data = JSON.stringify(openaiReq);
    let responseData = '';

    return new Promise((resolve, reject) => {
        const llamaReq = http.request(`${CONFIG.LLAMA_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            timeout: 600000
        }, (llamaRes) => {
            llamaRes.on('data', chunk => responseData += chunk);
            llamaRes.on('end', () => {
                try {
                    let openaiResp;
                    if (responseData.trimStart().startsWith('data: ')) {
                        let content = '';
                        for (const line of responseData.replace(/\r\n/g, '\n').split('\n')) {
                            if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                                try {
                                    const evt = JSON.parse(line.slice(6));
                                    content += evt.choices?.[0]?.delta?.content || evt.choices?.[0]?.message?.content || '';
                                } catch {}
                            }
                        }
                        openaiResp = { choices: [{ message: { content } }], usage: {} };
                    } else {
                        openaiResp = JSON.parse(responseData);
                    }

                    const choice = openaiResp.choices?.[0];
                    const usage = openaiResp.usage || {};
                    const anthropicContent = [];
                    const text = choice?.message?.content || '';
                    if (text) anthropicContent.push({ type: 'text', text });

                    let sr = 'end_turn';
                    if (choice?.message?.tool_calls) {
                        sr = 'tool_use';
                        for (const tc of choice.message.tool_calls) {
                            anthropicContent.push({
                                type: 'tool_use',
                                id: tc.id || generateId('toolu'),
                                name: tc.function?.name || '',
                                input: JSON.parse(tc.function?.arguments || '{}')
                            });
                        }
                    }

                    if (anthropicContent.length === 0) {
                        anthropicContent.push({ type: 'text', text: '' });
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: generateId('msg'), type: 'message', role: 'assistant', model: anthropicReq.model || CONFIG.MODEL,
                        content: anthropicContent, stop_reason: sr,
                        usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 }
                    }));
                    resolve();
                } catch (e) { reject(e); }
            });
        });
        llamaReq.on('error', reject);
        llamaReq.write(data);
        llamaReq.end();
    });
}

// --- Auto ToolSearch Init ---

function needsToolSearchInit(messages) {
    // Check if ToolSearch has already been called in this conversation
    for (const msg of messages || []) {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const c of content) {
            if (c.type === 'tool_use' && c.name === 'ToolSearch') return false;
        }
    }
    return true;
}

function synthesizeToolSearchResponse(res, model) {
    const messageId = generateId('msg');
    const toolId = generateId('toolu');

    log('  Auto-init: synthesizing ToolSearch to load deferred tools (no LLM call)', 'yellow');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': messageId
    });

    function sse(eventType, obj) {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(obj)}\n\n`);
    }

    sse('message_start', {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', model: model || CONFIG.MODEL, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }}
    });

    // Text block
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Loading tools...' } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });

    // ToolSearch tool_use block
    sse('content_block_start', {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: toolId, name: 'ToolSearch', input: {} }
    });
    const args = '{"query":"select:Write,Read,Edit,Bash,Grep,Glob,WebSearch,WebFetch","max_results":8}';
    sse('content_block_delta', {
        type: 'content_block_delta', index: 1,
        delta: { type: 'input_json_delta', partial_json: args }
    });
    sse('content_block_stop', { type: 'content_block_stop', index: 1 });

    // Stop with tool_use reason
    sse('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 }
    });
    sse('message_stop', { type: 'message_stop' });
    res.write('data: [DONE]\n\n');
    res.end();

    log('  ToolSearch init sent — Claude Code will load tools and come back', 'green');
}

// --- Server ---

function startServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

            const urlPath = req.url.split('?')[0];

            if (urlPath === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', proxy: 'llama-shim', version: '5.0', streaming: true, tools: true, autosave: true }));
                return;
            }

            if (urlPath === '/v1/models' && req.method === 'GET') {
                try {
                    const llamaResp = await new Promise((resolve, reject) => {
                        http.get(`${CONFIG.LLAMA_URL}/v1/models`, (r) => {
                            let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
                        }).on('error', reject);
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(llamaResp);
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
                return;
            }

            if (urlPath === '/v1/messages' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const anthropicReq = JSON.parse(body);

                        // Auto-init: load deferred tools on first request (no LLM call needed)
                        if (needsToolSearchInit(anthropicReq.messages) && anthropicReq.stream !== false) {
                            log(`Request: ${anthropicReq.messages?.length} msgs (first request — auto-init ToolSearch)`);
                            synthesizeToolSearchResponse(res, anthropicReq.model);
                            return;
                        }

                        const openaiReq = translateRequest(anthropicReq);

                        const totalChars = anthropicReq.messages?.reduce((sum, m) => {
                            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                            return sum + c.length;
                        }, 0) || 0;

                        log(`Request: ${anthropicReq.messages?.length} msgs, ${totalChars} chars, max_tokens: ${openaiReq.max_tokens}`);

                        if (openaiReq.stream) handleStreaming(openaiReq, anthropicReq, res);
                        else await handleNonStreaming(openaiReq, anthropicReq, res);
                    } catch (err) {
                        log(`Error: ${err.message}`, 'red');
                        try { res.writeHead(500); } catch {}
                        res.end(JSON.stringify({ error: err.message }));
                    }
                });
                return;
            }

            const proxy = http.request({ hostname: 'localhost', port: 8081, path: req.url, method: req.method, headers: req.headers },
                (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });
            proxy.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Proxy error' })); });
            req.pipe(proxy);
        });

        server.listen(CONFIG.SHIM_PORT, () => {
            log('');
            log('╔═══════════════════════════════════════════════════════════════╗', 'green');
            log('║  LLAMA SHIM v5.0 - Full Tools + Smart Auto-Save             ║', 'green');
            log('╚═══════════════════════════════════════════════════════════════╝', 'green');
            log(`  Proxy:   http://localhost:${CONFIG.SHIM_PORT}`, 'cyan');
            log(`  Backend: ${CONFIG.LLAMA_URL}`, 'cyan');
            log(`  Model:   ${CONFIG.MODEL}`, 'cyan');
            log('');
            log('Features:', 'bold');
            log('  - Anthropic <-> OpenAI translation', 'dim');
            log('  - Tool call support (function calling)', 'dim');
            log('  - <think> tag stripping (Qwen3)', 'dim');
            log('  - Auto-save: code output -> Write tool calls', 'dim');
            log('  - Tool loop detection & breaker', 'dim');
            log('');
            log('In another terminal:', 'bold');
            log('  $env:ANTHROPIC_AUTH_TOKEN="llama"', 'cyan');
            log('  $env:ANTHROPIC_API_KEY=""', 'cyan');
            log('  $env:ANTHROPIC_BASE_URL="http://localhost:8082"', 'cyan');
            log(`  claude --model ${CONFIG.MODEL}`, 'cyan');
            log('');
            resolve(server);
        });

        server.on('error', reject);
    });
}

async function checkLlama() {
    return new Promise((resolve) => {
        http.get(`${CONFIG.LLAMA_URL}/v1/models`, { timeout: 5000 }, (res) => resolve(res.statusCode === 200)).on('error', () => resolve(false));
    });
}

async function main() {
    log('');
    log('Starting Llama Shim v5.0...', 'bold');
    log('');

    process.stdout.write('Checking llama.cpp... ');
    if (await checkLlama()) log('✓ Connected', 'green');
    else { log('✗ Not accessible', 'red'); process.exit(1); }

    await startServer();
}

main().catch(err => { log(`Error: ${err.message}`, 'red'); process.exit(1); });

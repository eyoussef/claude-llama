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
    systemText += '\n\nCRITICAL RULES:\n' +
        '1. FIRST STEP: Call ToolSearch with query "select:Write,Read,Edit,Bash,Grep,Glob" to load file tools.\n' +
        '2. NEVER paste large code as text. ALWAYS write code to files using the Write tool or Bash tool.\n' +
        '3. To create a file: use Write tool with file_path and content parameters.\n' +
        '4. To edit a file: use Edit tool with file_path, old_string, and new_string parameters.\n' +
        '5. To read a file: use Read tool with file_path parameter.\n' +
        '6. To run commands: use Bash tool with command parameter.\n' +
        '7. Do NOT use WebFetch unless user explicitly asks to fetch a URL.\n' +
        '8. Keep text responses SHORT. Explain briefly what you will do, then use tools.\n' +
        '9. When updating code: use Edit tool to change specific parts, or Write tool to rewrite the whole file.';
    messages.push({ role: 'system', content: systemText.trim() });

    // Extract working directory from system prompt for path resolution
    let workDir = '';
    if (systemText.includes('working directory:')) {
        const wdMatch = systemText.match(/working directory:\s*(\S+)/);
        if (wdMatch) workDir = wdMatch[1];
    }

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

    // Detect tool call loops and duplicate writes
    let consecutiveToolCalls = 0;
    const recentToolNames = [];
    const writtenFiles = new Set();
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
                    // Track files already written
                    if (c.name === 'Write' && c.input?.file_path) {
                        writtenFiles.add(c.input.file_path);
                    }
                }
            }
        } else {
            break;
        }
    }

    const toolSearchUsed = recentToolNames.includes('ToolSearch');

    // After a successful Write, force text summary (prevents duplicate write loop)
    const writeCount = recentToolNames.filter(n => n === 'Write').length;
    const forceTextResponse = writeCount >= 1 || consecutiveToolCalls >= 8;

    if (forceTextResponse) {
        log(`  Forcing text response (${writeCount} writes, ${consecutiveToolCalls} consecutive tools)`, 'yellow');
        // Strip all tools and tell model to summarize
        const fileList = [...writtenFiles].map(f => path.basename(f)).join(', ');
        messages.push({ role: 'user', content:
            `[SYSTEM: The files have been saved successfully (${fileList || 'done'}). ` +
            'Now provide a brief summary of what you created. Do NOT call any more tools. Just respond with text.]'
        });
        return req;
    }

    if (body.tools && body.tools.length > 0) {
        // Filter and simplify tools for small models
        const CORE_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'ToolSearch'];
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
        };

        req.tools = body.tools
            .filter(t => {
                if (t.name === 'ToolSearch' && toolSearchUsed) return false;
                if (t.name.startsWith('mcp__')) return false;
                // Only keep core tools to reduce schema size
                if (!CORE_TOOLS.includes(t.name)) return false;
                return true;
            })
            .map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description ? t.description.substring(0, 100) : '',
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
                    log(`  Intercepting ToolSearch → forcing "select:Write,Read,Edit,Bash,Grep,Glob"`, 'yellow');
                    toolCalls[idx] = { id: tc.id, name, arguments: '' };
                    toolBlockIndices[idx] = nextBlockIndex++;
                    sse('content_block_start', {
                        type: 'content_block_start', index: toolBlockIndices[idx],
                        content_block: { type: 'tool_use', id: tc.id, name, input: {} }
                    });
                    const overrideArgs = '{"query":"select:Write,Read,Edit,Bash,Grep,Glob","max_results":5}';
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
                sse('content_block_start', {
                    type: 'content_block_start', index: toolBlockIndices[idx],
                    content_block: { type: 'tool_use', id: tc.id, name, input: {} }
                });
            }
            if (tc.function?.arguments && toolCalls[idx] && !toolCalls[idx]._overridden) {
                toolCalls[idx].arguments += tc.function.arguments;
                sse('content_block_delta', {
                    type: 'content_block_delta', index: toolBlockIndices[idx],
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                });
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

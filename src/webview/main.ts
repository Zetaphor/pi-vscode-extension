import { marked } from 'marked';
import type { ClientMessage, ServerMessage, SerializedAgentState, FileChangeInfo } from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: ClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

// ── State ──

const state: {
    messages: any[];
    isStreaming: boolean;
    model?: { provider: string; id: string; name?: string };
    thinkingLevel?: string;
    tools: string[];
    sessionId?: string;
    sessionName?: string;
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    thinkingStartTime: number;
    streamingThinkingDuration: number;
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    fileChanges: FileChangeInfo[];
    rollbackPoint: number | null;
} = {
    messages: [],
    isStreaming: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    fileChanges: [],
    rollbackPoint: null,
};

// ── Marked config ──

const renderer = new marked.Renderer();

let codeBlockId = 0;
renderer.code = function ({ text, lang }: { text: string; lang?: string | undefined }) {
    const id = `cb-${++codeBlockId}`;
    const langLabel = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">${langLabel}<button class="copy-btn" data-code-id="${id}">Copy</button></div>
        <pre class="code-block-pre" id="${id}"><code class="code-block-code">${escHtml(text)}</code></pre>
    </div>`;
};

renderer.codespan = function ({ text }: { text: string }) {
    return `<code>${text}</code>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

function renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
}

// ── Message handling ──

window.addEventListener('message', (event) => {
    handleMessage(event.data as ServerMessage);
});

function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
        case 'ready':
            vscode.postMessage({ type: 'getState' });
            vscode.postMessage({ type: 'getModels' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            renderModelPicker(msg.models, msg.current, msg.thinkingLevel);
            break;
        case 'sessions':
            renderSessionList(msg.sessions, msg.currentSessionId);
            break;
        case 'fileChange':
            state.fileChanges.push(msg.change);
            renderChangedFilesBar();
            renderInlineFileChange(msg.change);
            break;
        case 'confirmResult':
            handleConfirmResult(msg.action, msg.confirmed, msg.payload);
            break;
        case 'error':
            showError(msg.message);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
        case 'undoAllFileChanges':
            vscode.postMessage({ type: 'undoAllFileChanges' });
            break;
        case 'restoreCheckpoint':
            if (payload?.messageIndex !== undefined) {
                vscode.postMessage({ type: 'restoreCheckpoint', messageIndex: payload.messageIndex });
            }
            break;
        case 'redoCheckpoint':
            vscode.postMessage({ type: 'redoCheckpoint' });
            break;
    }
}

function applyStateSync(s: SerializedAgentState): void {
    state.messages = s.messages ?? [];
    state.isStreaming = s.isStreaming;
    state.model = s.model;
    state.thinkingLevel = s.thinkingLevel;
    state.tools = s.tools ?? [];
    state.sessionId = s.sessionId;
    state.sessionName = s.sessionName;
    state.contextUsage = s.contextUsage;
    state.fileChanges = s.fileChanges ?? [];
    state.rollbackPoint = s.rollbackPoint ?? null;
    render();
}

function handleAgentEvent(event: any): void {
    switch (event.type) {
        case 'message_update':
            if (event.assistantMessageEvent) {
                handleStreamingDelta(event.assistantMessageEvent);
            }
            break;
        case 'agent_start':
            state.isStreaming = true;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            render();
            break;
        case 'agent_end':
            state.isStreaming = false;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            render();
            break;
        case 'tool_execution_start':
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            break;
    }
}

function handleStreamingDelta(ae: any): void {
    switch (ae.type) {
        case 'thinking_start':
            state.isThinking = true;
            state.streamingThinking = '';
            state.thinkingStartTime = Date.now();
            state.streamingThinkingDuration = 0;
            break;
        case 'thinking_delta':
            state.streamingThinking += ae.delta ?? '';
            break;
        case 'thinking_end':
            state.isThinking = false;
            if (state.thinkingStartTime > 0) {
                state.streamingThinkingDuration = Math.round((Date.now() - state.thinkingStartTime) / 1000);
            }
            break;
        case 'text_start':
            break;
        case 'text_delta':
            state.streamingText += ae.delta ?? '';
            break;
        case 'text_end':
            break;
    }
    renderStreamingContent();
}

// ── Rendering ──

function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';

    app.appendChild(buildHeader());
    app.appendChild(buildModelBar());

    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';

    if (state.messages.length === 0 && !state.isStreaming) {
        messagesContainer.appendChild(buildWelcome());
    } else {
        let userMsgCount = 0;
        const rollbackUserIdx = state.rollbackPoint;
        let dimming = false;

        let redoPlaced = false;

        for (let i = 0; i < state.messages.length; i++) {
            const msg = state.messages[i];
            const role = msg.role ?? 'unknown';

            if (role === 'user') {
                userMsgCount++;
                if (rollbackUserIdx !== null && userMsgCount > rollbackUserIdx) {
                    dimming = true;
                }
            }

            const msgEl = renderMessage(msg, i, role === 'user' ? userMsgCount : undefined);
            if (dimming) {
                msgEl.classList.add('dimmed');
            }

            messagesContainer.appendChild(msgEl);

            if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
                const redoWrap = el('div', 'redo-anchor');
                const redoBtn = el('button', 'redo-btn');
                redoBtn.title = 'Redo changes';
                redoBtn.textContent = 'Redo';
                redoWrap.appendChild(redoBtn);
                messagesContainer.appendChild(redoWrap);
                redoPlaced = true;
            }
        }
    }

    const streamingContainer = el('div', 'streaming-message');
    streamingContainer.id = 'streaming-message';
    messagesContainer.appendChild(streamingContainer);

    app.appendChild(messagesContainer);
    app.appendChild(buildInputContainer());

    bindEvents();
    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
    bindChangedFileItems();
    scrollToBottom();
}

function buildHeader(): HTMLElement {
    const header = el('div', 'header');
    const usageText = state.contextUsage?.percent != null
        ? `${Math.round(state.contextUsage.percent)}%`
        : '';

    header.innerHTML = `
        <div class="header-left">
            <span class="session-name">${escHtml(state.sessionName ?? 'New Chat')}</span>
            ${usageText ? `<span class="context-badge" title="Context window usage">${usageText}</span>` : ''}
        </div>
        <div class="header-right">
            <button class="icon-btn" id="btn-sessions" title="Sessions">&#9776;</button>
            <button class="icon-btn" id="btn-new-session" title="New Chat">+</button>
        </div>
    `;
    return header;
}

function buildModelBar(): HTMLElement {
    const bar = el('div', 'model-bar');
    bar.id = 'model-bar';
    return bar;
}

function buildInputContainer(): HTMLElement {
    const container = el('div', 'input-container');

    if (state.fileChanges.length > 0) {
        container.appendChild(buildChangedFilesSection());
    }

    const area = el('div', 'input-area');
    const placeholder = state.isStreaming
        ? 'Type to steer Pi, or press Esc to stop...'
        : 'Ask Pi anything...';

    area.innerHTML = `<textarea id="input" placeholder="${placeholder}" rows="1"></textarea>`;
    container.appendChild(area);

    const footer = el('div', 'input-footer');
    const modelName = state.model?.name ?? state.model?.id ?? '';

    let contextHtml = '';
    if (state.contextUsage) {
        const cu = state.contextUsage;
        const tokensK = cu.tokens != null ? formatTokenCount(cu.tokens) : null;
        const windowK = formatTokenCount(cu.contextWindow);
        const pct = cu.percent != null ? Math.round(cu.percent) : null;
        if (tokensK !== null && pct !== null) {
            contextHtml = `<span class="footer-context" title="Context: ${tokensK} / ${windowK} tokens (${pct}%)">${tokensK} / ${windowK} &middot; ${pct}%</span>`;
        } else {
            contextHtml = `<span class="footer-context" title="Context window: ${windowK} tokens">${windowK}</span>`;
        }
    }

    footer.innerHTML = `
        <span class="footer-model">${escHtml(modelName)}</span>
        <span class="footer-spacer"></span>
        ${contextHtml}
        ${state.isStreaming ? '<button id="btn-abort" class="abort-btn" title="Stop generation (Esc)">&#9632; Stop</button>' : ''}
        <button id="btn-send" class="send-btn" title="${state.isStreaming ? 'Steer' : 'Send'}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    `;
    container.appendChild(footer);
    return container;
}

function buildWelcome(): HTMLElement {
    const w = el('div', 'welcome');
    w.innerHTML = `
        <div class="welcome-icon">&pi;</div>
        <div class="welcome-title">Pi Agent</div>
        <div class="welcome-subtitle">Ask anything. Pi can read, write, and execute code for you.</div>
        <div class="welcome-hints">
            <div class="welcome-hint">Type a message to start</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+L</kbd> Focus chat</div>
            <div class="welcome-hint"><kbd>Ctrl+Shift+N</kbd> New session</div>
            <div class="welcome-hint"><kbd>Esc</kbd> Stop generation</div>
        </div>
    `;
    return w;
}

// ── Changed Files section ──

function getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
        ts: '&#128312;', tsx: '&#128312;',
        js: '&#128313;', jsx: '&#128313;',
        json: '&#128312;',
        css: '&#128309;', scss: '&#128309;',
        html: '&#128992;',
        md: '&#128310;',
        py: '&#128311;',
        svg: '&#128993;',
    };
    return icons[ext] ?? '&#128196;';
}

function buildChangedFilesSection(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'changed-files-section';
    details.id = 'changed-files-bar';

    const fileMap = new Map<string, FileChangeInfo>();
    for (const c of state.fileChanges) {
        fileMap.set(c.filePath, c);
    }
    const uniqueFiles = [...fileMap.values()];
    const count = uniqueFiles.length;

    const summary = document.createElement('summary');
    summary.className = 'changed-files-summary';
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${count} File${count !== 1 ? 's' : ''}</span>
        <span class="changed-files-spacer"></span>
        <button class="changed-files-link" id="btn-undo-all" title="Undo all">Undo All</button>
        <button class="changed-files-review-btn" id="btn-review-all" title="Review all changes">Review</button>
    `;
    details.appendChild(summary);

    const list = el('div', 'changed-files-list');
    for (const change of uniqueFiles) {
        const fileName = change.filePath.split('/').pop() ?? change.filePath;
        const item = el('div', 'changed-file-item');
        item.dataset.filepath = change.filePath;
        item.dataset.toolcallid = change.toolCallId;

        let statsHtml = '';
        if (change.addedLines > 0) statsHtml += `<span class="cf-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="cf-stat-del">-${change.removedLines}</span>`;

        item.innerHTML = `
            <span class="cf-icon">${getFileIcon(change.filePath)}</span>
            <span class="cf-name">${escHtml(fileName)}</span>
            <span class="cf-stats">${statsHtml}</span>
        `;
        list.appendChild(item);
    }
    details.appendChild(list);

    return details;
}

function renderChangedFilesBar(): void {
    const existing = document.getElementById('changed-files-bar');
    if (existing) {
        const fileMap = new Map<string, FileChangeInfo>();
        for (const c of state.fileChanges) {
            fileMap.set(c.filePath, c);
        }
        const count = fileMap.size;
        const countEl = existing.querySelector('.changed-files-count');
        if (countEl) {
            countEl.textContent = `${count} File${count !== 1 ? 's' : ''}`;
        }
    }
}

function renderInlineFileChange(change: FileChangeInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    const existing = document.getElementById(`diff-${change.toolCallId}`);
    if (existing) return;

    const card = buildDiffCard(change);

    const loadingCard = document.getElementById(`tool-${change.toolCallId}`);
    if (loadingCard) {
        loadingCard.replaceWith(card);
    } else {
        container.appendChild(card);
    }

    bindDiffButtons();
    scrollToBottom();
}

// ── Inline diff card ──

function buildDiffCard(change: FileChangeInfo): HTMLElement {
    const card = el('div', 'diff-card');
    card.id = `diff-${change.toolCallId}`;

    const fileName = change.filePath.split('/').pop() ?? change.filePath;
    const dirPath = change.filePath.split('/').slice(0, -1).join('/');

    let statsHtml = '';
    if (change.addedLines > 0 || change.removedLines > 0) {
        statsHtml = `<span class="diff-stats">`;
        if (change.addedLines > 0) statsHtml += `<span class="diff-stat-add">+${change.addedLines}</span>`;
        if (change.removedLines > 0) statsHtml += `<span class="diff-stat-del">-${change.removedLines}</span>`;
        statsHtml += `</span>`;
    }

    card.innerHTML = `
        <div class="diff-file-header" data-filepath="${escHtml(change.filePath)}" data-toolcallid="${escHtml(change.toolCallId)}">
            <span class="diff-file-icon">${change.isNew ? '&#10010;' : '&#9998;'}</span>
            <span class="diff-file-name">${escHtml(fileName)}</span>
            ${dirPath ? `<span class="diff-file-dir">${escHtml(dirPath)}</span>` : ''}
            ${statsHtml}
            ${change.isNew ? '<span class="diff-new-badge">NEW</span>' : ''}
        </div>
    `;

    if (change.diff) {
        const diffView = el('div', 'diff-view');
        diffView.innerHTML = renderDiffLines(change.diff);
        card.appendChild(diffView);
    }

    return card;
}

function renderDiffLines(diff: string): string {
    const lines = diff.split('\n');
    const htmlLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            continue;
        }
        if (line.startsWith('@@')) {
            htmlLines.push(`<div class="diff-line diff-line-hunk">${escHtml(line)}</div>`);
        } else if (line.startsWith('+')) {
            htmlLines.push(`<div class="diff-line diff-line-add">${escHtml(line)}</div>`);
        } else if (line.startsWith('-')) {
            htmlLines.push(`<div class="diff-line diff-line-del">${escHtml(line)}</div>`);
        } else {
            htmlLines.push(`<div class="diff-line diff-line-ctx">${escHtml(line)}</div>`);
        }
    }

    return htmlLines.join('');
}

// ── Message rendering ──

function renderMessage(msg: any, index: number, turnNumber?: number): HTMLElement {
    const role = msg.role ?? 'unknown';

    if (role === 'toolResult' || role === 'tool') {
        const toolName = msg.toolName ?? '';
        if (toolName === 'edit' || toolName === 'write') {
            const matchingChange = findFileChangeForToolResult(msg);
            if (matchingChange) {
                return buildDiffCard(matchingChange);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    const wrapper = el('div', `message message-${role}`);

    if (role === 'user' && turnNumber !== undefined && !state.isStreaming) {
        const checkpointBtn = el('button', 'checkpoint-btn');
        checkpointBtn.title = 'Restore to this checkpoint';
        checkpointBtn.dataset.turn = String(turnNumber);
        checkpointBtn.innerHTML = '&#8634;';
        wrapper.appendChild(checkpointBtn);
    }

    const thinking = extractThinking(msg);
    if (thinking) {
        wrapper.appendChild(buildThinkingBlock(thinking, false));
    }

    const text = extractText(msg);
    if (text) {
        const content = el('div', 'message-content');
        content.innerHTML = renderMarkdown(text);
        wrapper.appendChild(content);
    }

    // Don't render tool calls from assistant messages -- they appear
    // merged into the subsequent toolResult messages instead
    return wrapper;
}

function extractToolCalls(msg: any): any[] {
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg.tool_calls;
    if (Array.isArray(msg.content)) {
        const tcs = msg.content.filter((c: any) => c.type === 'toolCall' || c.type === 'tool_call' || c.type === 'tool_use');
        if (tcs.length > 0) return tcs;
    }
    return [];
}

function findFileChangeForToolResult(msg: any): FileChangeInfo | undefined {
    const id = msg.toolCallId ?? msg.tool_call_id;
    if (id) {
        const match = state.fileChanges.find(c => c.toolCallId === id);
        if (match) return match;
    }
    return undefined;
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.streamingText && !state.streamingThinking) return;

    if (!container.querySelector('.message')) {
        container.innerHTML = `
            <div class="message message-assistant">
                <details class="thinking-block active" open id="streaming-thinking" style="display:none">
                    <summary class="thinking-summary">
                        <span class="thinking-indicator"></span>
                        <span class="thinking-label">Thinking...</span>
                    </summary>
                    <div class="thinking-content"></div>
                </details>
                <div class="message-content" id="streaming-text"></div>
            </div>
        `;
    }

    const thinkingEl = document.getElementById('streaming-thinking') as HTMLDetailsElement | null;
    if (thinkingEl) {
        if (state.streamingThinking) {
            thinkingEl.style.display = '';
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) contentEl.innerHTML = renderMarkdown(state.streamingThinking);
            const labelEl = thinkingEl.querySelector('.thinking-label');
            if (state.isThinking) {
                thinkingEl.classList.add('active');
                if (labelEl) labelEl.textContent = 'Thinking...';
            } else {
                thinkingEl.classList.remove('active');
                if (labelEl) {
                    const dur = state.streamingThinkingDuration;
                    labelEl.textContent = dur > 0
                        ? `Thought for ${dur} second${dur !== 1 ? 's' : ''}`
                        : 'Thought';
                }
            }
        } else {
            thinkingEl.style.display = 'none';
        }
    }

    const textEl = document.getElementById('streaming-text');
    if (textEl) {
        textEl.innerHTML = renderMarkdown(state.streamingText);
    }

    bindCopyButtons();
    scrollToBottom();
}

// ── Tool rendering ──

function getToolIcon(name: string): string {
    const icons: Record<string, string> = {
        bash: '&#9881;',
        python: '&#128013;',
        read: '&#128196;',
        write: '&#9998;',
        edit: '&#9998;',
        glob: '&#128269;',
        grep: '&#128269;',
        list: '&#128193;',
    };
    return icons[name.toLowerCase()] ?? '&#9889;';
}

function getToolLabel(name: string, args: any): string {
    switch (name.toLowerCase()) {
        case 'bash':
            return args?.command ? truncate(args.command, 60) : 'Execute command';
        case 'read':
            return args?.path ? `Read ${truncate(args.path, 50)}` : 'Read file';
        case 'write':
            return args?.path ? `Write ${truncate(args.path, 50)}` : 'Write file';
        case 'edit':
            return args?.path ? `Edit ${truncate(args.path, 50)}` : 'Edit file';
        case 'glob':
            return args?.pattern ? `Glob ${truncate(args.pattern, 50)}` : 'Find files';
        case 'grep':
            return args?.pattern ? `Grep ${truncate(args.pattern, 50)}` : 'Search files';
        default:
            return name;
    }
}

function extractToolResultText(result: any): string {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        return result
            .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof result === 'object') {
        if (Array.isArray(result.content)) {
            const text = result.content
                .map((item: any) => (typeof item === 'string' ? item : item?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
        if (result.text) return result.text;
        if (result.output) return result.output;
    }
    return JSON.stringify(result, null, 2);
}

function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val}`;
    }).join('\n');
}

function buildStatusHtml(status: string): string {
    if (status === 'done') return '';
    return `<span class="tool-status ${status}">${status}</span>`;
}

function buildToolCard(tc: any): HTMLElement {
    const card = el('div', 'tool-card');
    const name = tc.name ?? tc.toolName ?? tc.function?.name ?? 'unknown';
    const args = tc.args ?? tc.arguments ?? tc.input ?? tc.function?.arguments;
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const statusClass = tc._status ?? 'pending';

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(name)}</span>
            <span class="tool-name">${escHtml(getToolLabel(name, parsedArgs))}</span>
            ${buildStatusHtml(statusClass)}
        </div>
    `;

    if (tc._result !== undefined) {
        const text = extractToolResultText(tc._result);
        if (text) {
            const result = el('pre', 'tool-result');
            result.textContent = text;
            card.appendChild(result);
        }
    }

    return card;
}

function buildToolResultCard(msg: any, allMessages: any[], msgIndex: number): HTMLElement {
    const isError = msg.isError ?? false;
    const toolName = msg.toolName ?? '';
    const toolCallId = msg.toolCallId ?? '';
    const nameLower = toolName.toLowerCase();

    const matchingCall = findToolCallInMessages(allMessages, msgIndex, toolCallId);
    const args = matchingCall?.arguments ?? matchingCall?.args ?? matchingCall?.input ?? {};
    const parsedArgs = typeof args === 'string' ? tryParseJSON(args) : args;
    const label = toolName ? getToolLabel(toolName, parsedArgs) : 'Tool Result';
    const icon = toolName ? getToolIcon(toolName) : (isError ? '&#10060;' : '&#9889;');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash);

    if (hasBody) {
        const details = document.createElement('details');
        details.className = `tool-card tool-expandable${isRead ? ' tool-clickable' : ''}`;
        if (isRead && filePath) details.dataset.filepath = filePath;

        details.innerHTML = `
            <summary class="tool-header">
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${escHtml(label)}</span>
                ${buildStatusHtml(isError ? 'error' : 'done')}
                <span class="tool-expand-arrow">&#9656;</span>
            </summary>
        `;

        const body = el('div', 'tool-body');
        const result = el('pre', 'tool-result');
        result.textContent = resultContent || '(no output)';
        if (!resultContent) result.classList.add('empty');
        body.appendChild(result);
        details.appendChild(body);

        return details;
    }

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;

    return card;
}

function findToolCallInMessages(messages: any[], beforeIndex: number, toolCallId: string): any | undefined {
    if (!toolCallId) return undefined;
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const tcs = extractToolCalls(m);
        for (const tc of tcs) {
            if ((tc.id ?? tc.toolCallId) === toolCallId) return tc;
        }
    }
    return undefined;
}

function renderToolStart(event: any): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if ((event.toolName === 'edit' || event.toolName === 'write') && event.args?.path) {
        const card = el('div', 'diff-card loading');
        card.id = `tool-${event.toolCallId}`;
        const fileName = (event.args.path as string).split('/').pop() ?? event.args.path;
        card.innerHTML = `
            <div class="diff-file-header">
                <span class="diff-file-icon">&#9998;</span>
                <span class="diff-file-name">${escHtml(fileName)}</span>
                <span class="tool-status running">running</span>
            </div>
        `;
        container.appendChild(card);
        scrollToBottom();
        return;
    }

    const parsedArgs = typeof event.args === 'string' ? tryParseJSON(event.args) : event.args;
    const nameLower = (event.toolName ?? '').toLowerCase();
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    card.id = `tool-${event.toolCallId}`;
    card.dataset.toolName = event.toolName;
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(event.toolName)}</span>
            <span class="tool-name">${escHtml(getToolLabel(event.toolName, parsedArgs))}</span>
            <span class="tool-status running">running</span>
        </div>
    `;

    container.appendChild(card);
    bindToolClickable();
    scrollToBottom();
}

function renderToolUpdate(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;
    if (card.classList.contains('diff-card')) return;
    const text = extractToolResultText(event.partialResult);
    if (!text) return;
    let resultEl = card.querySelector('.tool-result') as HTMLElement | null;
    if (!resultEl) {
        resultEl = el('pre', 'tool-result');
        card.appendChild(resultEl);
    }
    resultEl.textContent = text;
    scrollToBottom();
}

function renderToolEnd(event: any): void {
    const card = document.getElementById(`tool-${event.toolCallId}`);
    if (!card) return;

    if (card.classList.contains('diff-card')) {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = event.isError ? 'error' : 'done';
            statusEl.className = `tool-status ${event.isError ? 'error' : 'done'}`;
        }
        return;
    }

    const toolName = (card as HTMLElement).dataset.toolName ?? '';
    const text = extractToolResultText(event.result);
    const isBash = toolName.toLowerCase() === 'bash';
    const hasBody = !!(text || isBash);

    if (hasBody) {
        const details = document.createElement('details');
        details.className = card.className.replace('tool-card', 'tool-card tool-expandable');
        details.id = card.id;
        details.dataset.toolName = toolName;
        if (card.dataset.filepath) details.dataset.filepath = card.dataset.filepath;

        const headerEl = card.querySelector('.tool-header');
        const nameHtml = headerEl?.innerHTML ?? '';

        details.innerHTML = `<summary class="tool-header">${nameHtml}</summary>`;

        const statusEl = details.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }

        const arrow = el('span', 'tool-expand-arrow');
        arrow.innerHTML = '&#9656;';
        details.querySelector('summary')?.appendChild(arrow);

        const body = el('div', 'tool-body');
        const resultEl = el('pre', 'tool-result');
        resultEl.textContent = text || '(no output)';
        if (!text) resultEl.classList.add('empty');
        body.appendChild(resultEl);
        details.appendChild(body);

        card.replaceWith(details);
        bindToolClickable();
    } else {
        const statusEl = card.querySelector('.tool-status');
        if (statusEl) {
            if (event.isError) {
                statusEl.textContent = 'error';
                statusEl.className = 'tool-status error';
            } else {
                statusEl.remove();
            }
        }
    }
}

// ── Thinking block ──

function buildThinkingBlock(text: string, active: boolean): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    const label = active ? 'Thinking...' : 'Thought';
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span> ${label}
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

// ── Model picker ──

function renderModelPicker(models: any[], current?: any, thinkingLevel?: string): void {
    const bar = document.getElementById('model-bar');
    if (!bar) return;

    bar.innerHTML = `
        <select id="model-select" title="Select model">
            ${models.map(m => `<option value="${escHtml(m.provider)}:${escHtml(m.id)}" ${current && m.id === current.id && m.provider === current.provider ? 'selected' : ''}>${escHtml(m.name ?? m.id)}</option>`).join('')}
        </select>
        <select id="thinking-select" title="Thinking level">
            ${['off', 'minimal', 'low', 'medium', 'high'].map(l => `<option value="${l}" ${l === thinkingLevel ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
    `;

    document.getElementById('model-select')?.addEventListener('change', (e) => {
        const val = (e.target as HTMLSelectElement).value;
        const [provider, ...rest] = val.split(':');
        vscode.postMessage({ type: 'setModel', provider, modelId: rest.join(':') });
    });

    document.getElementById('thinking-select')?.addEventListener('change', (e) => {
        vscode.postMessage({ type: 'setThinkingLevel', level: (e.target as HTMLSelectElement).value });
    });
}

// ── Session list ──

function renderSessionList(sessions: any[], currentId?: string): void {
    let panel = document.getElementById('session-panel');
    if (!panel) {
        panel = el('div', 'session-panel');
        panel.id = 'session-panel';
        const app = document.getElementById('app');
        const modelBar = document.getElementById('model-bar');
        if (app && modelBar?.nextSibling) {
            app.insertBefore(panel, modelBar.nextSibling);
        } else {
            app?.appendChild(panel);
        }
    }

    if (sessions.length === 0) {
        panel.innerHTML = '<div class="session-empty">No previous sessions</div>';
        return;
    }

    panel.innerHTML = `
        <div class="session-header">
            <span>Sessions</span>
            <button class="icon-btn" id="btn-close-sessions" title="Close">&times;</button>
        </div>
        <div class="session-list">
            ${sessions.map(s => `
                <div class="session-item ${s.id === currentId ? 'active' : ''}" data-path="${escHtml(s.path)}">
                    <span class="session-item-name">${escHtml(s.name ?? s.id)}</span>
                </div>
            `).join('')}
        </div>
    `;

    document.getElementById('btn-close-sessions')?.addEventListener('click', () => panel?.remove());
    panel.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', () => {
            const sessionPath = (item as HTMLElement).dataset.path;
            if (sessionPath) {
                vscode.postMessage({ type: 'loadSession', sessionPath });
            }
        });
    });
}

function showError(message: string): void {
    const container = document.getElementById('messages');
    if (!container) return;
    const errEl = el('div', 'error-message');
    errEl.textContent = message;
    container.appendChild(errEl);
    scrollToBottom();
}

// ── Events ──

function bindEvents(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById('btn-send');
    const newBtn = document.getElementById('btn-new-session');
    const abortBtn = document.getElementById('btn-abort');
    const sessionsBtn = document.getElementById('btn-sessions');
    const undoAllBtn = document.getElementById('btn-undo-all');
    const reviewBtn = document.getElementById('btn-review-all');

    sendBtn?.addEventListener('click', () => {
        if (state.isStreaming) {
            const text = input?.value.trim();
            if (text) {
                vscode.postMessage({ type: 'steer', text });
                if (input) { input.value = ''; input.style.height = 'auto'; }
            } else {
                vscode.postMessage({ type: 'abort' });
            }
        } else {
            sendMessage();
        }
    });

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (state.isStreaming) {
                const text = input.value.trim();
                if (text) {
                    vscode.postMessage({ type: 'steer', text });
                    input.value = '';
                    input.style.height = 'auto';
                }
            } else {
                sendMessage();
            }
        }
        if (e.key === 'Escape' && state.isStreaming) {
            e.preventDefault();
            vscode.postMessage({ type: 'abort' });
        }
    });

    input?.addEventListener('input', () => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    newBtn?.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    sessionsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'getSessions' }));
    abortBtn?.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

    undoAllBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'undoAllFileChanges',
            message: 'Undo all file changes made in this session?',
        });
    });

    reviewBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const seen = new Set<string>();
        for (const change of state.fileChanges) {
            if (!seen.has(change.filePath)) {
                seen.add(change.filePath);
                vscode.postMessage({ type: 'openDiff', filePath: change.filePath, toolCallId: change.toolCallId });
            }
        }
    });
}

function bindCheckpointButtons(): void {
    document.querySelectorAll('.checkpoint-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const turn = parseInt((btn as HTMLElement).dataset.turn ?? '-1', 10);
            if (turn < 1) return;
            vscode.postMessage({
                type: 'confirmAction',
                action: 'restoreCheckpoint',
                message: 'Discard all changes after this checkpoint?',
                payload: { messageIndex: turn - 1 },
            });
        });
    });
}

function bindRedoButtons(): void {
    document.querySelectorAll('.redo-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
                type: 'confirmAction',
                action: 'redoCheckpoint',
                message: 'Re-apply the rolled-back changes?',
            });
        });
    });
}

function bindDiffButtons(): void {
    document.querySelectorAll('.diff-file-header:not([data-bound])').forEach((header) => {
        header.setAttribute('data-bound', '1');
        header.addEventListener('click', () => {
            const filePath = (header as HTMLElement).dataset.filepath;
            const toolCallId = (header as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function bindToolClickable(): void {
    document.querySelectorAll('.tool-clickable:not([data-click-bound])').forEach((card) => {
        card.setAttribute('data-click-bound', '1');
        const headerEl = card.querySelector('.tool-header') as HTMLElement | null;
        if (!headerEl) return;
        const nameEl = headerEl.querySelector('.tool-name') as HTMLElement | null;
        if (!nameEl) return;
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const filePath = (card as HTMLElement).dataset.filepath;
            if (filePath) {
                vscode.postMessage({ type: 'openFile', filePath });
            }
        });
    });
}

function bindChangedFileItems(): void {
    document.querySelectorAll('.changed-file-item:not([data-bound])').forEach((item) => {
        item.setAttribute('data-bound', '1');
        item.addEventListener('click', () => {
            const filePath = (item as HTMLElement).dataset.filepath;
            const toolCallId = (item as HTMLElement).dataset.toolcallid;
            if (filePath && toolCallId) {
                vscode.postMessage({ type: 'openDiff', filePath, toolCallId });
            }
        });
    });
}

function sendMessage(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    vscode.postMessage({ type: 'prompt', text });
}

function bindCopyButtons(): void {
    document.querySelectorAll('.copy-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.codeId;
            if (!id) return;
            const codeEl = document.getElementById(id);
            if (!codeEl) return;
            navigator.clipboard.writeText(codeEl.textContent ?? '').then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });
    });
}

// ── Helpers ──

function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function extractThinking(msg: any): string {
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking ?? c.text ?? '')
            .join('');
    }
    return msg.thinking ?? '';
}

function extractText(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
    }
    return msg.text ?? '';
}

function formatTokenCount(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

function tryParseJSON(s: string): any {
    try { return JSON.parse(s); } catch { return s; }
}

function scrollToBottom(): void {
    const messages = document.getElementById('messages');
    if (messages) {
        messages.scrollTop = messages.scrollHeight;
    }
}

// ── Init ──
render();

import { marked } from 'marked';
import type { ClientMessage, ServerMessage, SerializedAgentState, FileChangeInfo, TabInfo, ToolCallPendingInfo, SkillInfo } from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: ClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();
const iconsBaseUri = document.getElementById('app')?.dataset.iconsUri ?? '';

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
    availableModels: any[];
    recentModels: { provider: string; id: string; name?: string }[];
    tabs: TabInfo[];
    activeTabId: string;
    skills: SkillInfo[];
    queuedMessages: string[];
} = {
    messages: [],
    isStreaming: false,
    tools: [],
    streamingText: '',
    streamingThinking: '',
    isThinking: false,
    thinkingStartTime: 0,
    streamingThinkingDuration: 0,
    availableModels: [],
    recentModels: [],
    fileChanges: [],
    rollbackPoint: null,
    tabs: [],
    activeTabId: '',
    skills: [],
    queuedMessages: [],
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
            vscode.postMessage({ type: 'getSkills' });
            break;
        case 'stateSync':
            applyStateSync(msg.state);
            break;
        case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        case 'models':
            state.availableModels = msg.models ?? [];
            if (msg.current) {
                state.model = msg.current;
                addToRecentModels(msg.current.provider, msg.current.id, msg.current.name);
            }
            if (msg.thinkingLevel) state.thinkingLevel = msg.thinkingLevel;
            updateFooterModel();
            if (pendingModelPicker) {
                pendingModelPicker = false;
                showModelPicker();
            }
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
        case 'toolCallPending':
            renderToolApprovalCard(msg.pending);
            break;
        case 'toolCallResolved':
            removeToolApprovalCard(msg.toolCallId);
            break;
        case 'skills':
            state.skills = msg.skills;
            break;
        case 'error':
            showError(msg.message);
            break;
    }
}

function handleConfirmResult(action: string, confirmed: boolean, payload?: any): void {
    if (!confirmed) return;
    switch (action) {
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
    const prevTab = state.activeTabId;
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
    state.tabs = s.tabs ?? [];
    state.activeTabId = s.activeTabId ?? '';
    state.streamingText = s.streamingText ?? '';
    state.streamingThinking = s.streamingThinking ?? '';
    state.isThinking = s.isThinking ?? false;
    state.thinkingStartTime = s.thinkingStartTime ?? 0;
    state.streamingThinkingDuration = s.streamingThinkingDuration ?? 0;
    state.queuedMessages = s.queuedMessages ?? [];
    const tabSwitched = prevTab !== state.activeTabId;

    if (tabSwitched || !skeletonBuilt) {
        render();
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    } else {
        updateTabs();
        updateStreamingUI();
        updateMessages();
        updateInputArea();
        updateChangedFiles();
        updateQueuedMessageBanner();
        if (state.isStreaming) {
            ensurePreparingPlaceholder();
        }
        updateScrollButton();
    }
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
            userHasScrolled = false;
            updateInputArea();
            updateStreamingUI();
            showPreparingPlaceholder();
            break;
        case 'agent_end':
            state.isStreaming = false;
            state.streamingText = '';
            state.streamingThinking = '';
            state.isThinking = false;
            dismissSteerToast();
            updateStreamingUI();
            updateInputArea();
            break;
        case 'tool_execution_start':
            removePreparingPlaceholder();
            renderToolStart(event);
            break;
        case 'tool_execution_update':
            renderToolUpdate(event);
            break;
        case 'tool_execution_end':
            renderToolEnd(event);
            showPreparingPlaceholder();
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
            dismissSteerToast();
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
            dismissSteerToast();
            break;
        case 'text_end':
            break;
    }
    renderStreamingContent();
}

// ── Rendering ──

let skeletonBuilt = false;

function render(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = '';
    skeletonBuilt = false;

    // Header: tab-strip (dynamic) + header-right (static)
    const header = el('div', 'header');
    const tabStrip = el('div', 'tab-strip');
    header.appendChild(tabStrip);
    const headerActions = el('div', 'header-right');
    headerActions.innerHTML = `
        <button class="icon-btn" id="btn-new-tab" title="New Agent"><img class="header-icon-img" src="${iconsBaseUri}/new.png" alt="new"></button>
        <button class="icon-btn" id="btn-sessions" title="Sessions"><img class="header-icon-img" src="${iconsBaseUri}/list.png" alt="sessions"></button>
        <button class="icon-btn" id="btn-settings" title="Settings"><img class="header-icon-img" src="${iconsBaseUri}/settings.png" alt="settings"></button>
    `;
    header.appendChild(headerActions);
    app.appendChild(header);

    // Messages container (persistent, children managed by updateMessages)
    const messagesContainer = el('div', 'messages');
    messagesContainer.id = 'messages';
    const streamingContainer = el('div', 'streaming-message message-group-assistant');
    streamingContainer.id = 'streaming-message';
    messagesContainer.appendChild(streamingContainer);
    const spacer = el('div', 'messages-spacer');
    messagesContainer.appendChild(spacer);
    app.appendChild(messagesContainer);

    // Scroll-to-bottom button (static)
    const scrollWrap = el('div', 'scroll-btn-wrap');
    const scrollBtn = el('button', 'scroll-bottom-btn');
    scrollBtn.id = 'btn-scroll-bottom';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 13L3 8M8 13L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    scrollWrap.appendChild(scrollBtn);
    app.appendChild(scrollWrap);

    // Input container: changed-files slot + queued section + slash menu + input-area (persistent textarea) + footer
    const inputContainer = el('div', 'input-container');
    const queuedSection = document.createElement('details');
    queuedSection.className = 'queued-section';
    queuedSection.id = 'queued-section';
    queuedSection.style.display = 'none';
    inputContainer.appendChild(queuedSection);
    const slashMenu = el('div', 'slash-menu');
    slashMenu.id = 'slash-menu';
    slashMenu.style.display = 'none';
    inputContainer.appendChild(slashMenu);
    const area = el('div', 'input-area');
    area.innerHTML = `<textarea id="input" placeholder="Ask Pi anything..." rows="1"></textarea>`;
    inputContainer.appendChild(area);
    const footer = el('div', 'input-footer');
    inputContainer.appendChild(footer);
    app.appendChild(inputContainer);

    // Bind stable event listeners (these elements persist for the lifetime of the skeleton)
    bindStableEvents();
    bindScrollListener();
    scrollBtn.addEventListener('click', () => {
        userHasScrolled = false;
        scrollToBottom(true);
        updateScrollButton();
    });

    skeletonBuilt = true;

    // Populate all dynamic sections
    updateTabs();
    updateMessages();
    updateInputArea();
    updateChangedFiles();
    scrollToBottom();
}

function updateMessages(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    const streamingEl = document.getElementById('streaming-message');
    const spacerEl = container.querySelector('.messages-spacer');

    // Remove all children before #streaming-message (the message nodes)
    while (container.firstChild && container.firstChild !== streamingEl) {
        container.removeChild(container.firstChild);
    }

    codeBlockId = 0;

    if (state.messages.length === 0 && !state.isStreaming) {
        container.insertBefore(buildWelcome(), streamingEl);
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

            container.insertBefore(msgEl, streamingEl);

            if (role === 'user' && dimming && !redoPlaced && rollbackUserIdx !== null) {
                const redoWrap = el('div', 'redo-anchor');
                const redoBtn = el('button', 'redo-btn');
                redoBtn.title = 'Redo changes';
                redoBtn.textContent = 'Redo';
                redoWrap.appendChild(redoBtn);
                container.insertBefore(redoWrap, streamingEl);
                redoPlaced = true;
            }
        }
    }

    bindCopyButtons();
    bindCheckpointButtons();
    bindRedoButtons();
    bindDiffButtons();
    bindToolClickable();
}

function updateTabs(): void {
    const tabStrip = document.querySelector('.tab-strip');
    if (!tabStrip) return;
    tabStrip.innerHTML = '';

    for (const tab of state.tabs) {
        const tabEl = el('div', `tab${tab.isActive ? ' tab-active' : ''}${tab.isStreaming ? ' tab-streaming' : ''}`);
        tabEl.dataset.tabId = tab.id;

        const icon = el('span', 'tab-icon');
        if (tab.isStreaming) {
            icon.innerHTML = '<span class="tab-spinner"></span>';
        } else if (tab.hasNotification) {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/notification.png" alt="notification">`;
        } else {
            icon.innerHTML = `<img class="tab-icon-img" src="${iconsBaseUri}/chat.png" alt="chat">`;
        }

        const name = el('span', 'tab-name');
        const displayName = tab.name.length > 20
            ? tab.name.substring(0, 18) + '...'
            : tab.name;
        name.textContent = displayName;
        name.title = tab.name;

        tabEl.appendChild(icon);
        tabEl.appendChild(name);

        if (state.tabs.length > 1) {
            const closeBtn = el('button', 'tab-close');
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close tab';
            closeBtn.dataset.tabId = tab.id;
            tabEl.appendChild(closeBtn);
        }

        tabStrip.appendChild(tabEl);
    }

    bindTabEvents();
}

function updateInputArea(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (input) {
        input.placeholder = state.isStreaming
            ? 'Type to queue a message, Ctrl+Enter to steer, Esc to stop...'
            : 'Ask Pi anything...';
    }

    const footer = document.querySelector('.input-footer');
    if (!footer) return;

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

    const steerBtnHtml = state.isStreaming
        ? `<button id="btn-steer" class="steer-btn" title="Steer (Ctrl+Enter)"><img class="steer-icon-img" src="${iconsBaseUri}/chevrons.png" alt="steer"></button>`
        : '';

    footer.innerHTML = `
        <span class="footer-model">${escHtml(modelName)}</span>
        <span class="footer-spacer"></span>
        ${contextHtml}
        ${state.isStreaming ? '<button id="btn-abort" class="abort-btn" title="Stop generation (Esc)">&#9632; Stop</button>' : ''}
        ${steerBtnHtml}
        <button id="btn-send" class="send-btn" title="${state.isStreaming ? 'Queue' : 'Send'}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3L8 13M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    `;

    // Rebind the dynamic footer elements
    const sendBtn = document.getElementById('btn-send');
    sendBtn?.addEventListener('click', () => {
        if (state.isStreaming) {
            const text = input?.value.trim();
            if (text) {
                vscode.postMessage({ type: 'queueMessage', text });
                if (input) { input.value = ''; input.style.height = 'auto'; }
            } else {
                vscode.postMessage({ type: 'abort' });
            }
        } else {
            sendMessage();
        }
    });

    const steerBtn = document.getElementById('btn-steer');
    steerBtn?.addEventListener('click', () => {
        const text = input?.value.trim();
        if (text) {
            vscode.postMessage({ type: 'steer', text });
            if (input) { input.value = ''; input.style.height = 'auto'; }
            showSteerToast(text);
        }
    });

    const abortBtn = document.getElementById('btn-abort');
    abortBtn?.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

    document.querySelector('.footer-model')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleModelPicker();
    });

    updateQueuedMessageBanner();
}

let queuedEditingIndex = -1;

function updateQueuedMessageBanner(): void {
    const section = document.getElementById('queued-section') as HTMLDetailsElement | null;
    if (!section) return;

    if (state.queuedMessages.length === 0) {
        section.style.display = 'none';
        section.innerHTML = '';
        queuedEditingIndex = -1;
        return;
    }

    section.style.display = '';
    section.open = true;

    const count = state.queuedMessages.length;
    section.innerHTML = `
        <summary class="queued-summary">
            <span class="queued-chevron">&#9656;</span>
            <span class="queued-count">${count} Queued</span>
        </summary>
        <div class="queued-list">
            ${state.queuedMessages.map((msg, i) => {
                if (i === queuedEditingIndex) {
                    return `<div class="queued-item queued-item-editing" data-index="${i}">
                        <span class="queued-item-icon">&#9675;</span>
                        <input class="queued-edit-input" data-index="${i}" type="text" value="${escAttr(msg)}">
                        <button class="queued-edit-save" data-index="${i}" title="Save">&#10003;</button>
                        <button class="queued-edit-cancel" data-index="${i}" title="Cancel">&#10005;</button>
                    </div>`;
                }
                return `<div class="queued-item" data-index="${i}">
                    <span class="queued-item-icon">&#9675;</span>
                    <span class="queued-item-text">${escHtml(msg)}</span>
                    <span class="queued-item-actions">
                        <button class="queued-item-btn queued-item-edit" data-index="${i}" title="Edit"><img class="queued-btn-icon" src="${iconsBaseUri}/pencil.png" alt="edit"></button>
                        <button class="queued-item-btn queued-item-delete" data-index="${i}" title="Remove"><img class="queued-btn-icon" src="${iconsBaseUri}/trash.png" alt="remove"></button>
                    </span>
                </div>`;
            }).join('')}
        </div>
    `;

    bindQueuedItemEvents(section);
}

function bindQueuedItemEvents(section: HTMLElement): void {
    section.querySelectorAll('.queued-item-delete').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                if (queuedEditingIndex === idx) queuedEditingIndex = -1;
                else if (queuedEditingIndex > idx) queuedEditingIndex--;
                vscode.postMessage({ type: 'removeQueuedMessage', index: idx });
            }
        });
    });

    section.querySelectorAll('.queued-item-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            if (idx >= 0) {
                queuedEditingIndex = idx;
                updateQueuedMessageBanner();
                const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        });
    });

    section.querySelectorAll('.queued-edit-save').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.index ?? '-1', 10);
            const input = section.querySelector(`.queued-edit-input[data-index="${idx}"]`) as HTMLInputElement | null;
            if (idx >= 0 && input && input.value.trim()) {
                queuedEditingIndex = -1;
                vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: input.value.trim() });
            }
        });
    });

    section.querySelectorAll('.queued-edit-cancel').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            queuedEditingIndex = -1;
            updateQueuedMessageBanner();
        });
    });

    section.querySelectorAll('.queued-edit-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            const idx = parseInt((input as HTMLElement).dataset.index ?? '-1', 10);
            if (ke.key === 'Enter') {
                ke.preventDefault();
                const val = (input as HTMLInputElement).value.trim();
                if (idx >= 0 && val) {
                    queuedEditingIndex = -1;
                    vscode.postMessage({ type: 'editQueuedMessage', index: idx, text: val });
                }
            }
            if (ke.key === 'Escape') {
                ke.preventDefault();
                queuedEditingIndex = -1;
                updateQueuedMessageBanner();
            }
        });
    });
}

function showSteerToast(text: string): void {
    const existing = document.getElementById('steer-toast');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const toast = el('div', 'steer-toast');
    toast.id = 'steer-toast';
    toast.innerHTML = `
        <span class="steer-toast-indicator"></span>
        <span class="steer-toast-label">Steering...</span>
        <span class="steer-toast-text">${escHtml(truncate(text, 80))}</span>
    `;

    const inputArea = container.querySelector('.input-area');
    if (inputArea) {
        container.insertBefore(toast, inputArea);
    } else {
        container.appendChild(toast);
    }
}

function dismissSteerToast(): void {
    const toast = document.getElementById('steer-toast');
    if (!toast) return;
    toast.classList.add('steer-toast-fade');
    setTimeout(() => toast.remove(), 300);
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
    const undoRedoBtn = state.rollbackPoint !== null
        ? `<button class="changed-files-link" id="btn-redo" title="Redo changes">Redo</button>`
        : `<button class="changed-files-link" id="btn-undo" title="Undo last change">Undo</button>`;
    summary.innerHTML = `
        <span class="changed-files-arrow">&#9656;</span>
        <span class="changed-files-count">${count} File${count !== 1 ? 's' : ''}</span>
        <span class="changed-files-spacer"></span>
        ${undoRedoBtn}
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

function updateChangedFiles(): void {
    const container = document.querySelector('.input-container');
    if (!container) return;

    const existing = document.getElementById('changed-files-bar') as HTMLDetailsElement | null;
    const wasOpen = existing?.open ?? false;

    if (state.fileChanges.length === 0) {
        existing?.remove();
        return;
    }

    const newSection = buildChangedFilesSection();
    if (wasOpen) {
        (newSection as HTMLDetailsElement).open = true;
    }

    if (existing) {
        existing.replaceWith(newSection);
    } else {
        container.insertBefore(newSection, container.firstChild);
    }

    bindChangedFileItems();

    const undoBtn = document.getElementById('btn-undo');
    undoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let lastUserTurn = 0;
        for (const msg of state.messages) {
            if ((msg.role ?? 'unknown') === 'user') lastUserTurn++;
        }
        if (lastUserTurn < 1) return;
        vscode.postMessage({
            type: 'confirmAction',
            action: 'restoreCheckpoint',
            message: 'Undo changes from the last turn?',
            payload: { messageIndex: lastUserTurn - 1 },
        });
    });

    const redoBtn = document.getElementById('btn-redo');
    redoBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({
            type: 'confirmAction',
            action: 'redoCheckpoint',
            message: 'Re-apply the rolled-back changes?',
        });
    });

    const reviewBtn = document.getElementById('btn-review-all');
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

function buildDiffCard(change: FileChangeInfo, msg?: any): HTMLElement {
    const wrapper = el('div', 'tool-card-wrapper');

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

    wrapper.appendChild(card);

    const ts = msg?.timestamp;
    if (ts) {
        const footer = el('div', 'tool-footer');
        footer.textContent = formatTimestamp(ts);
        wrapper.appendChild(footer);
    }

    return wrapper;
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
                return buildDiffCard(matchingChange, msg);
            }
        }
        return buildToolResultCard(msg, state.messages, index);
    }

    if (role === 'user') {
        const group = el('div', 'message-group-user');

        const wrapper = el('div', `message message-${role}`);
        if (turnNumber !== undefined && !state.isStreaming) {
            const checkpointBtn = el('button', 'checkpoint-btn');
            checkpointBtn.title = 'Restore to this checkpoint';
            checkpointBtn.dataset.turn = String(turnNumber);
            checkpointBtn.innerHTML = '&#8634;';
            wrapper.appendChild(checkpointBtn);
        }
        const text = extractText(msg);
        if (text) {
            const content = el('div', 'message-content');
            content.innerHTML = renderMarkdown(text);
            wrapper.appendChild(content);
        }
        group.appendChild(wrapper);

        const footer = buildMessageFooter(msg, index);
        if (footer) {
            group.appendChild(footer);
        }

        return group;
    }

    // Assistant messages: wrap in a styled container
    const thinking = extractThinking(msg);
    const text = extractText(msg);

    if (!thinking && !text) {
        const empty = el('div');
        empty.style.display = 'none';
        return empty;
    }

    const group = el('div', 'message-group-assistant');

    const wrapper = el('div', `message message-${role}`);

    if (thinking) {
        wrapper.appendChild(buildThinkingBlock(thinking, false, msg._thinkingDurationSec));
    }

    if (text) {
        const content = el('div', 'message-content');
        content.innerHTML = renderMarkdown(text);
        wrapper.appendChild(content);
    }

    group.appendChild(wrapper);

    const footer = buildMessageFooter(msg, index);
    if (footer) {
        group.appendChild(footer);
    }

    return group;
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

function removePreparingPlaceholder(): void {
    document.getElementById('preparing-placeholder')?.remove();
}

function showPreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    if (document.getElementById('preparing-placeholder')) return;
    const ph = el('div', 'preparing-placeholder');
    ph.id = 'preparing-placeholder';
    ph.textContent = 'Preparing next moves...';
    container.appendChild(ph);
    scrollToBottom();
}

function ensurePreparingPlaceholder(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    const hasRunningTool = container.querySelector('.tool-status.running');
    if (!hasRunningTool) {
        showPreparingPlaceholder();
    }
}

function renderStreamingContent(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    if (!state.streamingText && !state.streamingThinking) return;
    removePreparingPlaceholder();

    if (!container.querySelector('.message')) {
        container.innerHTML = `
            <div class="message message-assistant">
                <details class="thinking-block active" open id="streaming-thinking" style="display:none">
                    <summary class="thinking-summary">
                        <span class="thinking-indicator"></span>
                        <span class="thinking-label">Thinking...</span>
                        <span class="thinking-chevron">&#9656;</span>
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
    const iconFiles: Record<string, string> = {
        bash: 'terminal.png',
        python: 'code.png',
        read: 'text.png',
        write: 'pencil.png',
        edit: 'pencil.png',
        glob: 'magnifying-glass.png',
        grep: 'magnifying-glass.png',
        list: 'folder.png',
    };
    const file = iconFiles[name.toLowerCase()] ?? 'bolt.png';
    return `<img class="tool-icon-img" src="${iconsBaseUri}/${file}" alt="${escHtml(name)}">`;
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
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return `<span class="tool-status ${status}">${label}</span>`;
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

function buildToolFooter(msg: any, allMessages: any[], msgIndex: number): HTMLElement | null {
    const parts: string[] = [];
    const ts = msg.timestamp;
    if (ts) parts.push(formatTimestamp(ts));

    const precedingAssistant = findPrecedingAssistant(allMessages, msgIndex);
    if (precedingAssistant?.usage) {
        const u = precedingAssistant.usage;
        if (u.input > 0) parts.push(`${u.input.toLocaleString()} in`);
        if (u.output > 0) parts.push(`${u.output.toLocaleString()} out`);
    }

    if (parts.length === 0) return null;
    const footer = el('div', 'tool-footer');
    footer.textContent = parts.join(' · ');
    return footer;
}

function findPrecedingAssistant(messages: any[], beforeIndex: number): any | null {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i];
        if (messages[i].role === 'user') return null;
    }
    return null;
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
    const icon = getToolIcon(toolName ?? '');
    const isBash = nameLower === 'bash';
    const isRead = nameLower === 'read';
    const filePath = parsedArgs?.path ?? parsedArgs?.file_path ?? '';

    const resultContent = extractText(msg);
    const hasBody = !!(resultContent || isBash) && !isRead;

    const footer = buildToolFooter(msg, allMessages, msgIndex);

    if (hasBody) {
        const wrapper = el('div', 'tool-card-wrapper');

        const details = document.createElement('details');
        details.className = 'tool-card tool-expandable';

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
        wrapper.appendChild(details);

        if (footer) wrapper.appendChild(footer);
        return wrapper;
    }

    const wrapper = el('div', 'tool-card-wrapper');

    const card = el('div', `tool-card${isRead ? ' tool-clickable' : ''}`);
    if (isRead && filePath) card.dataset.filepath = filePath;

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${icon}</span>
            <span class="tool-name">${escHtml(label)}</span>
            ${buildStatusHtml(isError ? 'error' : 'done')}
        </div>
    `;

    wrapper.appendChild(card);
    if (footer) wrapper.appendChild(footer);
    return wrapper;
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

// ── Tool approval cards ──

function renderToolApprovalCard(pending: ToolCallPendingInfo): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;

    removePreparingPlaceholder();

    const existing = document.getElementById(`approval-${pending.toolCallId}`);
    if (existing) return;

    const card = el('div', 'tool-approval-card');
    card.id = `approval-${pending.toolCallId}`;

    const parsedArgs = typeof pending.args === 'string' ? tryParseJSON(pending.args) : pending.args;
    const label = getToolLabel(pending.toolName, parsedArgs);

    card.innerHTML = `
        <div class="tool-header">
            <span class="tool-icon">${getToolIcon(pending.toolName)}</span>
            <span class="tool-name">${escHtml(label)}</span>
            <span class="tool-status pending">awaiting approval</span>
        </div>
        <div class="approval-args">${escHtml(formatToolArgs(parsedArgs))}</div>
        <div class="approval-actions">
            <button class="approval-btn approve" data-toolcallid="${escHtml(pending.toolCallId)}">Approve</button>
            <button class="approval-btn reject" data-toolcallid="${escHtml(pending.toolCallId)}">Reject</button>
        </div>
    `;

    container.appendChild(card);
    bindApprovalButtons();
    scrollToBottom();
}

function removeToolApprovalCard(toolCallId: string): void {
    document.getElementById(`approval-${toolCallId}`)?.remove();
}

function bindApprovalButtons(): void {
    document.querySelectorAll('.approval-btn:not([data-bound])').forEach((btn) => {
        btn.setAttribute('data-bound', '1');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const toolCallId = (btn as HTMLElement).dataset.toolcallid;
            if (!toolCallId) return;
            if (btn.classList.contains('approve')) {
                vscode.postMessage({ type: 'approveToolCall', toolCallId });
            } else {
                vscode.postMessage({ type: 'rejectToolCall', toolCallId });
            }
            removeToolApprovalCard(toolCallId);
        });
    });
}

// ── Thinking block ──

function buildThinkingBlock(text: string, active: boolean, durationSec?: number): HTMLElement {
    const details = document.createElement('details');
    details.className = `thinking-block${active ? ' active' : ''}`;
    let label: string;
    if (active) {
        label = 'Thinking...';
    } else if (durationSec && durationSec > 0) {
        label = `Thought for ${durationSec} second${durationSec !== 1 ? 's' : ''}`;
    } else {
        label = 'Thought';
    }
    details.innerHTML = `
        <summary class="thinking-summary">
            <span class="thinking-indicator"></span>
            <span class="thinking-label">${label}</span>
            <span class="thinking-chevron">&#9656;</span>
        </summary>
        <div class="thinking-content">${renderMarkdown(text)}</div>
    `;
    return details;
}

// ── Model picker popup ──

let pendingModelPicker = false;

function toggleModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) {
        existing.remove();
        pendingModelPicker = false;
        return;
    }

    if (state.availableModels.length === 0) {
        pendingModelPicker = true;
        vscode.postMessage({ type: 'getModels' });
        return;
    }

    showModelPicker();
}

function addToRecentModels(provider: string, id: string, name?: string): void {
    state.recentModels = state.recentModels.filter(
        m => !(m.id === id && m.provider === provider)
    );
    state.recentModels.unshift({ provider, id, name });
    if (state.recentModels.length > 5) {
        state.recentModels = state.recentModels.slice(0, 5);
    }
}

function buildModelItem(m: any): HTMLElement {
    const item = el('div', 'model-item');
    const isActive = state.model && m.id === state.model.id && m.provider === state.model.provider;
    if (isActive) item.classList.add('active');
    item.dataset.provider = m.provider;
    item.dataset.modelId = m.id;
    item.dataset.name = (m.name ?? m.id).toLowerCase();
    item.innerHTML = `
        <span class="model-item-check">${isActive ? '&#10003;' : ''}</span>
        <span class="model-item-name">${escHtml(m.name ?? m.id)}</span>
    `;
    return item;
}

function showModelPicker(): void {
    const existing = document.getElementById('model-picker');
    if (existing) existing.remove();

    const container = document.querySelector('.input-container');
    if (!container) return;

    const picker = el('div', 'model-picker');
    picker.id = 'model-picker';

    const searchInput = document.createElement('input');
    searchInput.className = 'model-search';
    searchInput.placeholder = 'Search models...';
    searchInput.type = 'text';
    picker.appendChild(searchInput);

    const list = el('div', 'model-list');

    if (state.recentModels.length > 0) {
        const recentHeader = el('div', 'model-section-header');
        recentHeader.textContent = 'Recent';
        list.appendChild(recentHeader);

        for (const r of state.recentModels) {
            const full = state.availableModels.find(
                m => m.id === r.id && m.provider === r.provider
            );
            if (full) {
                list.appendChild(buildModelItem(full));
            }
        }

        const allHeader = el('div', 'model-section-header');
        allHeader.textContent = 'All Models';
        list.appendChild(allHeader);
    }

    for (const m of state.availableModels) {
        list.appendChild(buildModelItem(m));
    }
    picker.appendChild(list);

    const thinkingRow = el('div', 'thinking-chips');
    const thinkingLabel = el('span', 'thinking-label');
    thinkingLabel.textContent = 'Thinking:';
    thinkingRow.appendChild(thinkingLabel);
    const levels = ['off', 'minimal', 'low', 'medium', 'high'];
    for (const level of levels) {
        const chip = el('button', `thinking-chip${level === state.thinkingLevel ? ' active' : ''}`);
        chip.textContent = level.charAt(0).toUpperCase() + level.slice(1);
        chip.dataset.level = level;
        thinkingRow.appendChild(chip);
    }
    picker.appendChild(thinkingRow);

    container.appendChild(picker);

    searchInput.focus();

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        list.querySelectorAll('.model-item').forEach((item) => {
            const name = (item as HTMLElement).dataset.name ?? '';
            (item as HTMLElement).style.display = name.includes(q) ? '' : 'none';
        });
        list.querySelectorAll('.model-section-header').forEach((hdr) => {
            (hdr as HTMLElement).style.display = q ? 'none' : '';
        });
    });

    list.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.model-item') as HTMLElement | null;
        if (!item) return;
        const provider = item.dataset.provider!;
        const modelId = item.dataset.modelId!;
        vscode.postMessage({ type: 'setModel', provider, modelId });
        const matched = state.availableModels.find(m => m.id === modelId && m.provider === provider);
        if (matched) {
            state.model = { provider, id: modelId, name: matched.name ?? modelId };
            addToRecentModels(provider, modelId, matched.name ?? modelId);
        }
        updateFooterModel();
        closeModelPicker();
    });

    thinkingRow.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.thinking-chip') as HTMLElement | null;
        if (!chip) return;
        vscode.postMessage({ type: 'setThinkingLevel', level: chip.dataset.level! });
        thinkingRow.querySelectorAll('.thinking-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.thinkingLevel = chip.dataset.level;
    });

    setTimeout(() => {
        document.addEventListener('click', onClickOutsidePicker);
    }, 0);
}

function onClickOutsidePicker(e: MouseEvent): void {
    const picker = document.getElementById('model-picker');
    if (picker && !picker.contains(e.target as Node)) {
        closeModelPicker();
    }
}

function closeModelPicker(): void {
    document.getElementById('model-picker')?.remove();
    document.removeEventListener('click', onClickOutsidePicker);
}

function updateFooterModel(): void {
    const el = document.querySelector('.footer-model');
    if (el) {
        el.textContent = state.model?.name ?? state.model?.id ?? '';
    }
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

function updateStreamingUI(): void {
    const container = document.getElementById('streaming-message');
    if (!container) return;
    container.innerHTML = '';
}

// ── Events ──

function bindStableEvents(): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    const newTabBtn = document.getElementById('btn-new-tab');
    const sessionsBtn = document.getElementById('btn-sessions');
    const settingsBtn = document.getElementById('btn-settings');

    input?.addEventListener('keydown', (e) => {
        if (isSlashMenuVisible()) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                slashMenuIndex = Math.min(slashMenuIndex + 1, slashMenuItems.length - 1);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
                const menu = document.getElementById('slash-menu');
                if (menu) renderSlashMenu(menu);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectSlashItem(slashMenuIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideSlashMenu();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (state.isStreaming) {
                const text = input.value.trim();
                if (text) {
                    if (e.ctrlKey || e.metaKey) {
                        vscode.postMessage({ type: 'steer', text });
                        showSteerToast(text);
                    } else {
                        vscode.postMessage({ type: 'queueMessage', text });
                    }
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
        updateSlashMenu(input);
    });

    newTabBtn?.addEventListener('click', () => vscode.postMessage({ type: 'createTab' }));
    sessionsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'getSessions' }));
    settingsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
}

function bindTabEvents(): void {
    document.querySelectorAll('.tab').forEach((tabEl) => {
        tabEl.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.tab-close')) return;
            const tabId = (tabEl as HTMLElement).dataset.tabId;
            if (tabId && tabId !== state.activeTabId) {
                vscode.postMessage({ type: 'switchTab', tabId });
            }
        });
    });

    document.querySelectorAll('.tab-close').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tabId = (btn as HTMLElement).dataset.tabId;
            if (tabId) {
                vscode.postMessage({ type: 'closeTab', tabId });
            }
        });
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
    userHasScrolled = false;
    updateScrollButton();
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

// ── Slash command menu ──

let slashMenuIndex = 0;
let slashMenuItems: SkillInfo[] = [];

function updateSlashMenu(input: HTMLTextAreaElement): void {
    const menu = document.getElementById('slash-menu');
    if (!menu) return;

    const text = input.value;
    const cursorPos = input.selectionStart;

    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (!slashMatch || state.skills.length === 0) {
        hideSlashMenu();
        return;
    }

    const query = slashMatch[1].slice(1).toLowerCase();
    slashMenuItems = state.skills.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query)
    );

    if (slashMenuItems.length === 0) {
        hideSlashMenu();
        return;
    }

    slashMenuIndex = Math.min(slashMenuIndex, slashMenuItems.length - 1);
    renderSlashMenu(menu);
    menu.style.display = '';
}

function renderSlashMenu(menu: HTMLElement): void {
    menu.innerHTML = slashMenuItems.map((skill, i) => {
        const active = i === slashMenuIndex ? ' slash-item-active' : '';
        const desc = skill.description
            ? `<span class="slash-item-desc">${escHtml(skill.description)}</span>`
            : '';
        return `<div class="slash-item${active}" data-index="${i}">
            <span class="slash-item-name">/skill:${escHtml(skill.name)}</span>
            ${desc}
        </div>`;
    }).join('');

    menu.querySelectorAll('.slash-item').forEach((item) => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = parseInt((item as HTMLElement).dataset.index ?? '0', 10);
            selectSlashItem(idx);
        });
    });
}

function selectSlashItem(index: number): void {
    const input = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!input) return;

    const skill = slashMenuItems[index];
    if (!skill) return;

    const text = input.value;
    const cursorPos = input.selectionStart;
    const beforeCursor = text.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);

    if (slashMatch) {
        const matchStart = beforeCursor.length - slashMatch[1].length;
        const replacement = `/skill:${skill.name} `;
        input.value = text.slice(0, matchStart) + replacement + text.slice(cursorPos);
        const newPos = matchStart + replacement.length;
        input.setSelectionRange(newPos, newPos);
    }

    hideSlashMenu();
    input.focus();
}

function hideSlashMenu(): void {
    const menu = document.getElementById('slash-menu');
    if (menu) {
        menu.style.display = 'none';
        menu.innerHTML = '';
    }
    slashMenuItems = [];
    slashMenuIndex = 0;
}

function isSlashMenuVisible(): boolean {
    const menu = document.getElementById('slash-menu');
    return !!menu && menu.style.display !== 'none' && slashMenuItems.length > 0;
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

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimestamp(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildMessageFooter(msg: any, index: number): HTMLElement | null {
    const role = msg.role ?? 'unknown';
    if (role !== 'user' && role !== 'assistant') return null;

    const parts: string[] = [];

    const ts = msg.timestamp;
    if (ts) {
        parts.push(formatTimestamp(ts));
    }

    if (role === 'user') {
        // Show input tokens from the next assistant message's usage
        for (let j = index + 1; j < state.messages.length; j++) {
            const next = state.messages[j];
            if (next.role === 'assistant' && next.usage && next.usage.input > 0) {
                parts.push(`${next.usage.input.toLocaleString()} input tokens`);
                break;
            }
            if (next.role === 'user') break;
        }
    }

    if (role === 'assistant') {
        if (msg._messageEndTime && msg.timestamp) {
            const startMs = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
            const durationSec = (msg._messageEndTime - startMs) / 1000;
            const usage = msg.usage;
            if (usage && usage.output > 0 && durationSec > 0) {
                const tokPerSec = usage.output / durationSec;
                parts.push(`${tokPerSec.toFixed(1)} tok/s`);
            }
        }

        const usage = msg.usage;
        if (usage && usage.output > 0) {
            parts.push(`${usage.output.toLocaleString()} output tokens`);
        }
    }

    if (parts.length === 0) return null;

    const footer = el('div', 'message-footer');
    footer.textContent = parts.join(' · ');
    return footer;
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

let userHasScrolled = false;
let isProgrammaticScroll = false;

function scrollToBottom(force = false): void {
    if (userHasScrolled && !force) return;
    const messages = document.getElementById('messages');
    if (messages) {
        isProgrammaticScroll = true;
        messages.scrollTop = messages.scrollHeight;
    }
}

function isNearBottom(): boolean {
    const messages = document.getElementById('messages');
    if (!messages) return true;
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 50;
}

function updateScrollButton(): void {
    const btn = document.getElementById('btn-scroll-bottom');
    if (!btn) return;
    if (userHasScrolled) {
        btn.classList.add('visible');
    } else {
        btn.classList.remove('visible');
    }
}

function bindScrollListener(): void {
    const messages = document.getElementById('messages');
    if (!messages) return;

    // Detect user-initiated scroll intent immediately
    messages.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
            userHasScrolled = true;
            updateScrollButton();
        }
    }, { passive: true });

    messages.addEventListener('touchstart', () => {
        userHasScrolled = true;
        updateScrollButton();
    }, { passive: true });

    // The scroll event handles resetting when user reaches bottom
    messages.addEventListener('scroll', () => {
        if (isProgrammaticScroll) {
            isProgrammaticScroll = false;
            return;
        }
        if (isNearBottom()) {
            userHasScrolled = false;
        }
        updateScrollButton();
    });
}

// ── Init ──
render();

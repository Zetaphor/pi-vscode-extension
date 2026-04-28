import type { SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo } from '../shared/protocol';

declare function acquireVsCodeApi(): {
    postMessage(message: SettingsClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentSettings: SettingsData | null = null;
let loadedSkills: SkillInfo[] = [];

window.addEventListener('message', (event) => {
    const msg = event.data as SettingsServerMessage;
    switch (msg.type) {
        case 'settings':
            currentSettings = msg.data;
            render(msg.data);
            break;
        case 'settingChanged':
            if (currentSettings) {
                (currentSettings as any)[msg.key] = msg.value;
                render(currentSettings);
            }
            break;
        case 'skills':
            loadedSkills = msg.skills;
            renderSkillsSection();
            break;
        case 'error':
            showToast(msg.message, 'error');
            break;
    }
});

function render(data: SettingsData): void {
    const app = document.getElementById('settings-app')!;
    app.innerHTML = '';

    const container = el('div', 'settings-container');

    const header = el('div', 'settings-header');
    header.innerHTML = `<h1>Pi Agent Settings</h1>`;
    container.appendChild(header);

    container.appendChild(buildSection('API Connection', [
        buildSelect('apiProvider', 'Provider', data.apiProvider, [
            { value: '', label: 'Auto-detect' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'google', label: 'Google Gemini' },
            { value: 'deepseek', label: 'DeepSeek' },
        ], 'Select which AI provider to use. Leave on Auto-detect for automatic resolution.'),
        buildApiKeyField(data),
        buildTextInput('apiBaseUrl', 'API Base URL', data.apiBaseUrl,
            'Custom endpoint URL for proxies or self-hosted models. Leave empty for default.'),
        buildAuthIndicator(data.authMethod),
    ]));

    container.appendChild(buildSection('Default Model & Thinking', [
        buildTextInput('defaultModel', 'Default Model', data.defaultModel,
            'Model ID to use when starting new sessions (e.g. claude-sonnet-4-20250514). Leave empty for automatic.'),
        buildSelect('thinkingLevel', 'Default Thinking Level', data.thinkingLevel, [
            { value: 'off', label: 'Off' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ], 'How verbose the agent\'s chain-of-thought should be by default.'),
    ]));

    container.appendChild(buildSection('Tool Execution', [
        buildToggle('autoApproveTools', 'Auto-approve tool calls', data.autoApproveTools,
            'When enabled, the agent executes tools without asking for confirmation. When disabled, each tool call shows an inline approval card.'),
        buildTextarea('allowedTools', 'Allowed Tools', data.allowedTools.join(', '),
            'Comma-separated list of tool names to allow (e.g. read, grep, bash). Leave empty to allow all.'),
    ]));

    container.appendChild(buildSection('Session Behavior', [
        buildToggle('autoSaveSessions', 'Auto-save sessions', data.autoSaveSessions,
            'Automatically persist sessions after each turn.'),
        buildTextInput('sessionStoragePath', 'Session Storage Path', data.sessionStoragePath,
            'Custom path for session data. Leave empty for the default workspace .pi/ directory.'),
        buildRange('contextUsageWarningThreshold', 'Context Usage Warning', data.contextUsageWarningThreshold, 0, 100,
            `Warn when context usage exceeds ${data.contextUsageWarningThreshold}% of the context window.`),
    ]));

    const skillsSection = buildSection('Skills', [buildSkillsPlaceholder()]);
    skillsSection.id = 'skills-section';
    container.appendChild(skillsSection);

    container.appendChild(buildSection('Keyboard Shortcuts', [
        buildShortcutsInfo(),
    ]));

    app.appendChild(container);
    bindEvents();
    renderSkillsSection();
}

function buildSection(title: string, children: HTMLElement[]): HTMLElement {
    const section = el('div', 'settings-section');
    const heading = el('h2', 'section-title');
    heading.textContent = title;
    section.appendChild(heading);
    for (const child of children) {
        section.appendChild(child);
    }
    return section;
}

function buildSelect(key: string, label: string, value: string, options: { value: string; label: string }[], description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <select id="setting-${key}" class="setting-select" data-key="${key}">
            ${options.map(o => `<option value="${escHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
        </select>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextInput(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="${escHtml(description.split('.')[0])}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextarea(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="e.g. read, grep, bash">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildToggle(key: string, label: string, value: boolean, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${value ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escHtml(label)}</span>
            </label>
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildRange(key: string, label: string, value: number, min: number, max: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
            <span class="range-value" id="range-val-${key}">${value}%</span>
        </div>
        <input type="range" id="setting-${key}" class="setting-range" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildApiKeyField(data: SettingsData): HTMLElement {
    const row = el('div', 'setting-row');
    const provider = data.apiProvider || 'provider';

    if (data.apiKeySet) {
        row.innerHTML = `
            <div class="setting-label-row">
                <label>API Key</label>
                <span class="key-status set">Key stored</span>
            </div>
            <div class="api-key-actions">
                <button class="setting-btn secondary" id="btn-change-key">Change</button>
                <button class="setting-btn danger" id="btn-clear-key">Remove</button>
            </div>
            <p class="setting-description">API key is securely stored and never written to settings files.</p>
        `;
    } else {
        row.innerHTML = `
            <div class="setting-label-row">
                <label for="api-key-input">API Key</label>
                <span class="key-status unset">No key stored</span>
            </div>
            <div class="api-key-input-row">
                <input type="password" id="api-key-input" class="setting-input" placeholder="Enter your API key">
                <button class="setting-btn primary" id="btn-save-key">Save</button>
            </div>
            <p class="setting-description">Securely stored via VS Code SecretStorage. Never written to settings files.</p>
        `;
    }
    return row;
}

function buildAuthIndicator(method: SettingsData['authMethod']): HTMLElement {
    const row = el('div', 'setting-row auth-indicator');
    const labels: Record<string, string> = {
        env: 'Authenticated via environment variable',
        'pi-login': 'Authenticated via Pi CLI login (~/.pi/agent/)',
        manual: 'Authenticated via stored API key',
        none: 'No credentials detected',
    };
    const icons: Record<string, string> = {
        env: '&#10003;',
        'pi-login': '&#10003;',
        manual: '&#10003;',
        none: '&#10007;',
    };
    const cls = method === 'none' ? 'auth-none' : 'auth-ok';
    row.innerHTML = `
        <div class="auth-status ${cls}">
            <span class="auth-icon">${icons[method]}</span>
            <span>${labels[method]}</span>
        </div>
    `;
    return row;
}

function buildShortcutsInfo(): HTMLElement {
    const row = el('div', 'setting-row shortcuts-info');
    row.innerHTML = `
        <div class="shortcuts-list">
            <div class="shortcut-item"><kbd>Ctrl+Shift+L</kbd><span>Focus chat</span></div>
            <div class="shortcut-item"><kbd>Ctrl+Shift+N</kbd><span>New session</span></div>
            <div class="shortcut-item"><kbd>Escape</kbd><span>Stop generation</span></div>
        </div>
        <p class="setting-description">
            <a href="#" id="btn-open-keybindings">Open Keyboard Shortcuts editor</a> to customize.
        </p>
    `;
    return row;
}

function buildSkillsPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'skills-list';
    row.innerHTML = `<p class="setting-description">Loading skills...</p>`;
    return row;
}

function renderSkillsSection(): void {
    const container = document.getElementById('skills-list');
    if (!container) return;

    if (loadedSkills.length === 0) {
        container.innerHTML = `<p class="setting-description">No skills found. Place <code>SKILL.md</code> files in <code>~/.pi/agent/skills/</code> or <code>.pi/skills/</code> in your workspace.</p>`;
        return;
    }

    container.innerHTML = loadedSkills.map(skill => {
        const invocation = skill.disableModelInvocation
            ? '<span class="skill-badge">manual only</span>'
            : '';
        return `<div class="skill-card">
            <div class="skill-card-header">
                <span class="skill-card-name">/skill:${escHtml(skill.name)}</span>
                ${invocation}
            </div>
            ${skill.description ? `<p class="skill-card-desc">${escHtml(skill.description)}</p>` : ''}
            <p class="skill-card-path">${escHtml(skill.filePath)}</p>
            ${skill.source ? `<span class="skill-card-source">${escHtml(skill.source)}</span>` : ''}
        </div>`;
    }).join('');
}

function bindEvents(): void {
    document.querySelectorAll('.setting-select').forEach((select) => {
        select.addEventListener('change', () => {
            const key = (select as HTMLSelectElement).dataset.key!;
            const value = (select as HTMLSelectElement).value;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-input[data-key]').forEach((input) => {
        let debounce: ReturnType<typeof setTimeout>;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = (input as HTMLInputElement).dataset.key!;
                let value: any = (input as HTMLInputElement).value;
                if (key === 'allowedTools') {
                    value = value.split(',').map((s: string) => s.trim()).filter(Boolean);
                }
                vscode.postMessage({ type: 'updateSetting', key, value });
            }, 500);
        });
    });

    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const key = (cb as HTMLInputElement).dataset.key!;
            const value = (cb as HTMLInputElement).checked;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-range').forEach((range) => {
        range.addEventListener('input', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
        });
        range.addEventListener('change', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    const saveKeyBtn = document.getElementById('btn-save-key');
    saveKeyBtn?.addEventListener('click', () => {
        const input = document.getElementById('api-key-input') as HTMLInputElement;
        const key = input?.value?.trim();
        const provider = currentSettings?.apiProvider || '';
        if (!provider) {
            showToast('Select a provider first', 'error');
            return;
        }
        if (!key) {
            showToast('Enter an API key', 'error');
            return;
        }
        vscode.postMessage({ type: 'setApiKey', provider, key });
    });

    const changeKeyBtn = document.getElementById('btn-change-key');
    changeKeyBtn?.addEventListener('click', () => {
        if (currentSettings) {
            currentSettings.apiKeySet = false;
            render(currentSettings);
        }
    });

    const clearKeyBtn = document.getElementById('btn-clear-key');
    clearKeyBtn?.addEventListener('click', () => {
        const provider = currentSettings?.apiProvider || '';
        if (provider) {
            vscode.postMessage({ type: 'clearApiKey', provider });
        }
    });

    const keybindingsLink = document.getElementById('btn-open-keybindings');
    keybindingsLink?.addEventListener('click', (e) => {
        e.preventDefault();
    });
}

let toastTimeout: ReturnType<typeof setTimeout>;

function showToast(message: string, type: 'error' | 'info' = 'info'): void {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = el('div', 'toast');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} visible`;
    toast.textContent = message;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast!.classList.remove('visible'), 3000);
}

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

vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getSkills' });

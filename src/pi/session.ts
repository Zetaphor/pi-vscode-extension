import * as vscode from 'vscode';
import type { AgentSession, AgentSessionEvent, SessionManager, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { SerializedAgentState, ModelInfo, SessionInfo, ContextUsageInfo } from '../shared/protocol';
import { EventRouter } from './events';
import { getAuthStorage, disposeAuthStorage } from './auth';
import { getModelRegistry, getAvailableModels, findModel, disposeModelRegistry } from './models';

export class PiSessionManager {
    private _session: AgentSession | undefined;
    private _sessionManager: SessionManager | undefined;
    private _modelRegistry: ModelRegistry | undefined;
    private _unsubscribe: (() => void) | undefined;
    private _outputChannel: vscode.OutputChannel;
    readonly events = new EventRouter();

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
    }

    get session(): AgentSession | undefined {
        return this._session;
    }

    get isReady(): boolean {
        return this._session !== undefined;
    }

    async initialize(): Promise<void> {
        this._outputChannel.appendLine('Initializing Pi session...');
        const { createAgentSession, SessionManager: SM } = await import('@mariozechner/pi-coding-agent');

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const authStorage = await getAuthStorage();
        this._modelRegistry = await getModelRegistry();

        this._sessionManager = SM.create(cwd);

        const { session, modelFallbackMessage } = await createAgentSession({
            cwd,
            authStorage,
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
        });

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());

        if (modelFallbackMessage) {
            this._outputChannel.appendLine(`Model fallback: ${modelFallbackMessage}`);
        }

        const model = session.model;
        this._outputChannel.appendLine(
            `Pi session initialized. Model: ${model ? `${getProviderId(model)}/${model.id}` : 'none'}`
        );
    }

    async prompt(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.prompt(text);
    }

    async steer(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.steer(text);
    }

    async followUp(text: string): Promise<void> {
        if (!this._session) { throw new Error('Session not initialized'); }
        await this._session.followUp(text);
    }

    async abort(): Promise<void> {
        if (!this._session) { return; }
        await this._session.abort();
    }

    async setModel(provider: string, modelId: string): Promise<void> {
        if (!this._session || !this._modelRegistry) {
            throw new Error('Session not initialized');
        }
        const model = findModel(this._modelRegistry, provider, modelId);
        if (!model) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
        }
        await this._session.setModel(model);
    }

    setThinkingLevel(level: string): void {
        if (!this._session) { return; }
        this._session.setThinkingLevel(level as any);
    }

    cycleThinkingLevel(): string | undefined {
        if (!this._session) { return undefined; }
        return this._session.cycleThinkingLevel();
    }

    async newSession(): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const { SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        this._sessionManager = SM.create(cwd);

        const { session } = await createAgentSession({
            cwd,
            authStorage: await getAuthStorage(),
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
        });

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
    }

    async getSessions(): Promise<SessionInfo[]> {
        const { SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const sessions = await SM.list(cwd);
        return sessions.map((s: any) => ({
            id: s.id ?? s.sessionId ?? '',
            name: s.name ?? s.sessionName,
            path: s.path ?? s.filePath ?? '',
            lastModified: s.lastModified ?? s.modifiedAt,
        }));
    }

    async loadSession(sessionPath: string): Promise<void> {
        if (!this._session) { return; }
        this._unsubscribe?.();
        this._session.dispose();

        const { createAgentSession, SessionManager: SM } = await import('@mariozechner/pi-coding-agent');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        this._sessionManager = await SM.open(sessionPath, undefined);

        const { session } = await createAgentSession({
            cwd,
            authStorage: await getAuthStorage(),
            modelRegistry: this._modelRegistry,
            sessionManager: this._sessionManager,
        });

        this._session = session;
        this._unsubscribe = session.subscribe(this.events.asSessionListener());
    }

    getModels(): ModelInfo[] {
        if (!this._modelRegistry) { return []; }
        return getAvailableModels(this._modelRegistry);
    }

    getCurrentModel(): ModelInfo | undefined {
        const m = this._session?.model;
        if (!m) { return undefined; }
        return { provider: getProviderId(m), id: m.id, name: m.name };
    }

    getThinkingLevel(): string | undefined {
        return this._session?.thinkingLevel;
    }

    getActiveToolNames(): string[] {
        return this._session?.getActiveToolNames() ?? [];
    }

    getMessages(): any[] {
        return this._session?.state?.messages ?? [];
    }

    setMessages(msgs: any[]): void {
        if (this._session?.state) {
            this._session.state.messages = msgs;
        }
    }

    serializeState(): SerializedAgentState {
        const s = this._session;
        if (!s) {
            return {
                messages: [],
                isStreaming: false,
                tools: [],
            };
        }
        const model = s.model;
        return {
            messages: s.messages.map(safeSerialize),
            model: model ? { provider: getProviderId(model), id: model.id, name: model.name } : undefined,
            thinkingLevel: s.thinkingLevel,
            isStreaming: s.isStreaming,
            tools: s.getActiveToolNames(),
            sessionId: s.sessionId,
            sessionName: s.sessionName,
            contextUsage: this._getContextUsage(),
        };
    }

    private _getContextUsage(): ContextUsageInfo | undefined {
        const usage = this._session?.getContextUsage?.();
        if (!usage) { return undefined; }
        return {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
        };
    }

    async showModelPicker(): Promise<void> {
        const models = this.getModels();
        if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Check your Pi configuration.');
            return;
        }
        const items = models.map((m) => ({
            label: m.name ?? m.id,
            description: m.provider,
            model: m,
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a model',
        });
        if (pick) {
            await this.setModel(pick.model.provider, pick.model.id);
        }
    }

    async dispose(): Promise<void> {
        this._unsubscribe?.();
        this._session?.dispose();
        this._session = undefined;
        this.events.clear();
    }

    static async disposeGlobal(): Promise<void> {
        disposeAuthStorage();
        disposeModelRegistry();
    }
}

function getProviderId(model: any): string {
    return String(model.provider);
}

function safeSerialize(obj: any): any {
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch {
        return { _serializationFailed: true, type: obj?.type };
    }
}

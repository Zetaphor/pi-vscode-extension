import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { PiSessionManager } from '../pi/session';
import type { FileChangeInfo } from '../shared/protocol';
import type { CheckpointManager } from './checkpoint';
import { computeUnifiedDiff } from '../utils/diff';

interface PendingEdit {
    toolCallId: string;
    toolName: string;
    filePath: string;
    originalContent: string | null;
    turnIndex: number;
}

type FileChangeListener = (change: FileChangeInfo) => void;

export class DiffManager implements vscode.Disposable {
    private _session: PiSessionManager;
    private _checkpoint: CheckpointManager;
    private _pendingEdits = new Map<string, PendingEdit>();
    private _fileChanges: FileChangeInfo[] = [];
    private _originalContents = new Map<string, string | null>();
    private _unsubscribers: (() => void)[] = [];
    private _listeners: FileChangeListener[] = [];
    private _currentTurn = 0;

    constructor(session: PiSessionManager, checkpoint: CheckpointManager) {
        this._session = session;
        this._checkpoint = checkpoint;

        this._unsubscribers.push(
            session.events.on('tool_execution_start', (event) => {
                this._onToolStart(event as any);
            }),
            session.events.on('tool_execution_end', (event) => {
                this._onToolEnd(event as any);
            }),
        );
    }

    get fileChanges(): FileChangeInfo[] {
        return this._fileChanges;
    }

    setCurrentTurn(turn: number): void {
        this._currentTurn = turn;
    }

    onFileChange(listener: FileChangeListener): () => void {
        this._listeners.push(listener);
        return () => {
            const idx = this._listeners.indexOf(listener);
            if (idx >= 0) this._listeners.splice(idx, 1);
        };
    }

    private _emitFileChange(change: FileChangeInfo): void {
        for (const listener of this._listeners) {
            listener(change);
        }
    }

    private async _onToolStart(event: any): Promise<void> {
        const name = event.toolName;
        if (name !== 'edit' && name !== 'write') return;

        const filePath = event.args?.file_path ?? event.args?.path ?? '';
        if (!filePath) return;

        let originalContent: string | null = null;
        try {
            const absPath = this._resolveFilePath(filePath);
            const data = fs.readFileSync(absPath, 'utf-8');
            originalContent = data;
        } catch {
            // file doesn't exist yet
        }

        this._checkpoint.recordFileState(filePath, originalContent);

        const absPath = this._resolveFilePath(filePath);
        if (!this._originalContents.has(absPath)) {
            this._originalContents.set(absPath, originalContent);
        }

        this._pendingEdits.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: name,
            filePath,
            originalContent,
            turnIndex: this._currentTurn,
        });
    }

    private async _onToolEnd(event: any): Promise<void> {
        const pending = this._pendingEdits.get(event.toolCallId);
        if (!pending) return;
        this._pendingEdits.delete(event.toolCallId);

        if (event.isError) return;

        const absPath = this._resolveFilePath(pending.filePath);
        let newContent: string | null = null;
        try {
            newContent = fs.readFileSync(absPath, 'utf-8');
        } catch {
            return;
        }

        const isNew = pending.originalContent === null;
        let diffText = '';
        let addedLines = 0;
        let removedLines = 0;

        if (!isNew && pending.originalContent !== null) {
            const { diff, stats } = computeUnifiedDiff(
                pending.originalContent,
                newContent,
                pending.filePath,
            );
            diffText = diff;
            addedLines = stats.added;
            removedLines = stats.removed;
        } else {
            const lines = newContent.split('\n');
            addedLines = lines.length;
            diffText = lines.map(l => `+${l}`).join('\n');
        }

        const change: FileChangeInfo = {
            filePath: pending.filePath,
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            isNew,
            diff: diffText,
            addedLines,
            removedLines,
            turnIndex: pending.turnIndex,
        };

        this._fileChanges.push(change);
        this._emitFileChange(change);
    }

    async openDiff(filePath: string, toolCallId: string): Promise<void> {
        const absPath = this._resolveFilePath(filePath);
        const uri = vscode.Uri.file(absPath);
        const original = this._originalContents.get(absPath);

        if (original !== undefined && original !== null) {
            const diffProvider = this._getDiffContentProvider();
            const beforeUri = vscode.Uri.parse(
                `pi-diff:${filePath}?before=${encodeURIComponent(toolCallId)}`
            );
            diffProvider?.setContent(beforeUri, original);

            await vscode.commands.executeCommand(
                'vscode.diff',
                beforeUri,
                uri,
                `${path.basename(filePath)} (Pi edit)`,
                { preview: true },
            );
        } else {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* file may have been deleted */ }
        }
    }

    async undoFileChange(filePath: string, _toolCallId: string): Promise<void> {
        const absPath = this._resolveFilePath(filePath);
        const original = this._originalContents.get(absPath);
        if (original === undefined) return;

        try {
            if (original === null) {
                if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            } else {
                fs.writeFileSync(absPath, original, 'utf-8');
            }
        } catch { /* best effort */ }

        this._fileChanges = this._fileChanges.filter(c =>
            this._resolveFilePath(c.filePath) !== absPath
        );
        this._originalContents.delete(absPath);
    }

    async undoAllFileChanges(): Promise<void> {
        for (const [absPath, original] of this._originalContents) {
            try {
                if (original === null) {
                    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
                } else {
                    fs.writeFileSync(absPath, original, 'utf-8');
                }
            } catch { /* best effort */ }
        }
        this._fileChanges = [];
        this._originalContents.clear();
    }

    private _suspendedChanges: FileChangeInfo[] = [];
    private _suspendedOriginals = new Map<string, string | null>();

    suspendChangesAfter(turnIndex: number): void {
        this._suspendedChanges = this._fileChanges.filter(c => c.turnIndex > turnIndex);
        this._fileChanges = this._fileChanges.filter(c => c.turnIndex <= turnIndex);

        const remainingPaths = new Set(
            this._fileChanges.map(c => this._resolveFilePath(c.filePath))
        );
        for (const absPath of [...this._originalContents.keys()]) {
            if (!remainingPaths.has(absPath)) {
                this._suspendedOriginals.set(absPath, this._originalContents.get(absPath)!);
                this._originalContents.delete(absPath);
            }
        }
    }

    redoChanges(): void {
        for (const change of this._suspendedChanges) {
            this._fileChanges.push(change);
        }
        for (const [absPath, content] of this._suspendedOriginals) {
            if (!this._originalContents.has(absPath)) {
                this._originalContents.set(absPath, content);
            }
        }
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    discardSuspended(): void {
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
    }

    clearAll(): void {
        this._fileChanges = [];
        this._originalContents.clear();
        this._pendingEdits.clear();
        this._suspendedChanges = [];
        this._suspendedOriginals.clear();
        this._currentTurn = 0;
    }

    private _resolveFilePath(filePath: string): string {
        if (filePath.startsWith('~/') || filePath === '~') {
            const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
            filePath = path.join(home, filePath.slice(2));
        }
        if (path.isAbsolute(filePath)) return filePath;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root ? path.join(root, filePath) : path.resolve(filePath);
    }

    private _getDiffContentProvider(): DiffContentProvider | undefined {
        return DiffContentProvider.instance;
    }

    dispose(): void {
        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._pendingEdits.clear();
        this._listeners = [];
    }
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    static instance: DiffContentProvider | undefined;
    private _contents = new Map<string, string>();

    constructor() {
        DiffContentProvider.instance = this;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }

    setContent(uri: vscode.Uri, content: string): void {
        this._contents.set(uri.toString(), content);
    }
}

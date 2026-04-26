import * as vscode from 'vscode';
import { PiSessionManager } from './pi/session';
import { SidebarProvider } from './providers/sidebar';
import { StatusBarManager } from './providers/status-bar';
import { TerminalManager } from './providers/terminal';
import { DiffManager, DiffContentProvider } from './providers/diff';
import { CheckpointManager } from './providers/checkpoint';

let piSession: PiSessionManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Pi Agent');
    outputChannel.appendLine('Pi Agent extension activating...');

    try {
        piSession = new PiSessionManager(outputChannel);
        await piSession.initialize();

        const diffContentProvider = new DiffContentProvider();
        const checkpointManager = new CheckpointManager();
        const statusBar = new StatusBarManager(piSession);
        const terminalManager = new TerminalManager(piSession);
        const diffManager = new DiffManager(piSession, checkpointManager);
        const sidebarProvider = new SidebarProvider(
            context.extensionUri, piSession, diffManager, checkpointManager, outputChannel,
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('pi-agent.chat', sidebarProvider),
            vscode.workspace.registerTextDocumentContentProvider('pi-diff', diffContentProvider),
            statusBar,
            terminalManager,
            diffManager,
            checkpointManager,
            outputChannel,

            vscode.commands.registerCommand('pi-agent.newChat', async () => {
                await piSession?.newSession();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.abort', async () => {
                await piSession?.abort();
            }),

            vscode.commands.registerCommand('pi-agent.selectModel', async () => {
                await piSession?.showModelPicker();
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.toggleThinking', async () => {
                const level = piSession?.cycleThinkingLevel();
                if (level) {
                    vscode.window.showInformationMessage(`Thinking level: ${level}`);
                }
                sidebarProvider.sendStateSync();
            }),

            vscode.commands.registerCommand('pi-agent.focusChat', () => {
                vscode.commands.executeCommand('pi-agent.chat.focus');
            }),
        );

        outputChannel.appendLine('Pi Agent extension activated.');
    } catch (err: any) {
        outputChannel.appendLine(`Failed to activate: ${err.message}`);
        vscode.window.showErrorMessage(`Pi Agent failed to activate: ${err.message}`);
    }
}

export async function deactivate() {
    await piSession?.dispose();
    await PiSessionManager.disposeGlobal();
}

import * as vscode from 'vscode';
import type { SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo } from '../shared/protocol';

const API_KEY_PREFIX = 'pi-agent.apiKey.';

export class SettingsPanel {
    private static _instance: SettingsPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _extensionUri: vscode.Uri;
    private _secrets: vscode.SecretStorage;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._secrets = secrets;

        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            (msg: SettingsClientMessage) => this._handleMessage(msg),
            undefined,
            this._disposables,
        );

        this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);

        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('pi-agent')) {
                this._sendSettings();
            }
        });
        this._disposables.push(configListener);
    }

    static show(extensionUri: vscode.Uri, secrets: vscode.SecretStorage): void {
        if (SettingsPanel._instance) {
            SettingsPanel._instance._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'pi-agent.settings',
            'Pi Agent Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        SettingsPanel._instance = new SettingsPanel(panel, extensionUri, secrets);
    }

    private async _handleMessage(msg: SettingsClientMessage): Promise<void> {
        try {
            switch (msg.type) {
                case 'getSettings':
                    await this._sendSettings();
                    break;
                case 'updateSetting':
                    await this._updateSetting(msg.key, msg.value);
                    break;
                case 'setApiKey':
                    await this._secrets.store(`${API_KEY_PREFIX}${msg.provider}`, msg.key);
                    await this._sendSettings();
                    break;
                case 'clearApiKey':
                    await this._secrets.delete(`${API_KEY_PREFIX}${msg.provider}`);
                    await this._sendSettings();
                    break;
                case 'getSkills':
                    await this._sendSkills();
                    break;
            }
        } catch (err: any) {
            this._post({ type: 'error', message: err.message ?? String(err) });
        }
    }

    private async _updateSetting(key: string, value: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-agent');
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    private async _sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration('pi-agent');
        const provider = config.get<string>('apiProvider', '');

        let apiKeySet = false;
        if (provider) {
            const stored = await this._secrets.get(`${API_KEY_PREFIX}${provider}`);
            apiKeySet = !!stored;
        }

        const authMethod = this._detectAuthMethod(provider, apiKeySet);

        const data: SettingsData = {
            apiProvider: provider,
            apiBaseUrl: config.get<string>('apiBaseUrl', ''),
            apiKeySet,
            authMethod,
            defaultModel: config.get<string>('defaultModel', ''),
            thinkingLevel: config.get<string>('thinkingLevel', 'off'),
            autoApproveTools: config.get<boolean>('autoApproveTools', false),
            allowedTools: config.get<string[]>('allowedTools', []),
            autoSaveSessions: config.get<boolean>('autoSaveSessions', true),
            sessionStoragePath: config.get<string>('sessionStoragePath', ''),
            contextUsageWarningThreshold: config.get<number>('contextUsageWarningThreshold', 80),
        };

        this._post({ type: 'settings', data });
    }

    private async _sendSkills(): Promise<void> {
        try {
            const { loadSkills } = await import('@mariozechner/pi-coding-agent');
            const path = require('path');
            const os = require('os');
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            const agentDir = path.join(os.homedir(), '.pi', 'agent');
            const { skills: rawSkills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
            const skills: SkillInfo[] = rawSkills.map((s: any) => ({
                name: s.name,
                description: s.description ?? '',
                filePath: s.filePath ?? '',
                source: s.sourceInfo?.source ?? '',
                disableModelInvocation: s.disableModelInvocation ?? false,
            }));
            this._post({ type: 'skills', skills });
        } catch {
            this._post({ type: 'skills', skills: [] });
        }
    }

    private _detectAuthMethod(provider: string, hasManualKey: boolean): SettingsData['authMethod'] {
        if (hasManualKey) return 'manual';

        const envVarMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            google: 'GEMINI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
        };

        if (provider && envVarMap[provider] && process.env[envVarMap[provider]]) {
            return 'env';
        }

        const fs = require('fs');
        const path = require('path');
        const piAuthDir = path.join(require('os').homedir(), '.pi', 'agent');
        if (fs.existsSync(piAuthDir)) {
            return 'pi-login';
        }

        return 'none';
    }

    private _post(message: SettingsServerMessage): void {
        this._panel.webview.postMessage(message);
    }

    private _dispose(): void {
        SettingsPanel._instance = undefined;
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    private _getHtml(): string {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'out', 'webview', 'settings.js'),
        );
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'styles', 'settings.css'),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Pi Agent Settings</title>
</head>
<body>
    <div id="settings-app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

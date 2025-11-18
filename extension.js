// O módulo 'vscode' contém a API de extensibilidade do VS Code
const vscode = require('vscode');
// O módulo 'child_process' do Node.js para executar comandos do shell
const { spawn } = require('child_process');
// Módulo para encontrar portas livres de forma confiável
const getPort = require('get-port');
// Módulo 'util' para "promisify", que transforma funções de callback em Promises
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/** @type {vscode.TreeDataProvider<SshHost>} */
let sshHostProvider;

/** @type {vscode.Disposable[]} */
let activeTunnelProcesses = [];

let activeHost = null; // Guarda o host que está sendo mapeado

/**
 * Função principal que é chamada quando a extensão é ativada.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('A extensão "docker-port-mapper" está ativa.');

    sshHostProvider = new SshHostProvider();
    vscode.window.createTreeView('portmapper-hosts-view', { treeDataProvider: sshHostProvider });

    // Registra o comando para iniciar o mapeamento
    let startCommand = vscode.commands.registerCommand('docker-port-mapper.start', startMapping);

    // Registra o comando para parar todos os túneis
    let stopCommand = vscode.commands.registerCommand('docker-port-mapper.stop', stopAllTunnels);

    // Registra o comando para editar o arquivo de configuração SSH
    let editSshConfigCommand = vscode.commands.registerCommand('docker-port-mapper.editSshConfig', async () => {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(sshConfigPath));
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Não foi possível abrir o arquivo de configuração SSH: ${sshConfigPath}`);
        }
    });

    // Adiciona os comandos ao contexto para que sejam descartados na desativação
    context.subscriptions.push(startCommand, stopCommand, editSshConfigCommand);
}

async function startMapping(sshHostItem) {
    const sshHost = sshHostItem.label;

    if (activeHost === sshHost) {
        vscode.window.showInformationMessage(`O mapeamento para '${sshHost}' já está ativo.`);
        return;
    }

    // Encerra túneis antigos antes de começar um novo mapeamento
    await stopAllTunnels();

    activeHost = sshHost;
    sshHostProvider.setActiveHost(sshHost);

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Mapeando portas do host '${sshHost}'...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            vscode.window.showInformationMessage("Operação de mapeamento cancelada.");
            stopAllTunnels();
        });

        try {
            // Obtém as portas do Docker no host remoto
            progress.report({ message: 'Buscando portas de containers Docker...' });
            const dockerPortsCmd = `ssh ${sshHost} "docker ps --format '{{.Ports}}'"`;
            const { stdout: services } = await execPromise(dockerPortsCmd);

            if (!services) {
                vscode.window.showInformationMessage(`Nenhum serviço Docker com portas publicadas encontrado em '${sshHost}'.`);
                activeHost = null;
                sshHostProvider.setActiveHost(null);
                return;
            }

            // Processa cada porta e cria o túnel
            const portMappings = services.split('\n').filter(line => line.includes('->'));
            let createdTunnelsCount = 0;

            for (const line of portMappings) {
                const mappings = line.split(',');
                for (const mapping of mappings) {
                    // Regex para capturar a porta exposta (ex: 0.0.0.0:80->80/tcp)
                    const match = mapping.match(/(\d+)\/tcp/);
                    if (match && match[1]) {
                        const remotePort = parseInt(match[1], 10);

                        // Encontra uma porta local livre a partir de 38000
                        const localPort = await getPort({ port: getPort.makeRange(38000, 39000) });

                        progress.report({ message: `Mapeando ${remotePort} -> ${localPort}...` });

                        const tunnelArgs = ['-fN', '-L', `${localPort}:127.0.0.1:${remotePort}`, sshHost];
                        const tunnelProcess = spawn('ssh', tunnelArgs);

                        const description = `localhost:${localPort} -> ${sshHost}:${remotePort}`;
                        console.log(`Túnel criado: ${description} (PID: ${tunnelProcess.pid})`);

                        // Guarda o processo para poder encerrá-lo depois
                        activeTunnelProcesses.push({
                            process: tunnelProcess,
                            description: description
                        });

                        createdTunnelsCount++;
                    }
                }
            }

            if (createdTunnelsCount > 0) {
                vscode.window.showInformationMessage(`${createdTunnelsCount} túneis criados para '${sshHost}'.`);
            } else {
                vscode.window.showWarningMessage(`Nenhuma porta válida para mapear foi encontrada em '${sshHost}'.`);
                activeHost = null;
                sshHostProvider.setActiveHost(null);
            }

        } catch (error) {
            console.error(error);
            vscode.window.showErrorMessage(`Falha ao mapear portas para '${sshHost}': ${error.stderr || error.message}`);
            await stopAllTunnels(); // Limpa tudo em caso de erro
        }
    });
}

// Função para encerrar todos os processos SSH criados pela extensão
async function stopAllTunnels(showNotification = true) {
    if (showNotification) {
        vscode.window.showInformationMessage('Procurando e encerrando túneis SSH existentes...');
    }

    try {
        // Comando para encontrar PIDs de túneis SSH criados por esta extensão.
        // O 'grep -v grep' é crucial para evitar que o próprio processo grep seja encontrado.
        const cmd = `ps -eo pid,command | grep 'ssh -fN -L' | grep -v grep | awk '{print $1}'`;
        const { stdout } = await execPromise(cmd);

        const pidsToKill = stdout.trim().split('\n').filter(pid => pid);

        if (pidsToKill.length > 0) {
            await execPromise(`kill ${pidsToKill.join(' ')}`);
            if (showNotification) {
                vscode.window.showInformationMessage(`${pidsToKill.length} túnel(s) foram encerrados.`);
            }
        } else if (showNotification) {
            vscode.window.showInformationMessage('Nenhum túnel ativo encontrado para encerrar.');
        }
    } catch (error) {
        // Ignora o erro se o grep não encontrar nada (ele retorna um status de erro)
        console.log('Nenhum processo de túnel SSH correspondente encontrado para encerrar.');
    }

    activeTunnelProcesses = []; // Limpa o array de qualquer maneira
    activeHost = null;
    if (sshHostProvider) {
        sshHostProvider.setActiveHost(null);
    }
    return Promise.resolve();
}

class SshHostProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.activeHost = null;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    setActiveHost(hostLabel) {
        this.activeHost = hostLabel;
        this.refresh();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (element) {
            return [];
        }

        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            const content = await fs.readFile(sshConfigPath, 'utf-8');
            const hosts = content.split('\n')
                .map(line => line.trim())
                .filter(line => line.toLowerCase().startsWith('host '))
                .map(line => line.substring(5).trim())
                .filter(host => host !== '*' && !host.includes(' ')); // Filtra hosts genéricos

            return hosts.map(host => new SshHost(host, this.activeHost === host));
        } catch (error) {
            // Se o arquivo não existir, não é um erro fatal.
            if (error.code === 'ENOENT') {
                vscode.window.showInformationMessage("Arquivo ~/.ssh/config não encontrado. Crie um para listar os hosts.");
                return [];
            }
            vscode.window.showErrorMessage("Erro ao ler o arquivo ~/.ssh/config.");
            return [];
        }
    }
}

class SshHost extends vscode.TreeItem {
    constructor(label, isActive) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.isActive = isActive;
        this.contextValue = 'sshHost';

        this.command = {
            command: 'docker-port-mapper.start',
            title: 'Iniciar Mapeamento',
            arguments: [this]
        };

        if (isActive) {
            this.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('debugIcon.startForeground'));
            this.description = "Ativo";
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-outline');
        }
    }
}

// Esta função é chamada quando a extensão é desativada (ex: ao fechar o VS Code)
function deactivate() {
    console.log('Desativando a extensão e limpando os túneis SSH.');
    return stopAllTunnels();
}

module.exports = {
    activate,
    deactivate
}
// O módulo 'vscode' contém a API de extensibilidade do VS Code
const vscode = require('vscode');
// O módulo 'child_process' do Node.js para executar comandos do shell
const { Client } = require('ssh2');
// Módulo para encontrar portas livres de forma confiável
const getPort = require('get-port');
// Módulo 'util' para "promisify", que transforma funções de callback em Promises
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/** @type {SshHostProvider} */
let sshHostProvider;

/** @type {vscode.TreeView<vscode.TreeItem>} */
let treeView; // Referência para a TreeView para podermos atualizar a badge

/** @type {any[]} */
let activeSshConnections = []; // Guarda as conexões SSH e servidores de túnel para poder encerrá-los

let activeHost = null; // Guarda o host que está sendo mapeado

/**
 * Função principal que é chamada quando a extensão é ativada.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('A extensão "docker-port-mapper" está ativa.');

    sshHostProvider = new SshHostProvider();
    treeView = vscode.window.createTreeView('portmapper-hosts-view', { treeDataProvider: sshHostProvider });

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
    context.subscriptions.push(treeView, startCommand, stopCommand, editSshConfigCommand);
}

/**
 * Atualiza a badge da view com o número de conexões ativas.
 * @param {number} count O número para exibir na badge.
 */
function updateBadgeCount(count) {
    if (treeView) {
        treeView.badge = { value: count, tooltip: `${count} túneis ativos` };
    }
}

async function startMapping(sshHostItem) {
    const sshHost = sshHostItem.label;

    if (activeHost === sshHost) {
        vscode.window.showInformationMessage(`Parando mapeamento para '${sshHost}'.`);
        await stopAllTunnels();
        return; // Ação concluída, saímos da função.
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
            // Resolve a configuração SSH real (hostname e user) usando o comando nativo do ssh
            progress.report({ message: 'Resolvendo configuração SSH...' });
            const { stdout: sshConfigOutput } = await execPromise(`ssh -G ${sshHost}`);
            const userMatch = sshConfigOutput.match(/^user\s+(.*)$/m);
            const hostnameMatch = sshConfigOutput.match(/^hostname\s+(.*)$/m);
            const portMatch = sshConfigOutput.match(/^port\s+(\d+)$/m);
            const identityFileMatch = sshConfigOutput.match(/^identityfile\s+(.*)$/m);

            const connectionDetails = {
                host: hostnameMatch ? hostnameMatch[1] : sshHost,
                username: userMatch ? userMatch[1] : undefined,
                port: portMatch ? parseInt(portMatch[1], 10) : 22 // Default para porta 22 se não especificado
            };

            if (identityFileMatch && identityFileMatch[1]) {
                let identityFilePath = identityFileMatch[1];
                // Expande o '~' para o diretório home do usuário
                if (identityFilePath.startsWith('~')) {
                    identityFilePath = path.join(os.homedir(), identityFilePath.substring(1));
                }
                connectionDetails.privateKey = await fs.readFile(identityFilePath);
            }

            if (!connectionDetails.username) {
                throw new Error(`Não foi possível encontrar o 'User' para o host '${sshHost}' no seu arquivo ~/.ssh/config.`);
            }

            // Obtém as portas do Docker no host remoto
            progress.report({ message: `Conectando a ${sshHost} e buscando portas...` });
            const services = await getDockerPorts(connectionDetails);

            if (!services) {
                vscode.window.showInformationMessage(`Nenhum serviço Docker com portas publicadas encontrado em '${sshHost}'.`);
                activeHost = null;
                sshHostProvider.setActiveHost(null);
                sshHostProvider.updateTunnels([]);
                return;
            }

            // Processa cada porta e cria o túnel
            const portMappings = services.split('\n').filter(line => line.includes('->'));
            let createdTunnelsCount = 0;

            const tunnelDescriptions = [];
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

                        await createTunnel(connectionDetails, localPort, remotePort);

                        const description = `localhost:${localPort} -> ${remotePort}`;
                        tunnelDescriptions.push(description);

            updateBadgeCount(activeSshConnections.length);
                        createdTunnelsCount++;
                    }
                }
            }

            sshHostProvider.updateTunnels(tunnelDescriptions);

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
    if (activeSshConnections.length > 0) {
        if (showNotification) {
            vscode.window.showInformationMessage(`Encerrando ${activeSshConnections.length} conexões/túneis...`);
        }
        activeSshConnections.forEach(conn => {
            if (conn.server) conn.server.close();
            if (conn.client) conn.client.end();
        });
        activeSshConnections = [];
    }

    updateBadgeCount(0); // Zera o contador da badge
    activeHost = null;
    if (sshHostProvider) {
        sshHostProvider.setActiveHost(null);
        sshHostProvider.updateTunnels([]);
    }
    return Promise.resolve();
}

/**
 * Conecta via SSH e obtém as portas do Docker.
 * @param {{host: string, username: string}} connectionDetails
 * @returns {Promise<string>}
 */
function getDockerPorts(connectionDetails) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("docker ps --format '{{.Ports}}'", (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                let services = '';
                stream.on('data', (data) => {
                    services += data.toString();
                }).on('close', () => {
                    conn.end();
                    resolve(services);
                });
            });
        }).on('error', (err) => {
            reject(err);
        }).connect({
            ...connectionDetails,
            // A biblioteca ssh2 lê automaticamente o ~/.ssh/config!
        });
    });
}

/**
 * Cria um único túnel SSH usando ssh2.
 * @param {{host: string, username: string}} connectionDetails
 * @param {number} localPort 
 * @param {number} remotePort 
 */
function createTunnel(connectionDetails, localPort, remotePort) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Inicia um servidor local que escuta na localPort
            const server = require('net').createServer((sock) => {
                // Quando alguém conecta no nosso servidor local, pedimos à conexão SSH para abrir um canal para o host remoto
                conn.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, upstream) => {
                    if (err) {
                        sock.end();
                        return console.error('SSH forwardOut error:', err);
                    }
                    // Conecta (pipe) o socket local com o canal remoto
                    sock.pipe(upstream).pipe(sock);
                });
            }).listen(localPort, '127.0.0.1', () => {
                console.log(`Túnel criado: localhost:${localPort} -> ${connectionDetails.host}:${remotePort}`);
                // Guarda a referência do servidor e do cliente ssh para poder fechar depois
                activeSshConnections.push({ server: server, client: conn });
                resolve();
            });

            server.on('error', (err) => {
                conn.end();
                reject(err);
            });

        }).on('error', (err) => {
            reject(err);
        }).connect({
            ...connectionDetails
        });
    });
}

class SshHostProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.activeHost = null;
        this.activeTunnels = [];
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    setActiveHost(hostLabel) {
        this.activeHost = hostLabel;
        this.refresh();
    }

    updateTunnels(tunnelDescriptions) {
        this.activeTunnels = tunnelDescriptions;
        this.refresh();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (element) {
            // Se o elemento é um SshHost e é o ativo, retorna a lista de túneis
            if (element instanceof SshHost && element.isActive) {
                return this.activeTunnels.map(desc => new TunnelItem(desc));
            }
            // Itens de túnel não têm filhos
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
        super(label, isActive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.isActive = isActive;
        this.contextValue = 'sshHost';

        this.command = {
            command: 'docker-port-mapper.start', // O mesmo comando agora serve para ligar/desligar
            title: isActive ? 'Parar Mapeamento' : 'Iniciar Mapeamento',
            arguments: [this]
        };

        if (isActive) {
            this.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('debugIcon.startForeground'));
            this.description = "Ativo";
        } else {
            this.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('debugIcon.stopForeground'));
        }
    }
}

class TunnelItem extends vscode.TreeItem {
    constructor(label) {
        // O label completo é "localhost:38000 -> 8080"
        // Vamos separar para poder construir o comando e o novo label
        const parts = label.split(' -> ');
        const localPart = parts[0]; // "localhost:38000"
        const remotePart = parts[1]; // "8080"

        // O label é o texto completo. A API não suporta ícones no meio do label.
        super(`${localPart}🌐 -> ${remotePart}`, vscode.TreeItemCollapsibleState.None);

        this.contextValue = 'tunnelItem';
        this.iconPath = new vscode.ThemeIcon('plug');

        this.command = {
            command: 'vscode.open',
            title: 'Abrir no Navegador',
            arguments: [vscode.Uri.parse(`http://${localPart}`)]
        };
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
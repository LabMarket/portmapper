# Docker Port Mapper

Uma extensão do VS Code para mapear portas de containers Docker de um host remoto para a sua máquina local.

## Funcionalidades

*   Inicia túneis SSH para portas de containers Docker em um host remoto.
*   Encerra automaticamente os túneis quando o VS Code é fechado.
*   Comandos para iniciar e parar os mapeamentos manualmente.

## Como Usar

1.  Abra a Paleta de Comandos (`Cmd+Shift+P` ou `Ctrl+Shift+P`).
2.  Execute `Docker Port Mapper: Iniciar Mapeamento`.
3.  Insira o nome do host SSH configurado no seu `~/.ssh/config`.
4.  Para encerrar, execute `Docker Port Mapper: Parar Todos os Mapeamentos`.
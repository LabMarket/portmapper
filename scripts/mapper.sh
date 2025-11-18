#!/bin/bash

# Verifica se foram fornecidos os argumentos necessários
if [ "$#" -ne 1 ]; then
    echo "Uso: $0 <ssh_config>"
    exit 1
fi

# Definir a configuração do SSH a partir do primeiro argumento
ssh_config="$1"

# Obtendo o nome do host remoto a partir da configuração SSH
remote_host=$(ssh -G "$ssh_config" | grep hostname | awk '{print $2}')

# Função para encerrar túneis SSH anteriores
function kill_existing_tunnels {
    echo "Encerrando túneis SSH anteriores..."
    # Encontra os PIDs dos túneis SSH criados por este script e os encerra.
    # O 'grep -v grep' é para evitar que o próprio processo grep seja encontrado.
    pids_to_kill=$(ps aux | grep 'ssh -fN -L' | grep -v grep | awk '{print $2}')
    
    if [ -n "$pids_to_kill" ]; then
        kill $pids_to_kill 2>/dev/null
        echo "Túneis encerrados."
    else
        echo "Nenhum túnel ativo encontrado."
    fi
}

# Encerrar túneis existentes
kill_existing_tunnels

# Iniciar o proxy SOCKS com a configuração fornecida
ssh -D 1080 "$ssh_config" &

# Esperar um momento para garantir que o proxy esteja ativo
sleep 2

# Variável para controlar a porta local inicial
next_local_port=38000

# Obter as portas e endereços dos serviços do Docker
services=$(ssh "$ssh_config" "docker ps --format '{{.Ports}}'")

# Encontrar portas livres começando de 38000
for service in $services; do
    if [[ $service == *"->"* ]]; then
        # Processar múltiplas entradas separadas por vírgula
        IFS=',' read -ra mappings <<< "$service"
        
        for mapping in "${mappings[@]}"; do
            remote_port=$(echo "$mapping" | awk -F '->' '{print $2}' | awk '{print $1}' | cut -d '/' -f 1 | tr -d ' ')
            remote_address="127.0.0.1" # O túnel deve sempre apontar para localhost no servidor remoto

            if [[ -n "$remote_port" && -n "$remote_address" ]]; then
                # Encontrar uma porta local livre, começando de $next_local_port
                local_port=0
                for port in $(seq $next_local_port 39000); do
                    if ! lsof -i -P -n | grep -q ":$port (LISTEN)"; then
                        local_port=$port
                        next_local_port=$((port + 1))
                        break
                    fi
                done

                # Criar o túnel SSH
                ssh -fN -L "$local_port:$remote_address:$remote_port" "$ssh_config" &
                echo "Túnel criado: localhost:$local_port -> $remote_address:$remote_port"
            else
                echo "Porta ou endereço remoto não encontrados para o serviço: $mapping"
            fi
        done
    fi
done

#!/usr/bin/env bash
# Bootstrap minimo de VPS (Ubuntu 24.04 ARM64/aarch64, Oracle Cloud Always Free)
# para o teste de validacao (Passo 0). Objetivo: deixar a maquina pronta pra
# rodar `npm run operar` uma vez e comparar a taxa de ERRO_CAPTCHA contra a
# baseline local. Nao e a Fase 1 completa (sem PM2, sem Nginx, sem hardening
# de SSH) — isso vem depois, se o teste passar.
#
# ============================================================================
# ANTES DE RODAR ESTE SCRIPT — criar a instancia no console da Oracle Cloud:
# ============================================================================
#   1. Home Region da conta precisa ser "South America East (Sao Paulo)"
#      (isso e' escolhido na criacao da conta e NAO da pra trocar depois —
#      se sua conta ja existe com outra home region, o Always Free ARM so
#      pode ser criado na regiao que voce escolheu la atras).
#   2. Compute > Instances > Create Instance
#        - Image and shape > Image: "Canonical Ubuntu" 24.04, variante
#          **aarch64** (nao a amd64/x86_64 — e' a build ARM).
#        - Shape: clique "Change shape" > Ampere > VM.Standard.A1.Flex >
#          2 OCPU / 12 GB RAM (dentro da cota Always Free).
#        - Add SSH keys: cole sua chave publica (ou gere um par ali mesmo
#          e baixe a privada — sem isso nao tem como entrar depois).
#        - Networking: manter "Assign a public IPv4 address" marcado.
#   3. GOTCHA especifico da Oracle: o firewall de rede (Security List/NSG da
#      VCN) bloqueia tudo por padrao, so libera porta 22. Isso e' uma camada
#      SEPARADA do firewall do proprio Linux (ufw/iptables) — liberar so no
#      SO nao basta. Pra esse teste (so SSH) nao precisa mexer em nada, mas
#      quando formos expor o painel (Fase 1, portas 80/443), tem que liberar
#      ingress na Security List da VCN alem de qualquer regra no ufw.
#   4. Erro comum: "Out of host capacity" ao criar a instancia Ampere A1.
#      E' a Oracle recusando por falta de capacidade fisica no shape
#      gratuito — nao e' erro seu. Tentar de novo (as vezes muda de
#      Availability Domain) costuma resolver em minutos a poucas horas.
#   5. Login inicial e' com o usuario "ubuntu" (imagem Canonical), nao root
#      nem "opc" (esse e' so pra imagem Oracle Linux):
#        ssh -i /caminho/da/chave_privada ubuntu@<IP_DA_VPS>
#      Rode este script depois de logar como "ubuntu".
# ============================================================================

set -euo pipefail

echo "== Atualizando sistema =="
sudo apt-get update -y
sudo apt-get upgrade -y

echo "== Instalando Node.js 20 =="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== Criando usuario de aplicacao (nao rodar como root) =="
if ! id -u inpi >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash inpi
fi

echo "== Preparando diretorio da aplicacao =="
sudo mkdir -p /opt/inpi
sudo chown inpi:inpi /opt/inpi

echo "== Node/npm instalados =="
node -v
npm -v

cat <<'EOF'

Proximo passo (fora deste script, como usuario "inpi"):

  1. Copiar o codigo da sua maquina para a VPS (rode isso na SUA maquina, nao na VPS):
       rsync -avz --exclude node_modules --exclude data --exclude output --exclude .env \
         ./ inpi@<IP_DA_VPS>:/opt/inpi/

  2. Criar o .env DIRETO na VPS (nunca copiar por scp do jeito normal em texto puro
     por canais inseguros — use scp mesmo, mas via SSH que ja e criptografado, ok):
       scp .env inpi@<IP_DA_VPS>:/opt/inpi/.env

  3. Na VPS, como usuario inpi, dentro de /opt/inpi:
       npm ci
       npx playwright install --with-deps chromium
       npm run migrate
       npm run operar     # roda um lote pequeno de teste

  4. Comparar CAPTCHA: depois do lote rodar, na VPS:
       sqlite3 data/inpi.db "SELECT COUNT(*) FROM eventos WHERE resultado = 'ERRO_CAPTCHA';"

     Se vier > 0 e a mesma planilha/lote local historicamente dava 0,
     isso confirma o risco de IP de datacenter — pare e reavalie antes
     de seguir pra Fase 1 (VPN, PM2, Nginx etc.).
EOF

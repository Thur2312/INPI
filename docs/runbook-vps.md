# Runbook GRU 3020 — Deploy em VPS

> Handoff técnico: leia isto antes do código. Cobre a decisão de arquitetura, os riscos mapeados e o passo a passo pra colocar a automação numa VPS.

**Status atual:** arquitetura decidida · Passo 0 (validação) a rodar · Fase 1 (produção) bloqueada até o Passo 0 passar.

---

## 0. Contexto

O projeto automatiza a emissão de GRUs do serviço 3020 no INPI via Playwright, com fila e controle de concorrência em SQLite (`better-sqlite3`). Hoje roda só localmente. O objetivo desta fase é colocar isso numa VPS de forma segura, **sem reescrever a arquitetura**.

| Peça | Onde | Estado |
|---|---|---|
| Automação (Playwright + fila) | `src/orchestrator/main.ts`, `src/inpi/adapter.ts` | Funciona local. Nunca testada em IP de datacenter. |
| Painel (monitoramento + relatório) | `src/dashboard/servidor.ts`, `app.js` | Funciona, mas **sem autenticação** — inclui endpoint mutável de retomada. |
| Banco | `src/db/connection.ts` | SQLite em arquivo — correto para 1 máquina, não é gap a resolver agora. |

## 1. Decisão de arquitetura (já fechada — não reabrir sem novo motivo)

**VPS única, PM2, painel protegido por Tailscale.**

Foi cogitado migrar o painel para Next.js/Vercel com Supabase (Postgres + Storage + Auth), mantendo a VPS só para a automação. Descartado por dois motivos:

- **Tempo.** O híbrido exige reescrever o painel inteiro, criar um motor de sincronização SQLite→Postgres e configurar um projeto novo. Tailscale resolve o problema real (painel exposto) em ~30 minutos, sem tocar no código atual.
- **LGPD em aberto.** `titular_documento` é CPF/CNPJ do cliente. Botar isso trafegando por um provedor terceiro (mesmo com banco em São Paulo) é decisão de governança, não técnica — não deve ser tomada sob pressão de prazo.

Se isso for reconsiderado no futuro, a Fase 2 (§5) fica como plano B, não como próximo passo.

## 2. Riscos mapeados

- **Painel sem autenticação.** `servidor.ts:30` tem endpoint mutável de retomada de operação. Sem Tailscale na frente, qualquer um com o IP pode consultar dados e acionar retomada.
- **IP de datacenter pode acionar CAPTCHA no INPI.** A automação hoje roda de IP residencial. WAFs de sites governamentais costumam reagir diferente a IP de nuvem. Isso não foi testado — é exatamente o que o Passo 0 existe para responder.
- **Painel não cobre o ciclo completo.** Hoje é só monitoramento/retomada/relatório — não tem upload de planilha nem controle completo pela UI. Fora de escopo aqui; ver Fase 2.

## 3. Passo 0 — validar antes de investir

Se isto falhar, **pare** e volte a discutir arquitetura antes de seguir para a Fase 1.

### 3.1 Criar conta Oracle Cloud

1. [oracle.com/cloud/free](https://www.oracle.com/cloud/free) → *Start for free* → e-mail e país → confirmar e-mail (link expira em 30 min).
2. Senha + nome da conta cloud.
3. **Home Region = "Brazil East (São Paulo)".** Isso é definitivo — não muda depois. Erra aqui, a única saída é criar outra conta.
4. Verificação por SMS + cartão (antifraude, não cobra nada no Always Free).

### 3.2 Gerar sua própria chave SSH

Cada dev usa a própria chave — não reaproveitar a de outra pessoa.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "inpi-vps"
```

### 3.3 Criar a instância

**Compute → Instances → Create Instance:**

- Image: Canonical Ubuntu 24.04, variante **aarch64** (ARM, não x86_64)
- Shape: "Change shape" → Ampere → `VM.Standard.A1.Flex` → 2 OCPU / 12 GB RAM
- Add SSH keys: colar o conteúdo de `id_ed25519.pub` gerado no passo anterior
- Networking: manter "Assign a public IPv4 address" marcado

> **Gotchas específicos da Oracle:** erro `Out of host capacity` ao criar não é erro seu — é falta de capacidade no shape gratuito; tentar de novo (às vezes trocando o Availability Domain) resolve. Login inicial é como usuário `ubuntu`, nunca `root` nem `opc`. E o firewall de rede (Security List/NSG da VCN) é **separado** do firewall do Linux — liberar só no `ufw` não expõe porta nenhuma pra fora.

### 3.4 Bootstrap + deploy do código

Script já pronto no repo: [`scripts/vps-bootstrap.sh`](../scripts/vps-bootstrap.sh).

```bash
scp -i ~/.ssh/id_ed25519 scripts/vps-bootstrap.sh ubuntu@<IP_DA_VPS>:~/
ssh -i ~/.ssh/id_ed25519 ubuntu@<IP_DA_VPS> "bash vps-bootstrap.sh"
```

Depois, **da sua máquina**, leva o código e o `.env` — sempre por SSH direto, nunca por e-mail/chat/repositório:

```bash
rsync -avz --exclude node_modules --exclude data --exclude output --exclude .env \
  -e "ssh -i ~/.ssh/id_ed25519" \
  ./ ubuntu@<IP_DA_VPS>:/opt/inpi/

scp -i ~/.ssh/id_ed25519 .env ubuntu@<IP_DA_VPS>:/opt/inpi/.env
ssh -i ~/.ssh/id_ed25519 ubuntu@<IP_DA_VPS> "sudo chown -R inpi:inpi /opt/inpi"
```

### 3.5 Rodar o lote de teste e comparar CAPTCHA

Como usuário `inpi`, dentro de `/opt/inpi`:

```bash
npm ci
npx playwright install --with-deps chromium
npm run migrate
npm run operar
```

Depois, contar ocorrências de CAPTCHA:

```bash
sqlite3 data/inpi.db "SELECT COUNT(*) FROM eventos WHERE resultado = 'ERRO_CAPTCHA';"
```

> **Critério de decisão:** a baseline de "zero CAPTCHA" vem de um comentário em `src/inpi/selectors.ts:100` (até 18/08/2026, rodando local) — **não é um número medido em banco**, é indicativo. Se a VPS gerar `ERRO_CAPTCHA` de forma recorrente, pare aqui. Não seguir para a Fase 1 sem alinhar de novo — nesse cenário a arquitetura de IP de datacenter precisa ser repensada (proxy residencial, ou manter a automação na máquina da cliente).

## 4. Fase 1 — produção mínima

Só começa depois do Passo 0 passar. Nada disto existe ainda — é o que falta construir.

- [ ] **PM2** com `ecosystem.config.js` rodando dois processos: `npm run operar` e `npm run dashboard`, com restart automático em falha.
- [ ] **Tailscale** instalado na VPS e no notebook da cliente — o painel escuta só na interface Tailscale, nunca na pública. Decisão já tomada no lugar de VPN genérica/Nginx/Basic Auth.
- [ ] **Hardening de SSH**: desabilitar login root, autenticação só por chave (sem senha), `fail2ban`.
- [ ] `DB_PATH` e `OUTPUT_DIR` apontando para disco persistente da VPS (já é o padrão do `.env`, só confirmar que o disco é persistente no plano contratado).
- [ ] **Backup externo** (fora da VPS — S3, outro servidor) do arquivo SQLite e da pasta de output, com **teste de restore** — backup que nunca foi restaurado não é backup confirmado.

## 5. Fase 2 — plano B, não o próximo passo

Registrado para não ser redescutido do zero se a pergunta voltar.

Se no futuro o cenário mudar — mais de um operador, necessidade real de acesso multiusuário, ou a questão de LGPD for respondida com aval formal — a evolução natural é:

- Supabase Postgres espelhando `processos`/`eventos` (SQLite continua sendo a verdade durante a execução; sincronização periódica, nunca escrita direta da automação no Postgres — a automação não pode depender de rede externa no meio do ciclo).
- Supabase Storage para os PDFs de guia, no lugar de `OUTPUT_DIR` local.
- Painel reescrito em Next.js no Vercel, com Supabase Auth — login de cliente/operador.
- Controle remoto (iniciar/pausar/retomar) via tabela `comandos` que a automação consulta por polling — mantém a VPS sem nenhuma porta de entrada exposta, nem para controle.

---

*Runbook interno — Horizon LTDA · inpi-gru-3020 · atualizar este documento se a arquitetura mudar, não criar um segundo.*

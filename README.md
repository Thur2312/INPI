# Sistema de emissão automatizada de GRU 3020 (INPI)

Automatiza a emissão de guias GRU do serviço 3020 (trâmite prioritário de marcas) no sistema do INPI: importa uma planilha de requerimentos, espera a cota abrir, emite as guias via Playwright com fila e controle de concorrência em SQLite, e expõe os boletos para os clientes acompanharem.

## Peças do sistema

| Peça | Comando | O que faz |
|---|---|---|
| Importação de planilha | `npm run importar -- <arquivo>` | Valida e carrega requerimentos (CSV/XLSX) no banco. |
| Automação (emissão real) | `npm run operar` / `npm run operar -- --dry-run --limite=N` | Login, espera a cota abrir, emite as GRUs. `--dry-run` para antes de gerar o boleto — não gera nada real. |
| Painel interno (operador) | `npm run dashboard` (porta 3000) | Monitoramento, importação, iniciar/parar a operação, relatórios. Interface com a marca Revollution. |
| Portal do cliente | `npm run portal-cliente` (porta 3001) | Cliente loga por CNPJ/CPF e vê/baixa só os próprios boletos; admin vê tudo via Basic Auth. Front-end estático (`src/portalCliente/public`) servido pelo mesmo processo — sem dependência externa (Vercel etc.). |

Configuração em `.env` (copie de `.env.example`). Detalhes de deploy em VPS: `docs/runbook-vps.md`. Roteiro de teste manual: `docs/checklist-teste.md`.

## Estado em produção (28/08/2026)

Rodando numa VPS Hostinger (Ubuntu 24.04, PM2 + systemd, firewall restrito, SSH só por chave, fail2ban). Painel e portal do cliente publicados via Nginx + HTTPS (Let's Encrypt).

- **Passo 0 validado**: login no INPI a partir de IP de datacenter, sem CAPTCHA, em múltiplas tentativas.
- **Emissão real de ponta a ponta já foi feita** (clique em "Gerar boleto" + download do PDF, cobrança real de R$445,00) — validou o fluxo completo pela primeira vez antes do dia 01/09.
- `DASHBOARD_SENHA` e `PORTAL_CLIENTE_ADMIN_SENHA` configuradas.
- Cron agendado pra 10h (horário de Brasília) do dia 01/09 rodando a operação real.

## O que falta

### Bloqueante para operar a planilha real (dia 01/09)

- [ ] **A categoria "plataforma de mercado virtual" ainda não abriu no INPI** (aviso do cliente: abre 01/09). Sem ela, a fila real fica em `AGUARDANDO_ABERTURA` esperando o verificador. O monitor de categoria nova (`verificadorAbertura.ts` + migração `003_alerta_categoria.sql`) já avisa no painel se o texto não bater, em vez de travar silenciosamente — decisão de qual opção é a certa continua sempre humana.
- [ ] Planilha definitiva com os requerimentos reais ainda não foi importada em produção — importar só depois de confirmada.

### Portal do cliente

- [x] Front-end existe (`src/portalCliente/public`), com a identidade visual da Revollution.
- [x] Isolamento por cliente confirmado: a busca do PDF exige `id` **e** `titular_documento` batendo — testado ao vivo e coberto por testes automatizados.
- [ ] **Login só por CNPJ/CPF, sem segunda camada** — decisão aceita para o caso de uso atual, mas vale reconsiderar se o portal crescer (mais clientes, dado mais sensível exposto).

### Painel interno / operação

- [ ] Itens em aberto no `docs/checklist-teste.md`: confirmar `objeto_peticao` exato de cada categoria antes de rodar em massa, decidir se a cota está mesmo aberta antes de cada rodada.
- [ ] **Tailscale** ainda não configurado — o painel interno (porta 3000) não é exposto publicamente até lá; hoje só é alcançável por túnel SSH.
- [ ] **Backup externo** (fora da VPS) do SQLite e do output nunca foi testado com restore de verdade.

### Menor prioridade

- [ ] `scripts/gerarPlanilhaModelo.mjs` está com 2 erros de lint pré-existentes (`URL`/`console` não declarados no ambiente ESLint do projeto) — não afeta a execução, só o `npm run lint`.

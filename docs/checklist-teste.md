# Checklist — antes de testar de verdade

> Rascunho de apoio para a primeira rodada de testes reais do painel + automação. Atualizar conforme o que for descoberto no teste.

## 1. Ambiente

- [x] Chromium do Playwright instalado (`npx playwright install --with-deps chromium`, se ainda não tiver rodado numa máquina nova).
- [x] `.env` com `INPI_USUARIO`/`INPI_SENHA` reais configurado.
- [ ] `DASHBOARD_SENHA` definida no `.env` (mín. 8 caracteres) — sem isso o painel fica sem autenticação própria.

## 2. Dados de teste (planilha)

Planilha CSV/XLSX com pelo menos 1 linha real — o sistema busca o cliente de verdade no INPI, então:

- [ ] `titular_documento`: CPF/CNPJ de um cliente **já cadastrado no INPI** (senão dá `ERRO_CLIENTE_NAO_ENCONTRADO`).
- [ ] `numero_processo`: número de processo real (9 dígitos), de preferência um "descartável" para teste.
- [ ] `objeto_peticao`: confirmar o **texto exato** que aparece hoje no dropdown do INPI — o código usa `"TPH"` como placeholder nos testes, não é garantido ser o texto real de produção.
- `cliente`, `titular_nome`, `prioridade`, `protocolos_ja_utilizados`, `fila`: podem ficar em branco/default.

## 3. Modo ensaio vs. operação real

⚠️ **O painel (botão "Iniciar operação") hoje só roda no modo real.** O modo ensaio (login → busca cliente → preenche tudo → para antes de "Gerar boleto", sem gerar guia nem cobrar) só existe via terminal:

```bash
npm run operar -- --dry-run --limite=3
```

Rodar pelo terminal em modo ensaio primeiro é o caminho mais seguro antes de usar o painel em modo real.

*(Pendente decidir: adicionar um checkbox "modo ensaio" no formulário do painel, para não depender do terminal nesse passo.)*

## 4. Decisões que só o time sabe

- [ ] A cota do INPI está aberta agora, ou o teste vai ser fora da janela? Fora da janela dá para testar login/busca/planilha, mas não a emissão completa (fica em `AGUARDANDO_ABERTURA`).
- [ ] `VALOR_ESPERADO_GRU` no `.env` (padrão `445.00`) está com o valor vigente da GRU 3020? Se estiver desatualizado, o sistema barra com `ERRO_VALOR_INESPERADO` (seguro, mas trava o teste).

## 5. Roteiro sugerido

1. `npm run operar -- --dry-run --limite=1` pelo terminal primeiro — mais seguro, sem cobrança.
2. Se passar limpo: testar pelo painel — importar planilha → conferir resumo → iniciar operação real com 1 processo só.
3. Acompanhar o log ao vivo e a tabela do painel durante a execução.

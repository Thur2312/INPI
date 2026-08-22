-- numero_processo é o número oficial do processo administrativo no INPI:
-- não pode haver duas linhas *elegíveis para emissão* com o mesmo número
-- na mesma operação. Sem isso, reimportar a mesma planilha (ou uma
-- planilha atualizada que repete uma linha) criaria dois registros para o
-- mesmo processo — cada um reivindicável e emissível de forma
-- independente pela fila, o que geraria duas GRUs pagas para o mesmo
-- processo administrativo.
--
-- É um índice PARCIAL, não sobre a tabela inteira: PENDENCIA_DADOS e
-- PENDENCIA_LIMITE são exatamente os status que `validarLinhas` usa para
-- registrar duplicidade (dentro do lote ou contra o banco) — essas linhas
-- precisam poder coexistir com numero_processo repetido, só para constar
-- no relatório; elas nunca passam por `moverValidadosParaAguardandoAbertura`
-- e portanto nunca chegam à fila. O índice cobre todos os status que
-- *podem* chegar lá (inclui EMISSAO_INCERTA: mesmo sem `AGUARDANDO_ABERTURA`,
-- pode representar uma guia já emitida no INPI).
CREATE UNIQUE INDEX idx_processos_numero_processo_unico
  ON processos (numero_processo)
  WHERE status NOT IN ('PENDENCIA_DADOS', 'PENDENCIA_LIMITE');

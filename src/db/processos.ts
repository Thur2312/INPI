import type Database from 'better-sqlite3';
import type { Processo } from '../domain/types.js';
import type { LinhaProcessada } from '../validation/validador.js';

interface LinhaProcessoRow {
  id: number;
  posicao: number;
  fila: string;
  cliente: string | null;
  titular_documento: string;
  titular_nome: string | null;
  numero_processo: string;
  objeto_peticao: string;
  prioridade: number | null;
  protocolos_ja_utilizados: number;
  status: string;
  worker: string | null;
  tentativas: number;
  nosso_numero: string | null;
  codigo_gru: string | null;
  valor_gru: string | null;
  caminho_pdf: string | null;
  erro_tipo: string | null;
  erro_mensagem: string | null;
  caminho_screenshot: string | null;
  iniciado_em: string | null;
  concluido_em: string | null;
  criado_em: string;
  atualizado_em: string;
}

function paraDominio(row: LinhaProcessoRow): Processo {
  return {
    id: row.id,
    posicao: row.posicao,
    fila: row.fila as Processo['fila'],
    cliente: row.cliente,
    titularDocumento: row.titular_documento,
    titularNome: row.titular_nome,
    numeroProcesso: row.numero_processo,
    objetoPeticao: row.objeto_peticao,
    prioridade: row.prioridade,
    protocolosJaUtilizados: row.protocolos_ja_utilizados,
    status: row.status as Processo['status'],
    worker: row.worker,
    tentativas: row.tentativas,
    nossoNumero: row.nosso_numero,
    codigoGru: row.codigo_gru,
    valorGru: row.valor_gru,
    caminhoPdf: row.caminho_pdf,
    erroTipo: row.erro_tipo,
    erroMensagem: row.erro_mensagem,
    caminhoScreenshot: row.caminho_screenshot,
    iniciadoEm: row.iniciado_em,
    concluidoEm: row.concluido_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

/**
 * Insere todas as linhas já validadas em uma única transação. Linhas
 * `PENDENCIA_*` entram no banco normalmente — elas fazem parte do
 * relatório e podem ser resolvidas manualmente depois, não são descartadas.
 */
export function inserirProcessos(db: Database.Database, linhas: LinhaProcessada[]): number {
  const stmt = db.prepare(`
    INSERT INTO processos (
      posicao, fila, cliente, titular_documento, titular_nome,
      numero_processo, objeto_peticao, prioridade, protocolos_ja_utilizados,
      status, erro_mensagem
    ) VALUES (
      @posicao, @fila, @cliente, @titularDocumento, @titularNome,
      @numeroProcesso, @objetoPeticao, @prioridade, @protocolosJaUtilizados,
      @status, @erroMensagem
    )
  `);

  const inserirTodos = db.transaction((itens: LinhaProcessada[]) => {
    for (const item of itens) {
      stmt.run(item);
    }
  });

  inserirTodos(linhas);
  return linhas.length;
}

export function buscarProcessoPorId(db: Database.Database, id: number): Processo | undefined {
  const row = db.prepare('SELECT * FROM processos WHERE id = ?').get(id) as
    LinhaProcessoRow | undefined;
  return row ? paraDominio(row) : undefined;
}

export function listarProcessosPorStatus(db: Database.Database, status: string): Processo[] {
  const rows = db
    .prepare('SELECT * FROM processos WHERE status = ? ORDER BY posicao ASC')
    .all(status) as LinhaProcessoRow[];
  return rows.map(paraDominio);
}

/**
 * Move todo processo VALIDADO para AGUARDANDO_ABERTURA — o próximo passo do
 * fluxo é apenas esperar o verificador de cota liberar a operação, não uma
 * validação adicional.
 */
export function moverValidadosParaAguardandoAbertura(db: Database.Database): number {
  const info = db
    .prepare(
      `
      UPDATE processos
      SET status = 'AGUARDANDO_ABERTURA', atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'VALIDADO'
    `,
    )
    .run();
  return info.changes;
}

/**
 * Marca o processo como EMISSAO_INCERTA — chamado *antes* do clique
 * irreversível em "Gerar boleto" (ver `emitirGru`'s `antesDeConfirmar`).
 * Escrita síncrona: por ser better-sqlite3, isso já está commitado no
 * banco antes do clique sequer acontecer, então qualquer falha depois
 * disso (timeout, sessão caindo, o worker inteiro morrendo) encontra o
 * processo já marcado — nunca mais reivindicável via `AGUARDANDO_ABERTURA`.
 */
export function marcarComoEmissaoIncerta(
  db: Database.Database,
  processoId: number,
  mensagem: string,
): void {
  db.prepare(
    `
    UPDATE processos
    SET status = 'EMISSAO_INCERTA', erro_tipo = 'EMISSAO_INCERTA', erro_mensagem = @mensagem,
        worker = NULL, atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
  `,
  ).run({ id: processoId, mensagem });
}

export function contarPorStatus(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) as total FROM processos GROUP BY status')
    .all() as { status: string; total: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

export interface ResultadoEmissaoParaSalvar {
  nossoNumero: string;
  codigoGru: string;
  valorGru: string;
  caminhoPdf: string | null;
}

/** Registra a emissão bem-sucedida. Idempotente: sobrescrever com os mesmos dados não tem efeito colateral. */
export function marcarComoEmitida(
  db: Database.Database,
  processoId: number,
  resultado: ResultadoEmissaoParaSalvar,
): void {
  db.prepare(
    `
    UPDATE processos
    SET status = 'GRU_EMITIDA', nosso_numero = @nossoNumero, codigo_gru = @codigoGru,
        valor_gru = @valorGru, caminho_pdf = @caminhoPdf, worker = NULL,
        concluido_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
  `,
  ).run({ id: processoId, ...resultado });
}

/**
 * Falha definitiva: não adianta retentar (dado ruim) ou as tentativas se
 * esgotaram. `statusFinal` é o próprio tipo do erro (ex.:
 * `ERRO_CLIENTE_NAO_ENCONTRADO`), então o relatório final sabe exatamente
 * por que cada processo não saiu.
 */
export function marcarComoDefinitivo(
  db: Database.Database,
  processoId: number,
  statusFinal: string,
  mensagem: string,
  caminhoScreenshot: string | null,
): void {
  db.prepare(
    `
    UPDATE processos
    SET status = @statusFinal, erro_tipo = @statusFinal, erro_mensagem = @mensagem,
        caminho_screenshot = @caminhoScreenshot, worker = NULL,
        concluido_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
  `,
  ).run({ id: processoId, statusFinal, mensagem, caminhoScreenshot });
}

/**
 * Usado pelo watcher de órfãos/fila: `AGUARDANDO_ABERTURA` (ainda na fila)
 * ou `GRU_EM_PROCESSAMENTO` (sendo trabalhado agora) contam como pendente;
 * qualquer outro status é terminal. Quando isso for `false`, a fila
 * acabou de verdade e o worker pode encerrar em vez de ficar esperando.
 */
/**
 * Objeto da petição a monitorar no verificador de abertura. Na prática
 * desta operação todos os processos usam a mesma modalidade; se a
 * planilha importada tiver mais de um valor distinto, avisa e usa o
 * primeiro por posição — um lote misto precisaria de mais de um
 * verificador, fora do escopo desta função.
 */
export function obterObjetoPeticaoPrincipal(
  db: Database.Database,
): { texto: string; valoresDistintos: string[] } | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT objeto_peticao FROM processos WHERE status = 'AGUARDANDO_ABERTURA' ORDER BY objeto_peticao`,
    )
    .all() as { objeto_peticao: string }[];

  if (rows.length === 0) return null;

  const primeiro = db
    .prepare(
      `SELECT objeto_peticao FROM processos WHERE status = 'AGUARDANDO_ABERTURA' ORDER BY posicao ASC LIMIT 1`,
    )
    .get() as { objeto_peticao: string };

  return {
    texto: primeiro.objeto_peticao,
    valoresDistintos: rows.map((r) => r.objeto_peticao),
  };
}

export function existemProcessosPendentes(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM processos WHERE status IN ('AGUARDANDO_ABERTURA', 'GRU_EM_PROCESSAMENTO')`,
    )
    .get() as { total: number };
  return row.total > 0;
}

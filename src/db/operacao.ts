import type Database from 'better-sqlite3';
import type { Operacao } from '../domain/types.js';

interface OperacaoRow {
  status: string;
  motivo: string | null;
  objeto_peticao_value: string | null;
  pausada_em: string | null;
  retomada_em: string | null;
  atualizado_em: string;
  alerta_categoria_opcoes: string | null;
  alerta_categoria_em: string | null;
}

function paraDominio(row: OperacaoRow): Operacao {
  return {
    status: row.status as Operacao['status'],
    motivo: row.motivo,
    objetoPeticaoValue: row.objeto_peticao_value,
    pausadaEm: row.pausada_em,
    retomadaEm: row.retomada_em,
    atualizadoEm: row.atualizado_em,
    alertaCategoriaOpcoes: row.alerta_categoria_opcoes
      ? (JSON.parse(row.alerta_categoria_opcoes) as string[])
      : null,
    alertaCategoriaEm: row.alerta_categoria_em,
  };
}

export function obterOperacao(db: Database.Database): Operacao {
  const row = db.prepare('SELECT * FROM operacao WHERE id = 1').get() as OperacaoRow;
  return paraDominio(row);
}

/** Chamado pelo verificador único de cota quando a modalidade alvo aparece no dropdown. */
export function liberarOperacao(db: Database.Database, objetoPeticaoValue: string): void {
  db.prepare(
    `
    UPDATE operacao
    SET status = 'RODANDO', objeto_peticao_value = @valor, motivo = NULL,
        alerta_categoria_opcoes = NULL, alerta_categoria_em = NULL,
        retomada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run({ valor: objetoPeticaoValue });
}

/**
 * Registra, para o painel, que opções novas apareceram no dropdown de
 * objeto da petição sem bater com o texto configurado — ver
 * `verificarAbertura`. Não muda `status`/`motivo`: aquele semáforo
 * controla se os workers reivindicam da fila, e continuar
 * `AGUARDANDO_ABERTURA` normalmente aqui é o correto (a cota pode ter
 * aberto outra categoria, não necessariamente a certa). Decisão de qual
 * categoria é a certa fica sempre com um humano.
 */
export function registrarAlertaCategoria(db: Database.Database, opcoesNovas: readonly string[]): void {
  db.prepare(
    `
    UPDATE operacao
    SET alerta_categoria_opcoes = @opcoes,
        alerta_categoria_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run({ opcoes: JSON.stringify(opcoesNovas) });
}

/** Descarta o alerta de categoria nova — usado quando um humano já viu e decidiu o que fazer. */
export function limparAlertaCategoria(db: Database.Database): void {
  db.prepare(
    `
    UPDATE operacao
    SET alerta_categoria_opcoes = NULL, alerta_categoria_em = NULL,
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run();
}

/**
 * Pausa a operação inteira (todos os workers param de reivindicar novos
 * itens). Usado para `ERRO_OBJETO_INDISPONIVEL` — é um problema da
 * operação, não de um processo específico, e travar a fila inteira evita
 * queimar tentativas de 350 processos e esvaziar a reserva à toa.
 */
export function pausarOperacao(db: Database.Database, motivo: string): void {
  db.prepare(
    `
    UPDATE operacao
    SET status = 'PAUSADA', motivo = @motivo,
        pausada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run({ motivo });
}

export function retomarOperacao(db: Database.Database): void {
  db.prepare(
    `
    UPDATE operacao
    SET status = 'RODANDO', motivo = NULL,
        retomada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run();
}

import type Database from 'better-sqlite3';
import type { Operacao } from '../domain/types.js';

interface OperacaoRow {
  status: string;
  motivo: string | null;
  objeto_peticao_value: string | null;
  pausada_em: string | null;
  retomada_em: string | null;
  atualizado_em: string;
}

function paraDominio(row: OperacaoRow): Operacao {
  return {
    status: row.status as Operacao['status'],
    motivo: row.motivo,
    objetoPeticaoValue: row.objeto_peticao_value,
    pausadaEm: row.pausada_em,
    retomadaEm: row.retomada_em,
    atualizadoEm: row.atualizado_em,
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
        retomada_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `,
  ).run({ valor: objetoPeticaoValue });
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

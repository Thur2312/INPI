import type Database from 'better-sqlite3';
import type { ResultadoEvento } from '../domain/types.js';

export interface NovoEvento {
  processoId: number;
  etapa: string;
  acao: string;
  resultado: ResultadoEvento;
  mensagem?: string | null;
  duracaoMs?: number | null;
}

/** Insere um evento de auditoria. Tabela é append-only — nunca UPDATE/DELETE aqui. */
export function registrarEvento(db: Database.Database, evento: NovoEvento): void {
  db.prepare(
    `
    INSERT INTO eventos (processo_id, etapa, acao, resultado, mensagem, duracao_ms)
    VALUES (@processoId, @etapa, @acao, @resultado, @mensagem, @duracaoMs)
  `,
  ).run({
    processoId: evento.processoId,
    etapa: evento.etapa,
    acao: evento.acao,
    resultado: evento.resultado,
    mensagem: evento.mensagem ?? null,
    duracaoMs: evento.duracaoMs ?? null,
  });
}

import type Database from 'better-sqlite3';
import type { Processo } from '../domain/types.js';
import { registrarEvento } from './eventos.js';
import { buscarProcessoPorId } from './processos.js';

/**
 * Reivindica o próximo processo disponível para um worker, de forma
 * atômica: SELECT + UPDATE acontecem dentro da mesma transação `IMMEDIATE`.
 *
 * Por que `IMMEDIATE` e não o `BEGIN` (DEFERRED) padrão: uma transação
 * deferred só vira "de escrita" no primeiro INSERT/UPDATE, então dois
 * workers podem entrar na transação, ambos fazerem o mesmo SELECT (lock de
 * leitura, que coexiste), e só então colidir no UPDATE — um deles toma
 * SQLITE_BUSY *depois* de já ter decidido qual linha reivindicar,
 * abrindo uma janela de corrida. `IMMEDIATE` pega o lock de escrita já na
 * abertura da transação: o segundo worker fica bloqueado (até
 * `busy_timeout`) antes mesmo de rodar o SELECT, então nunca vê a mesma
 * linha livre que o primeiro acabou de reivindicar.
 *
 * Prioridade: PRINCIPAL antes de RESERVA, sempre por `posicao` (ordem de
 * protocolo). RESERVA só é considerada quando não sobra nenhum item
 * AGUARDANDO_ABERTURA na PRINCIPAL — o que ativa a reserva tanto quando a
 * principal termina quanto quando ela fica sem itens por falhas
 * definitivas, sem precisar de um gatilho separado.
 */
export function reivindicarProximo(db: Database.Database, workerId: string): Processo | null {
  const transacao = db.transaction((worker: string): number | null => {
    const operacao = db.prepare('SELECT status FROM operacao WHERE id = 1').get() as {
      status: string;
    };
    if (operacao.status !== 'RODANDO') {
      return null;
    }

    const proximo =
      (db
        .prepare(
          `SELECT id FROM processos WHERE status = 'AGUARDANDO_ABERTURA' AND fila = 'PRINCIPAL' ORDER BY posicao ASC LIMIT 1`,
        )
        .get() as { id: number } | undefined) ??
      (db
        .prepare(
          `SELECT id FROM processos WHERE status = 'AGUARDANDO_ABERTURA' AND fila = 'RESERVA' ORDER BY posicao ASC LIMIT 1`,
        )
        .get() as { id: number } | undefined);

    if (!proximo) {
      return null;
    }

    db.prepare(
      `
      UPDATE processos
      SET status = 'GRU_EM_PROCESSAMENTO', worker = @worker, tentativas = tentativas + 1,
          iniciado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id
    `,
    ).run({ worker, id: proximo.id });

    return proximo.id;
  });

  const id = transacao.immediate(workerId);
  if (id === null) return null;

  const processo = buscarProcessoPorId(db, id);
  registrarEvento(db, {
    processoId: id,
    etapa: 'FILA',
    acao: 'REIVINDICAR',
    resultado: 'INFO',
    mensagem: `reivindicado por ${workerId}`,
  });
  return processo ?? null;
}

/**
 * Devolve um processo à fila (volta para AGUARDANDO_ABERTURA, libera o
 * worker) sem incrementar tentativas de novo — a tentativa já foi contada
 * no claim. Usado quando a sessão cai no meio do processamento e o worker
 * decide não insistir imediatamente no mesmo item.
 */
export function devolverAFila(db: Database.Database, processoId: number, motivo: string): void {
  db.prepare(
    `
    UPDATE processos
    SET status = 'AGUARDANDO_ABERTURA', worker = NULL,
        atualizado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
  `,
  ).run({ id: processoId });

  registrarEvento(db, {
    processoId,
    etapa: 'FILA',
    acao: 'DEVOLVER',
    resultado: 'INFO',
    mensagem: motivo,
  });
}

/**
 * Varredor de órfãos: processos que ficaram em GRU_EM_PROCESSAMENTO por
 * mais de `timeoutMinutos` — sinal de que o worker morreu (crash, sessão
 * derrubada sem tratamento) sem devolver o item. Devolve todos à fila.
 */
export function varrerOrfaos(db: Database.Database, timeoutMinutos: number): number[] {
  const orfaos = db
    .prepare(
      `
      SELECT id FROM processos
      WHERE status = 'GRU_EM_PROCESSAMENTO'
        AND iniciado_em < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @offset)
    `,
    )
    .all({ offset: `-${timeoutMinutos} minutes` }) as { id: number }[];

  for (const { id } of orfaos) {
    devolverAFila(db, id, `varredura de órfãos: sem atualização há mais de ${timeoutMinutos}min`);
  }

  return orfaos.map((o) => o.id);
}

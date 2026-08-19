import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { liberarOperacao, pausarOperacao } from '../../src/db/operacao.js';
import { devolverAFila, reivindicarProximo, varrerOrfaos } from '../../src/db/queue.js';

let pastaTemp: string;
let db: Database.Database;

function inserirProcesso(
  overrides: Partial<{ posicao: number; fila: 'PRINCIPAL' | 'RESERVA'; status: string }> = {},
): number {
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
      VALUES (@posicao, @fila, '11144477735', '940328100', 'TPH', @status)
    `,
    )
    .run({
      posicao: overrides.posicao ?? 1,
      fila: overrides.fila ?? 'PRINCIPAL',
      status: overrides.status ?? 'AGUARDANDO_ABERTURA',
    });
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-fila-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('reivindicarProximo', () => {
  it('retorna null quando a operação não está RODANDO', () => {
    inserirProcesso();
    expect(reivindicarProximo(db, 'w1')).toBeNull();
  });

  it('reivindica por ordem de posição dentro da fila PRINCIPAL', () => {
    liberarOperacao(db, '13');
    const id2 = inserirProcesso({ posicao: 2 });
    const id1 = inserirProcesso({ posicao: 1 });

    const primeiro = reivindicarProximo(db, 'w1');
    expect(primeiro?.id).toBe(id1);

    const segundo = reivindicarProximo(db, 'w1');
    expect(segundo?.id).toBe(id2);
  });

  it('só reivindica RESERVA quando PRINCIPAL está esgotada', () => {
    liberarOperacao(db, '13');
    const idReserva = inserirProcesso({ posicao: 1, fila: 'RESERVA' });
    const idPrincipal = inserirProcesso({ posicao: 2, fila: 'PRINCIPAL' });

    const primeiro = reivindicarProximo(db, 'w1');
    expect(primeiro?.id).toBe(idPrincipal);

    const segundo = reivindicarProximo(db, 'w1');
    expect(segundo?.id).toBe(idReserva);
  });

  it('marca status, worker e incrementa tentativas ao reivindicar', () => {
    liberarOperacao(db, '13');
    const id = inserirProcesso();
    reivindicarProximo(db, 'w1');

    const row = db.prepare('SELECT * FROM processos WHERE id = ?').get(id) as {
      status: string;
      worker: string;
      tentativas: number;
    };
    expect(row.status).toBe('GRU_EM_PROCESSAMENTO');
    expect(row.worker).toBe('w1');
    expect(row.tentativas).toBe(1);
  });
});

describe('devolverAFila', () => {
  it('volta o processo para AGUARDANDO_ABERTURA e limpa o worker', () => {
    liberarOperacao(db, '13');
    const id = inserirProcesso();
    reivindicarProximo(db, 'w1');

    devolverAFila(db, id, 'sessão caiu');

    const row = db.prepare('SELECT status, worker FROM processos WHERE id = ?').get(id) as {
      status: string;
      worker: string | null;
    };
    expect(row.status).toBe('AGUARDANDO_ABERTURA');
    expect(row.worker).toBeNull();
  });
});

describe('varrerOrfaos', () => {
  it('devolve à fila processos presos há mais tempo que o timeout', () => {
    const id = inserirProcesso({ status: 'GRU_EM_PROCESSAMENTO' });
    db.prepare(
      `UPDATE processos SET iniciado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes') WHERE id = ?`,
    ).run(id);

    const revertidos = varrerOrfaos(db, 15);

    expect(revertidos).toEqual([id]);
    const row = db.prepare('SELECT status FROM processos WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('AGUARDANDO_ABERTURA');
  });

  it('não mexe em processos ainda dentro do timeout', () => {
    inserirProcesso({ status: 'GRU_EM_PROCESSAMENTO' });
    db.prepare(
      `UPDATE processos SET iniciado_em = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes') WHERE status = 'GRU_EM_PROCESSAMENTO'`,
    ).run();

    const revertidos = varrerOrfaos(db, 15);
    expect(revertidos).toEqual([]);
  });
});

describe('pausarOperacao', () => {
  it('impede novas reivindicações até retomar', () => {
    liberarOperacao(db, '13');
    inserirProcesso();
    pausarOperacao(db, 'ERRO_OBJETO_INDISPONIVEL: modalidade sumiu do dropdown');

    expect(reivindicarProximo(db, 'w1')).toBeNull();
  });
});

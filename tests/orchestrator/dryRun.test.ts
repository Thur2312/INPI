import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import type { DadosEmissaoGru, ResultadoEmissaoGru } from '../../src/inpi/adapter.js';
import type { DryRunAdapter } from '../../src/orchestrator/dryRun.js';
import { executarDryRun } from '../../src/orchestrator/dryRun.js';
import type { Logger } from '../../src/utils/logger.js';

let pastaTemp: string;
let db: Database.Database;

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function inserirProcesso(overrides: {
  posicao: number;
  fila?: 'PRINCIPAL' | 'RESERVA';
  status?: string;
  numeroProcesso?: string;
}): number {
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
      VALUES (@posicao, @fila, '11144477735', @numeroProcesso, 'TPH', @status)
    `,
    )
    .run({
      posicao: overrides.posicao,
      fila: overrides.fila ?? 'PRINCIPAL',
      numeroProcesso: overrides.numeroProcesso ?? `90000000${overrides.posicao}`,
      status: overrides.status ?? 'AGUARDANDO_ABERTURA',
    });
  return Number(info.lastInsertRowid);
}

function snapshotProcessos(): { id: number; status: string; tentativas: number; worker: string | null }[] {
  return db
    .prepare('SELECT id, status, tentativas, worker FROM processos ORDER BY id')
    .all() as { id: number; status: string; tentativas: number; worker: string | null }[];
}

const credenciais = { usuario: 'user', senha: 'pass' };

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-dryrun-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

function criarAdapterFalso(
  comportamento: (dados: DadosEmissaoGru) => Promise<ResultadoEmissaoGru>,
): DryRunAdapter {
  return {
    login: vi.fn().mockResolvedValue(undefined),
    emitirGru: vi.fn().mockImplementation((dados: DadosEmissaoGru) => comportamento(dados)),
  };
}

describe('executarDryRun', () => {
  it('processa só os N primeiros da fila (PRINCIPAL antes de RESERVA, por posição) e nunca muda status/tentativas/worker no banco', async () => {
    inserirProcesso({ posicao: 3, fila: 'PRINCIPAL' });
    inserirProcesso({ posicao: 1, fila: 'PRINCIPAL' });
    inserirProcesso({ posicao: 1, fila: 'RESERVA' });
    inserirProcesso({ posicao: 2, fila: 'PRINCIPAL' });

    const antes = snapshotProcessos();

    const numerosVistos: string[] = [];
    const adapter = criarAdapterFalso((dados) => {
      numerosVistos.push(dados.numeroProcesso);
      return Promise.resolve({
        modo: 'dry-run',
        valorConferido: '445,00',
        objetoPeticaoValue: '14',
      });
    });

    await executarDryRun({
      db,
      adapter,
      credenciais,
      valorEsperadoGru: 445,
      limite: 3,
      logger: criarLoggerFalso(),
      pausaEntreAcoesMinMs: 1,
      pausaEntreAcoesMaxMs: 2,
    });

    // ordem esperada: PRINCIPAL posicao 1, PRINCIPAL posicao 2, PRINCIPAL posicao 3 (RESERVA fica de fora, limite=3)
    expect(numerosVistos).toEqual(['900000001', '900000002', '900000003']);

    const depois = snapshotProcessos();
    expect(depois).toEqual(antes);
  });

  it('em caso de erro num item, registra e segue para o próximo — sem alterar status', async () => {
    inserirProcesso({ posicao: 1, numeroProcesso: '900000001' });
    inserirProcesso({ posicao: 2, numeroProcesso: '900000002' });
    const antes = snapshotProcessos();

    const adapter = criarAdapterFalso((dados) => {
      if (dados.numeroProcesso === '900000001') {
        return Promise.reject(new Error('cliente não encontrado'));
      }
      return Promise.resolve({
        modo: 'dry-run',
        valorConferido: '445,00',
        objetoPeticaoValue: '14',
      });
    });
    const logger = criarLoggerFalso();

    await executarDryRun({
      db,
      adapter,
      credenciais,
      valorEsperadoGru: 445,
      limite: 5,
      logger,
      pausaEntreAcoesMinMs: 1,
      pausaEntreAcoesMaxMs: 2,
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('falha ao processar item'),
      expect.objectContaining({ numeroProcesso: '900000001' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('OK'),
      expect.objectContaining({ numeroProcesso: '900000002' }),
    );
    expect(snapshotProcessos()).toEqual(antes);
  });

  it('registra o objetoPeticaoValue encontrado pelo regex no log de sucesso', async () => {
    inserirProcesso({ posicao: 1 });
    const adapter = criarAdapterFalso(() =>
      Promise.resolve({ modo: 'dry-run', valorConferido: '445,00', objetoPeticaoValue: '14' }),
    );
    const logger = criarLoggerFalso();

    await executarDryRun({
      db,
      adapter,
      credenciais,
      valorEsperadoGru: 445,
      limite: 1,
      logger,
      pausaEntreAcoesMinMs: 1,
      pausaEntreAcoesMaxMs: 2,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ objetoPeticaoValue: '14', valorConferido: '445,00' }),
    );
  });

  it('não chama login nem emitirGru quando não há processos elegíveis', async () => {
    const adapter = criarAdapterFalso(() =>
      Promise.resolve({ modo: 'dry-run', valorConferido: '445,00', objetoPeticaoValue: '14' }),
    );

    await executarDryRun({
      db,
      adapter,
      credenciais,
      valorEsperadoGru: 445,
      limite: 3,
      logger: criarLoggerFalso(),
    });

    expect(adapter.login).not.toHaveBeenCalled();
    expect(adapter.emitirGru).not.toHaveBeenCalled();
  });

  it('ignora processos já emitidos/em erro — só considera VALIDADO e AGUARDANDO_ABERTURA', async () => {
    inserirProcesso({ posicao: 1, status: 'GRU_EMITIDA' });
    inserirProcesso({ posicao: 2, status: 'ERRO_VALOR_INESPERADO' });
    inserirProcesso({ posicao: 3, status: 'VALIDADO', numeroProcesso: '900000003' });

    const numerosVistos: string[] = [];
    const adapter = criarAdapterFalso((dados) => {
      numerosVistos.push(dados.numeroProcesso);
      return Promise.resolve({ modo: 'dry-run', valorConferido: '445,00', objetoPeticaoValue: '14' });
    });

    await executarDryRun({
      db,
      adapter,
      credenciais,
      valorEsperadoGru: 445,
      limite: 10,
      logger: criarLoggerFalso(),
      pausaEntreAcoesMinMs: 1,
      pausaEntreAcoesMaxMs: 2,
    });

    expect(numerosVistos).toEqual(['900000003']);
  });
});

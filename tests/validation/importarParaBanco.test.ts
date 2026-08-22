import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { importarPlanilhaParaBanco } from '../../src/validation/importarParaBanco.js';

let pastaTemp: string;
let db: Database.Database;

const logger = { info: () => {}, warn: () => {}, error: () => {} };

const CABECALHO =
  'cliente,titular_documento,titular_nome,numero_processo,objeto_peticao,prioridade,protocolos_ja_utilizados,fila';

function escreverCsv(caminho: string, linhas: string[]): void {
  writeFileSync(caminho, [CABECALHO, ...linhas].join('\n'), 'utf-8');
}

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-import-banco-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('importarPlanilhaParaBanco', () => {
  it('grava linhas válidas já em AGUARDANDO_ABERTURA, prontas para reivindicarProximo', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    escreverCsv(caminho, ['Cliente A,111.444.777-35,Fulano,940328100,TPH,,0,PRINCIPAL']);

    const resumo = await importarPlanilhaParaBanco(db, caminho, logger);

    expect(resumo.validados).toBe(1);
    expect(resumo.movidosParaAguardandoAbertura).toBe(1);

    const row = db.prepare('SELECT status FROM processos WHERE numero_processo = ?').get('940328100') as {
      status: string;
    };
    expect(row.status).toBe('AGUARDANDO_ABERTURA');
  });

  it('grava linhas PENDENCIA_* no banco sem descartá-las (para o relatório)', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    escreverCsv(caminho, ['Cliente A,000.000.000-00,Fulano,940328100,TPH,,0,PRINCIPAL']);

    const resumo = await importarPlanilhaParaBanco(db, caminho, logger);

    expect(resumo.validados).toBe(0);
    expect(resumo.pendenciaDados).toBe(1);
    const row = db.prepare('SELECT status FROM processos WHERE numero_processo = ?').get('940328100') as {
      status: string;
    };
    expect(row.status).toBe('PENDENCIA_DADOS');
  });

  it('reimportar a mesma planilha não duplica o processo no banco (nunca gera 2ª GRU do mesmo processo)', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    escreverCsv(caminho, ['Cliente A,111.444.777-35,Fulano,940328100,TPH,,0,PRINCIPAL']);

    const primeira = await importarPlanilhaParaBanco(db, caminho, logger);
    expect(primeira.validados).toBe(1);

    const segunda = await importarPlanilhaParaBanco(db, caminho, logger);
    expect(segunda.validados).toBe(0);
    expect(segunda.pendenciaDados).toBe(1);
    expect(segunda.errosDeFormato).toEqual([]);

    const total = db.prepare('SELECT COUNT(*) AS total FROM processos WHERE numero_processo = ?').get(
      '940328100',
    ) as { total: number };
    expect(total.total).toBe(2); // a 2ª entra como PENDENCIA_DADOS, não some — mas nunca fica AGUARDANDO_ABERTURA
    const emAberto = db
      .prepare(
        `SELECT COUNT(*) AS total FROM processos WHERE numero_processo = ? AND status = 'AGUARDANDO_ABERTURA'`,
      )
      .get('940328100') as { total: number };
    expect(emAberto.total).toBe(1);
  });

  it('não move processos de importações anteriores de novo (só os recém-inseridos ficam VALIDADO)', async () => {
    const primeiro = join(pastaTemp, 'lote1.csv');
    escreverCsv(primeiro, ['Cliente A,111.444.777-35,Fulano,940328100,TPH,,0,PRINCIPAL']);
    await importarPlanilhaParaBanco(db, primeiro, logger);

    const segundo = join(pastaTemp, 'lote2.csv');
    escreverCsv(segundo, ['Cliente B,11.222.333/0001-81,Beltrano,940328101,TPH,,0,PRINCIPAL']);
    const resumo = await importarPlanilhaParaBanco(db, segundo, logger);

    expect(resumo.movidosParaAguardandoAbertura).toBe(1); // só o novo, não os 2
    const contagem = db
      .prepare(`SELECT COUNT(*) AS total FROM processos WHERE status = 'AGUARDANDO_ABERTURA'`)
      .get() as { total: number };
    expect(contagem.total).toBe(2);
  });
});

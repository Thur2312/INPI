import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { marcarComoDefinitivo, marcarComoEmitida } from '../../src/db/processos.js';
import {
  gerarCsvString,
  gerarRelatorioCsv,
  gerarRelatorioXlsx,
  gerarRelatorios,
} from '../../src/reports/relatorio.js';

let pastaTemp: string;
let db: Database.Database;

function inserirProcesso(overrides: { posicao: number; numeroProcesso?: string }): number {
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, cliente, titular_documento, titular_nome, numero_processo, objeto_peticao, status)
      VALUES (@posicao, 'PRINCIPAL', 'Escritório X', '11144477735', 'Fulano de Tal', @numeroProcesso, 'TPH', 'AGUARDANDO_ABERTURA')
    `,
    )
    .run({
      posicao: overrides.posicao,
      numeroProcesso: overrides.numeroProcesso ?? `90000000${overrides.posicao}`,
    });
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-relatorio-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('gerarCsvString', () => {
  it('inclui cabeçalho, uma linha por processo e escapa vírgulas/aspas na mensagem de erro', () => {
    const id1 = inserirProcesso({ posicao: 1 });
    marcarComoEmitida(db, id1, {
      nossoNumero: '10000000000001',
      codigoGru: 'COD1',
      valorGru: '445,00',
      caminhoPdf: '/tmp/guia1.pdf',
    });

    const id2 = inserirProcesso({ posicao: 2 });
    marcarComoDefinitivo(
      db,
      id2,
      'ERRO_VALOR_INESPERADO',
      'valor "errado", inesperado',
      null,
    );

    const csv = gerarCsvString(db);
    const linhas = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);

    expect(linhas[0]).toContain('Posição');
    expect(linhas[0]).toContain('Status');
    expect(linhas).toHaveLength(3); // cabeçalho + 2 processos
    expect(linhas[1]).toContain('GRU_EMITIDA');
    expect(linhas[1]).toContain('COD1');
    // mensagem com vírgula e aspas precisa vir entre aspas, com "" escapado
    expect(linhas[2]).toContain('"valor ""errado"", inesperado"');
  });
});

describe('gerarRelatorioCsv', () => {
  it('escreve o arquivo no disco, criando a pasta de saída se preciso', () => {
    inserirProcesso({ posicao: 1 });
    const caminho = join(pastaTemp, 'saida', 'relatorio.csv');

    gerarRelatorioCsv(db, caminho);

    expect(existsSync(caminho)).toBe(true);
  });
});

describe('gerarRelatorioXlsx', () => {
  it('gera um workbook lível com a mesma quantidade de linhas dos processos', async () => {
    inserirProcesso({ posicao: 1 });
    inserirProcesso({ posicao: 2 });
    inserirProcesso({ posicao: 3 });
    const caminho = join(pastaTemp, 'saida', 'relatorio.xlsx');

    await gerarRelatorioXlsx(db, caminho);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(caminho);
    const planilha = workbook.getWorksheet('GRUs 3020');
    expect(planilha).toBeDefined();
    // linha 1 é o cabeçalho
    expect(planilha!.rowCount).toBe(4);
    expect(planilha!.getRow(1).getCell(1).value).toBe('Posição');
  });
});

describe('gerarRelatorios', () => {
  it('gera CSV e XLSX com nomes carimbados na mesma pasta', async () => {
    inserirProcesso({ posicao: 1 });
    const pastaSaida = join(pastaTemp, 'relatorios');

    const resultado = await gerarRelatorios(db, pastaSaida);

    expect(existsSync(resultado.csv)).toBe(true);
    expect(existsSync(resultado.xlsx)).toBe(true);
    expect(resultado.csv.endsWith('.csv')).toBe(true);
    expect(resultado.xlsx.endsWith('.xlsx')).toBe(true);
  });
});

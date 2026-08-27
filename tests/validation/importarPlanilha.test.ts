import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importarPlanilha } from '../../src/validation/importarPlanilha.js';

let pastaTemp: string;

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-planilha-'));
});

afterEach(() => {
  rmSync(pastaTemp, { recursive: true, force: true });
});

const CABECALHO =
  'cliente,titular_documento,titular_nome,numero_processo,objeto_peticao,prioridade,protocolos_ja_utilizados,fila';

describe('importarPlanilha — CSV', () => {
  it('lê linhas válidas do CSV, na ordem, com posicao 1-based', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    writeFileSync(
      caminho,
      [
        CABECALHO,
        'Cliente A,111.444.777-35,Fulano,940328100,TPH,1,0,PRINCIPAL',
        'Cliente B,11.222.333/0001-81,Beltrano,940328101,TPH,,2,RESERVA',
      ].join('\n'),
      'utf-8',
    );

    const resultado = await importarPlanilha(caminho);

    expect(resultado.erros).toEqual([]);
    expect(resultado.linhas).toHaveLength(2);
    expect(resultado.linhas[0]).toMatchObject({
      posicao: 1,
      dados: { numero_processo: '940328100', fila: 'PRINCIPAL', prioridade: 1 },
    });
    expect(resultado.linhas[1]).toMatchObject({
      posicao: 2,
      dados: { numero_processo: '940328101', fila: 'RESERVA', protocolos_ja_utilizados: 2 },
    });
  });

  it('aplica default fila=PRINCIPAL e protocolos_ja_utilizados=0 quando ausentes', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    writeFileSync(
      caminho,
      [CABECALHO, 'Cliente A,111.444.777-35,Fulano,940328100,TPH,,,'].join('\n'),
      'utf-8',
    );

    const resultado = await importarPlanilha(caminho);

    expect(resultado.linhas[0]?.dados.fila).toBe('PRINCIPAL');
    expect(resultado.linhas[0]?.dados.protocolos_ja_utilizados).toBe(0);
  });

  it('coleta erro de schema por linha (campo obrigatório ausente) sem interromper as demais', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    writeFileSync(
      caminho,
      [
        CABECALHO,
        'Cliente A,,Fulano,940328100,TPH,,0,PRINCIPAL', // titular_documento vazio
        'Cliente B,11.222.333/0001-81,Beltrano,940328101,TPH,,0,PRINCIPAL',
      ].join('\n'),
      'utf-8',
    );

    const resultado = await importarPlanilha(caminho);

    expect(resultado.linhas).toHaveLength(1);
    expect(resultado.erros).toHaveLength(1);
    expect(resultado.erros[0]?.posicao).toBe(1);
    expect(resultado.erros[0]?.mensagem).toContain('titular_documento');
  });

  it('ignora linhas em branco no meio da planilha', async () => {
    const caminho = join(pastaTemp, 'lote.csv');
    writeFileSync(
      caminho,
      [
        CABECALHO,
        'Cliente A,111.444.777-35,Fulano,940328100,TPH,,0,PRINCIPAL',
        '',
        'Cliente B,11.222.333/0001-81,Beltrano,940328101,TPH,,0,PRINCIPAL',
      ].join('\n'),
      'utf-8',
    );

    const resultado = await importarPlanilha(caminho);

    expect(resultado.linhas).toHaveLength(2);
    expect(resultado.erros).toEqual([]);
  });
});

describe('importarPlanilha — XLSX', () => {
  it('lê linhas válidas de um workbook real, incluindo célula numérica', async () => {
    const caminho = join(pastaTemp, 'lote.xlsx');
    const workbook = new ExcelJS.Workbook();
    const planilha = workbook.addWorksheet('dados');
    planilha.addRow([
      'cliente',
      'titular_documento',
      'titular_nome',
      'numero_processo',
      'objeto_peticao',
      'prioridade',
      'protocolos_ja_utilizados',
      'fila',
    ]);
    // numero_processo como number (comportamento comum do Excel) — deve
    // ser coagido para string pelo schema (`z.coerce.string()`).
    planilha.addRow(['Cliente A', '111.444.777-35', 'Fulano', 940328100, 'TPH', 1, 0, 'PRINCIPAL']);
    await workbook.xlsx.writeFile(caminho);

    const resultado = await importarPlanilha(caminho);

    expect(resultado.erros).toEqual([]);
    expect(resultado.linhas).toHaveLength(1);
    expect(resultado.linhas[0]?.dados.numero_processo).toBe('940328100');
  });

  it('pula uma aba de instruções antes da aba de dados, identificando pelo cabeçalho (não pela ordem/nome)', async () => {
    const caminho = join(pastaTemp, 'lote-com-instrucoes.xlsx');
    const workbook = new ExcelJS.Workbook();

    const instrucoes = workbook.addWorksheet('Instruções');
    instrucoes.addRow(['Modelo de planilha — Requerimentos de GRU 3020 (INPI)']);
    instrucoes.addRow(['Preencha a aba "Processos" com um requerimento por linha.']);

    const dados = workbook.addWorksheet('Processos');
    dados.addRow([
      'cliente',
      'titular_documento',
      'titular_nome',
      'numero_processo',
      'objeto_peticao',
      'prioridade',
      'protocolos_ja_utilizados',
      'fila',
    ]);
    dados.addRow(['Cliente A', '111.444.777-35', 'Fulano', 940328100, 'TPH', 1, 0, 'PRINCIPAL']);
    await workbook.xlsx.writeFile(caminho);

    const resultado = await importarPlanilha(caminho);

    expect(resultado.erros).toEqual([]);
    expect(resultado.linhas).toHaveLength(1);
    expect(resultado.linhas[0]?.dados.numero_processo).toBe('940328100');
  });

  it('lança quando o workbook não tem nenhuma aba', async () => {
    const caminho = join(pastaTemp, 'vazio.xlsx');
    const workbook = new ExcelJS.Workbook();
    const planilha = workbook.addWorksheet('temp');
    workbook.removeWorksheet(planilha.id);
    await workbook.xlsx.writeFile(caminho);

    await expect(importarPlanilha(caminho)).rejects.toThrow(/não contém nenhuma aba/);
  });
});

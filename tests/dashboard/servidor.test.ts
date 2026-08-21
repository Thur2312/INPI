import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarApp } from '../../src/dashboard/servidor.js';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { pausarOperacao } from '../../src/db/operacao.js';

let pastaTemp: string;
let db: Database.Database;
let servidor: Server;
let baseUrl: string;

function inserirProcesso(posicao: number, status = 'AGUARDANDO_ABERTURA'): void {
  db.prepare(
    `
    INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
    VALUES (@posicao, 'PRINCIPAL', '11144477735', @numero, 'TPH', @status)
  `,
  ).run({ posicao, numero: `90000000${posicao}`, status });
}

beforeEach(async () => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-dashboard-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);

  const app = criarApp(db);
  servidor = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const endereco = servidor.address();
  if (endereco === null || typeof endereco === 'string') {
    throw new Error('endereço do servidor de teste inválido');
  }
  baseUrl = `http://127.0.0.1:${endereco.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('GET /api/status', () => {
  it('devolve operação, contagens por status e a lista completa de processos', async () => {
    inserirProcesso(1, 'AGUARDANDO_ABERTURA');
    inserirProcesso(2, 'GRU_EMITIDA');

    const resposta = await fetch(`${baseUrl}/api/status`);
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      operacao: { status: string };
      contagens: Record<string, number>;
      processos: { posicao: number }[];
    };

    expect(corpo.operacao.status).toBe('AGUARDANDO_ABERTURA');
    expect(corpo.contagens).toEqual({ AGUARDANDO_ABERTURA: 1, GRU_EMITIDA: 1 });
    expect(corpo.processos).toHaveLength(2);
    expect(corpo.processos[0]?.posicao).toBe(1);
  });
});

describe('POST /api/retomar', () => {
  it('recusa com 409 quando a operação não está pausada', async () => {
    const resposta = await fetch(`${baseUrl}/api/retomar`, { method: 'POST' });
    expect(resposta.status).toBe(409);
    const corpo = (await resposta.json()) as { statusAtual: string };
    expect(corpo.statusAtual).toBe('AGUARDANDO_ABERTURA');
  });

  it('retoma a operação quando ela está PAUSADA', async () => {
    pausarOperacao(db, 'ERRO_OBJETO_INDISPONIVEL: modalidade sumiu do dropdown');

    const resposta = await fetch(`${baseUrl}/api/retomar`, { method: 'POST' });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { status: string; motivo: string | null };
    expect(corpo.status).toBe('RODANDO');
    expect(corpo.motivo).toBeNull();
  });
});

describe('GET /api/relatorio.csv', () => {
  it('devolve um CSV para download com os processos atuais', async () => {
    inserirProcesso(1);

    const resposta = await fetch(`${baseUrl}/api/relatorio.csv`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toContain('text/csv');
    expect(resposta.headers.get('content-disposition')).toContain('attachment');

    const texto = await resposta.text();
    expect(texto).toContain('Posição');
    expect(texto).toContain('900000001');
  });
});

describe('GET /api/relatorio.xlsx', () => {
  it('devolve um XLSX válido para download', async () => {
    inserirProcesso(1);

    const resposta = await fetch(`${baseUrl}/api/relatorio.xlsx`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toContain('spreadsheetml');

    const buffer = Buffer.from(await resposta.arrayBuffer());
    // assinatura ZIP (xlsx é um zip) — prova mínima de que não veio corrompido/vazio
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('GET /', () => {
  it('serve a página estática do dashboard', async () => {
    const resposta = await fetch(`${baseUrl}/`);
    expect(resposta.status).toBe(200);
    const texto = await resposta.text();
    expect(texto).toContain('GRU 3020');
  });
});

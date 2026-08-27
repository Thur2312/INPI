import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import type { CriarAppPortalOpcoes } from '../../src/portalCliente/servidor.js';
import { criarAppPortalCliente } from '../../src/portalCliente/servidor.js';
import { assinarToken } from '../../src/portalCliente/token.js';

const SEGREDO = 'segredo-de-teste-bem-comprido-1234567890';
const DOCUMENTO_A = '11144477735'; // CPF com DV válido
const DOCUMENTO_B = '11222333000181'; // CNPJ com DV válido

let pastaTemp: string;
let db: Database.Database;
let servidor: Server;
let baseUrl: string;

function inserirProcesso(opcoes: {
  posicao: number;
  titularDocumento: string;
  status?: string;
  caminhoPdf?: string | null;
}): number {
  const { posicao, titularDocumento, status = 'GRU_EMITIDA', caminhoPdf = null } = opcoes;
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status, caminho_pdf)
      VALUES (@posicao, 'PRINCIPAL', @titularDocumento, @numero, 'TPH', @status, @caminhoPdf)
    `,
    )
    .run({ posicao, titularDocumento, numero: `90000000${posicao}`, status, caminhoPdf });
  return Number(info.lastInsertRowid);
}

async function subirApp(opcoesExtra: Partial<CriarAppPortalOpcoes> = {}): Promise<void> {
  const app = criarAppPortalCliente(db, {
    segredoToken: SEGREDO,
    raizProjeto: pastaTemp,
    ...opcoesExtra,
  });
  servidor = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const endereco = servidor.address();
  if (endereco === null || typeof endereco === 'string') {
    throw new Error('endereço do servidor de teste inválido');
  }
  baseUrl = `http://127.0.0.1:${endereco.port}`;
}

beforeEach(async () => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-portal-cliente-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
  await subirApp();
});

afterEach(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('interface estática (src/portalCliente/public)', () => {
  it('serve o index.html na raiz', async () => {
    const resposta = await fetch(`${baseUrl}/`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('content-type')).toContain('text/html');
    const corpo = await resposta.text();
    expect(corpo).toContain('Portal do Cliente');
  });
});

describe('POST /api/login', () => {
  it('rejeita documento com dígito verificador inválido', async () => {
    const resposta = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documento: '11111111111111' }),
    });
    expect(resposta.status).toBe(400);
  });

  it('rejeita documento válido mas sem nenhum requerimento no banco', async () => {
    const resposta = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documento: DOCUMENTO_A }),
    });
    expect(resposta.status).toBe(404);
  });

  it('emite um token quando o documento tem requerimento(s) no banco, aceitando com pontuação', async () => {
    inserirProcesso({ posicao: 1, titularDocumento: DOCUMENTO_A });

    const resposta = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documento: '111.444.777-35' }),
    });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { token: string };
    expect(typeof corpo.token).toBe('string');
    expect(corpo.token.length).toBeGreaterThan(0);
  });
});

describe('GET /api/minhas-grus', () => {
  it('exige sessão (401 sem token)', async () => {
    const resposta = await fetch(`${baseUrl}/api/minhas-grus`);
    expect(resposta.status).toBe(401);
  });

  it('rejeita token expirado ou de outro segredo', async () => {
    const tokenExpirado = assinarToken(DOCUMENTO_A, SEGREDO, -1);
    const resposta = await fetch(`${baseUrl}/api/minhas-grus`, {
      headers: { authorization: `Bearer ${tokenExpirado}` },
    });
    expect(resposta.status).toBe(401);
  });

  it('devolve só os requerimentos do titular autenticado, sem caminho de arquivo cru', async () => {
    inserirProcesso({ posicao: 1, titularDocumento: DOCUMENTO_A, caminhoPdf: 'output/guias/a.pdf' });
    inserirProcesso({ posicao: 2, titularDocumento: DOCUMENTO_A });
    inserirProcesso({ posicao: 3, titularDocumento: DOCUMENTO_B });

    const token = assinarToken(DOCUMENTO_A, SEGREDO, 60_000);
    const resposta = await fetch(`${baseUrl}/api/minhas-grus`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      processos: { numeroProcesso: string; pdfDisponivel: boolean }[];
    };
    expect(corpo.processos).toHaveLength(2);
    expect(corpo.processos.every((p) => !('caminhoPdf' in p))).toBe(true);
    expect(corpo.processos.find((p) => p.numeroProcesso === '900000001')?.pdfDisponivel).toBe(true);
    expect(corpo.processos.find((p) => p.numeroProcesso === '900000002')?.pdfDisponivel).toBe(false);
  });
});

describe('GET /api/grus/:id/pdf', () => {
  it('nunca deixa um titular baixar o PDF de outro (404, mesmo o id existindo)', async () => {
    mkdirSync(join(pastaTemp, 'output', 'guias'), { recursive: true });
    writeFileSync(join(pastaTemp, 'output', 'guias', 'b.pdf'), '%PDF-FAKE');
    const idDoOutro = inserirProcesso({
      posicao: 1,
      titularDocumento: DOCUMENTO_B,
      caminhoPdf: 'output/guias/b.pdf',
    });
    inserirProcesso({ posicao: 2, titularDocumento: DOCUMENTO_A });

    const token = assinarToken(DOCUMENTO_A, SEGREDO, 60_000);
    const resposta = await fetch(`${baseUrl}/api/grus/${idDoOutro}/pdf`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resposta.status).toBe(404);
  });

  it('baixa o PDF de verdade quando o id pertence ao titular autenticado', async () => {
    mkdirSync(join(pastaTemp, 'output', 'guias'), { recursive: true });
    writeFileSync(join(pastaTemp, 'output', 'guias', 'a.pdf'), '%PDF-FAKE-CONTENT');
    const id = inserirProcesso({
      posicao: 1,
      titularDocumento: DOCUMENTO_A,
      caminhoPdf: 'output/guias/a.pdf',
    });

    const token = assinarToken(DOCUMENTO_A, SEGREDO, 60_000);
    const resposta = await fetch(`${baseUrl}/api/grus/${id}/pdf`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resposta.status).toBe(200);
    const corpo = await resposta.text();
    expect(corpo).toBe('%PDF-FAKE-CONTENT');
  });

  it('devolve 404 com mensagem clara quando o requerimento ainda não tem boleto', async () => {
    const id = inserirProcesso({ posicao: 1, titularDocumento: DOCUMENTO_A, caminhoPdf: null });
    const token = assinarToken(DOCUMENTO_A, SEGREDO, 60_000);

    const resposta = await fetch(`${baseUrl}/api/grus/${id}/pdf`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resposta.status).toBe(404);
  });
});

describe('rotas /api/admin/*', () => {
  it('sem senha configurada, fica aberta (dev/teste) e vê todos os titulares', async () => {
    inserirProcesso({ posicao: 1, titularDocumento: DOCUMENTO_A });
    inserirProcesso({ posicao: 2, titularDocumento: DOCUMENTO_B });

    const resposta = await fetch(`${baseUrl}/api/admin/processos`);
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { processos: unknown[] };
    expect(corpo.processos).toHaveLength(2);
  });

  it('com senha configurada, exige Basic Auth', async () => {
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
    await subirApp({ senhaAdmin: 'senha-admin-forte' });

    const semAuth = await fetch(`${baseUrl}/api/admin/processos`);
    expect(semAuth.status).toBe(401);

    const comAuthErrada = await fetch(`${baseUrl}/api/admin/processos`, {
      headers: { authorization: `Basic ${Buffer.from('admin:errada').toString('base64')}` },
    });
    expect(comAuthErrada.status).toBe(401);

    const comAuthCerta = await fetch(`${baseUrl}/api/admin/processos`, {
      headers: { authorization: `Basic ${Buffer.from('admin:senha-admin-forte').toString('base64')}` },
    });
    expect(comAuthCerta.status).toBe(200);
  });
});

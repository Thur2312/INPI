import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { pausarOperacao } from '../../src/db/operacao.js';
import type {
  EstadoOperacao,
  GerenciadorOperacao,
} from '../../src/dashboard/gerenciadorOperacao.js';
import type { CriarAppOpcoes } from '../../src/dashboard/servidor.js';
import { criarApp } from '../../src/dashboard/servidor.js';
import type { Logger } from '../../src/utils/logger.js';

let pastaTemp: string;
let db: Database.Database;
let servidor: Server;
let baseUrl: string;
let gerenciadorFalso: GerenciadorOperacao & { chamadasIniciar: Record<string, string>[] };

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function criarGerenciadorFalso(): GerenciadorOperacao & { chamadasIniciar: Record<string, string>[] } {
  let estadoAtual: EstadoOperacao = { rodando: false, pid: null, iniciadoEm: null };
  const chamadasIniciar: Record<string, string>[] = [];
  return {
    estado: () => estadoAtual,
    iniciar: (overridesEnv) => {
      if (estadoAtual.rodando) {
        throw new Error('já existe uma operação em andamento — pare antes de iniciar outra');
      }
      chamadasIniciar.push(overridesEnv);
      estadoAtual = { rodando: true, pid: 4242, iniciadoEm: new Date().toISOString() };
      return estadoAtual;
    },
    parar: () => {
      estadoAtual = { rodando: false, pid: null, iniciadoEm: null };
    },
    chamadasIniciar,
  };
}

const configPadrao = {
  maxWorkers: 4,
  pausaEntreAcoesMinMs: 2000,
  pausaEntreAcoesMaxMs: 4000,
  largadaWorkerMinMs: 10_000,
  largadaWorkerMaxMs: 15_000,
  verificadorIntervaloMinMs: 20_000,
  verificadorIntervaloMaxMs: 30_000,
};

function inserirProcesso(posicao: number, status = 'AGUARDANDO_ABERTURA'): void {
  db.prepare(
    `
    INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
    VALUES (@posicao, 'PRINCIPAL', '11144477735', @numero, 'TPH', @status)
  `,
  ).run({ posicao, numero: `90000000${posicao}`, status });
}

async function subirApp(opcoesExtra: Partial<CriarAppOpcoes> = {}): Promise<void> {
  gerenciadorFalso = criarGerenciadorFalso();
  const app = criarApp(db, {
    gerenciadorOperacao: gerenciadorFalso,
    configPadrao,
    logPath: join(pastaTemp, 'operacao-processo.log'),
    logger: criarLoggerFalso(),
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
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-dashboard-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
  await subirApp();
});

afterEach(async () => {
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('GET /api/status', () => {
  it('devolve operação, contagens por status, processos e estado do processo da operação', async () => {
    inserirProcesso(1, 'AGUARDANDO_ABERTURA');
    inserirProcesso(2, 'GRU_EMITIDA');

    const resposta = await fetch(`${baseUrl}/api/status`);
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      operacao: { status: string };
      contagens: Record<string, number>;
      processos: { posicao: number }[];
      processoOperacao: EstadoOperacao;
    };

    expect(corpo.operacao.status).toBe('AGUARDANDO_ABERTURA');
    expect(corpo.contagens).toEqual({ AGUARDANDO_ABERTURA: 1, GRU_EMITIDA: 1 });
    expect(corpo.processos).toHaveLength(2);
    expect(corpo.processoOperacao).toEqual({ rodando: false, pid: null, iniciadoEm: null });
  });
});

describe('GET /api/config', () => {
  it('devolve os valores padrão de ritmo para pré-preencher o formulário', async () => {
    const resposta = await fetch(`${baseUrl}/api/config`);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual(configPadrao);
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

describe('POST /api/importar', () => {
  it('importa um CSV enviado por upload e grava no banco', async () => {
    const csv = [
      'cliente,titular_documento,titular_nome,numero_processo,objeto_peticao,prioridade,protocolos_ja_utilizados,fila',
      'Cliente A,111.444.777-35,Fulano,940328100,TPH,,0,PRINCIPAL',
    ].join('\n');
    const formData = new FormData();
    formData.append('planilha', new Blob([csv], { type: 'text/csv' }), 'lote.csv');

    const resposta = await fetch(`${baseUrl}/api/importar`, { method: 'POST', body: formData });
    expect(resposta.status).toBe(200);
    const resumo = (await resposta.json()) as { validados: number; movidosParaAguardandoAbertura: number };
    expect(resumo.validados).toBe(1);
    expect(resumo.movidosParaAguardandoAbertura).toBe(1);

    const row = db
      .prepare('SELECT status FROM processos WHERE numero_processo = ?')
      .get('940328100') as { status: string };
    expect(row.status).toBe('AGUARDANDO_ABERTURA');
  });

  it('rejeita quando nenhum arquivo é enviado', async () => {
    const resposta = await fetch(`${baseUrl}/api/importar`, { method: 'POST', body: new FormData() });
    expect(resposta.status).toBe(400);
  });

  it('rejeita extensão não suportada', async () => {
    const formData = new FormData();
    formData.append('planilha', new Blob(['oi'], { type: 'text/plain' }), 'lote.txt');

    const resposta = await fetch(`${baseUrl}/api/importar`, { method: 'POST', body: formData });
    expect(resposta.status).toBe(400);
  });
});

describe('POST /api/iniciar e /api/parar', () => {
  it('inicia a operação e repassa os overrides como variáveis de ambiente', async () => {
    const resposta = await fetch(`${baseUrl}/api/iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxWorkers: 10, pausaEntreAcoesMinMs: 500, pausaEntreAcoesMaxMs: 900 }),
    });

    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as EstadoOperacao;
    expect(corpo.rodando).toBe(true);
    expect(gerenciadorFalso.chamadasIniciar).toEqual([
      { MAX_WORKERS: '10', PAUSA_ENTRE_ACOES_MIN_MS: '500', PAUSA_ENTRE_ACOES_MAX_MS: '900' },
    ]);
  });

  it('recusa iniciar de novo com 409 quando já está rodando', async () => {
    await fetch(`${baseUrl}/api/iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const segunda = await fetch(`${baseUrl}/api/iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(segunda.status).toBe(409);
  });

  it('rejeita override inconsistente (min > max) com 400, sem chamar o gerenciador', async () => {
    const resposta = await fetch(`${baseUrl}/api/iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pausaEntreAcoesMinMs: 9000, pausaEntreAcoesMaxMs: 1000 }),
    });
    expect(resposta.status).toBe(400);
    expect(gerenciadorFalso.chamadasIniciar).toEqual([]);
  });

  it('para a operação em andamento', async () => {
    await fetch(`${baseUrl}/api/iniciar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const resposta = await fetch(`${baseUrl}/api/parar`, { method: 'POST' });
    expect(resposta.status).toBe(200);
    expect(gerenciadorFalso.estado().rodando).toBe(false);
  });
});

describe('GET /api/log', () => {
  it('devolve lista vazia quando o arquivo de log ainda não existe', async () => {
    const resposta = await fetch(`${baseUrl}/api/log`);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ linhas: [] });
  });

  it('devolve as últimas linhas do arquivo de log', async () => {
    const caminhoLog = join(pastaTemp, 'operacao-processo.log');
    writeFileSync(caminhoLog, 'linha 1\nlinha 2\nlinha 3\n', 'utf-8');

    const resposta = await fetch(`${baseUrl}/api/log`);
    const corpo = (await resposta.json()) as { linhas: string[] };
    expect(corpo.linhas).toEqual(['linha 1', 'linha 2', 'linha 3']);
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

describe('autenticação (DASHBOARD_SENHA)', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
    await subirApp({ senha: 'segredo-forte' });
  });

  it('sem credenciais: 401', async () => {
    const resposta = await fetch(`${baseUrl}/api/status`);
    expect(resposta.status).toBe(401);
  });

  it('com senha errada: 401', async () => {
    const resposta = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Basic ${Buffer.from('op:senha-errada').toString('base64')}` },
    });
    expect(resposta.status).toBe(401);
  });

  it('com a senha certa: 200 (usuário é ignorado)', async () => {
    const resposta = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Basic ${Buffer.from('qualquer:segredo-forte').toString('base64')}` },
    });
    expect(resposta.status).toBe(200);
  });
});

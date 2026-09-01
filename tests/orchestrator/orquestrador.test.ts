import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Browser, BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { liberarOperacao, obterOperacao } from '../../src/db/operacao.js';
import type { ConfigWorker, CredenciaisInpi } from '../../src/orchestrator/workerLoop.js';
import type { AdapterCompleto, OpcoesOperacao } from '../../src/orchestrator/orquestrador.js';
import { rodarOperacao } from '../../src/orchestrator/orquestrador.js';
import type { Logger } from '../../src/utils/logger.js';

let pastaTemp: string;
let db: Database.Database;

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function inserirProcesso(posicao: number): void {
  db.prepare(
    `
    INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
    VALUES (@posicao, 'PRINCIPAL', '11144477735', @numero, 'TPH', 'AGUARDANDO_ABERTURA')
  `,
  ).run({ posicao, numero: `90000000${posicao}` });
}

function contarPorStatus(): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) as total FROM processos GROUP BY status')
    .all() as {
    status: string;
    total: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

/** Browser falso: `newContext()` só precisa devolver algo com `close()` — o resto vem do `criarAdapter` injetado. */
function criarBrowserFalso(): { browser: Browser; totalContextos: () => number } {
  let total = 0;
  const browser = {
    newContext: vi.fn(() => {
      total += 1;
      return Promise.resolve({ close: () => Promise.resolve() } as unknown as BrowserContext);
    }),
  } as unknown as Browser;
  return { browser, totalContextos: () => total };
}

let contadorNossoNumero = 0;

function criarAdapterFalso(): AdapterCompleto {
  contadorNossoNumero += 1;
  const meuContador = contadorNossoNumero;
  return {
    login: vi.fn().mockResolvedValue(undefined),
    objetoPeticaoDisponivel: vi
      .fn()
      .mockResolvedValue({ encontrado: true, value: '14', opcoesAtuais: ['TPH'] }),
    emitirGru: vi.fn().mockImplementation(() =>
      Promise.resolve({
        modo: 'emitida',
        nossoNumero: `1000000000000000${meuContador}`,
        codigoGru: `COD${meuContador}`,
        valorGru: '445,00',
        linkBoleto: `https://meu.inpi.gov.br/pag/gru/imprimir/codigo/COD${meuContador}`,
      }),
    ),
    baixarBoleto: vi.fn().mockResolvedValue(undefined),
    novoServico: vi.fn().mockResolvedValue(undefined),
    capturarScreenshot: vi.fn().mockResolvedValue(null),
    consultarGrusDoCliente: vi.fn().mockResolvedValue([]),
  };
}

const configPadrao: ConfigWorker = {
  maxTentativas: 3,
  pastaGuias: '',
  pastaErros: '',
  horaLimiteEmissao: '22:00',
  hardStop22h: false,
};

const credenciais: CredenciaisInpi = { usuario: 'user', senha: 'pass' };

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-orquestrador-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

function opcoesBase(overrides: Partial<OpcoesOperacao> = {}): OpcoesOperacao {
  const { browser } = criarBrowserFalso();
  return {
    db,
    browser,
    credenciais,
    maxWorkers: 2,
    objetoPeticaoTexto: 'TPH',
    titularDocumentoVerificador: '11144477735',
    numeroProcessoVerificador: '900000001',
    config: configPadrao,
    logger: criarLoggerFalso(),
    pastaBackup: join(pastaTemp, 'backups'),
    backupIntervaloMinutos: 60,
    orfaoTimeoutMinutos: 15,
    pastaRelatorios: join(pastaTemp, 'relatorios'),
    criarAdapter: () => Promise.resolve(criarAdapterFalso()),
    largadaMinMs: 1,
    largadaMaxMs: 2,
    esperaFilaVaziaMs: 10,
    pausaEntreAcoesMinMs: 1,
    pausaEntreAcoesMaxMs: 2,
    ...overrides,
  };
}

describe('rodarOperacao — cota ainda fechada (AGUARDANDO_ABERTURA)', () => {
  it('roda o verificador até liberar a cota, depois processa tudo com N workers', async () => {
    inserirProcesso(1);
    inserirProcesso(2);
    inserirProcesso(3);

    const operacao = rodarOperacao(opcoesBase({ maxWorkers: 2 }));
    await operacao.concluida;

    expect(obterOperacao(db).status).toBe('RODANDO');
    expect(contarPorStatus()).toEqual({ GRU_EMITIDA: 3 });
  }, 10_000);
});

describe('rodarOperacao — cota já aberta (RODANDO)', () => {
  it('não cria contexto de verificador, só workers', async () => {
    liberarOperacao(db, '14');
    inserirProcesso(1);

    let chamadasCriarAdapter = 0;
    const opcoes = opcoesBase({
      maxWorkers: 1,
      criarAdapter: () => {
        chamadasCriarAdapter += 1;
        return Promise.resolve(criarAdapterFalso());
      },
    });

    const operacao = rodarOperacao(opcoes);
    await operacao.concluida;

    expect(chamadasCriarAdapter).toBe(1); // só o worker, nenhum verificador
    expect(contarPorStatus()).toEqual({ GRU_EMITIDA: 1 });
  }, 10_000);
});

describe('rodarOperacao — verificadorIntervaloMinMs/MaxMs', () => {
  it('repassa o intervalo customizado ao verificador (sem isso o teste estouraria no default de 20-30s)', async () => {
    inserirProcesso(1);

    let chamadas = 0;
    const adapterComPollingLento: AdapterCompleto = {
      ...criarAdapterFalso(),
      objetoPeticaoDisponivel: vi.fn().mockImplementation(() => {
        chamadas += 1;
        if (chamadas === 1) {
          return Promise.resolve({ encontrado: false, value: null, opcoesAtuais: [] });
        }
        return Promise.resolve({ encontrado: true, value: '14', opcoesAtuais: ['TPH'] });
      }),
    };

    const operacao = rodarOperacao(
      opcoesBase({
        maxWorkers: 1,
        criarAdapter: () => Promise.resolve(adapterComPollingLento),
        verificadorIntervaloMinMs: 1,
        verificadorIntervaloMaxMs: 2,
      }),
    );
    await operacao.concluida;

    expect(chamadas).toBeGreaterThanOrEqual(2);
    expect(contarPorStatus()).toEqual({ GRU_EMITIDA: 1 });
  }, 10_000);
});

describe('rodarOperacao — parar()', () => {
  it('disponível imediatamente, antes de todos os workers terminarem de largar', async () => {
    liberarOperacao(db, '14');
    for (let i = 1; i <= 5; i += 1) inserirProcesso(i);

    const opcoes = opcoesBase({
      maxWorkers: 3,
      largadaMinMs: 200,
      largadaMaxMs: 200,
    });

    const operacao = rodarOperacao(opcoes);
    // Se `parar` só existisse depois de lançar os 3 workers, essa chamada
    // aconteceria depois de pelo menos 400ms (2 intervalos de largada).
    // Chamando antes disso, provamos que o handle já está disponível.
    operacao.parar();

    await operacao.concluida;

    expect(true).toBe(true); // não travou nem lançou — é a asserção que importa aqui
  }, 10_000);
});

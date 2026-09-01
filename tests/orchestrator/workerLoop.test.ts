import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { liberarOperacao, obterOperacao } from '../../src/db/operacao.js';
import {
  ClienteNaoEncontradoError,
  ObjetoPeticaoIndisponivelError,
  SessaoInpiError,
  TimeoutInpiError,
} from '../../src/inpi/erros.js';
import type {
  ConfigWorker,
  DependenciasWorker,
  WorkerAdapter,
} from '../../src/orchestrator/workerLoop.js';
import { executarWorker } from '../../src/orchestrator/workerLoop.js';
import type { Logger } from '../../src/utils/logger.js';

let pastaTemp: string;
let db: Database.Database;

function inserirProcesso(overrides: Partial<Record<string, unknown>> = {}): number {
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status, nosso_numero)
      VALUES (@posicao, 'PRINCIPAL', '11144477735', '940328100', 'TPH', @status, @nossoNumero)
    `,
    )
    .run({
      posicao: 1,
      status: 'AGUARDANDO_ABERTURA',
      nossoNumero: null,
      ...overrides,
    });
  return Number(info.lastInsertRowid);
}

interface LinhaProcessoBruta {
  status: string;
  nosso_numero: string | null;
  erro_tipo: string | null;
  erro_mensagem: string | null;
}

function buscarProcesso(id: number): LinhaProcessoBruta {
  return db.prepare('SELECT * FROM processos WHERE id = ?').get(id) as LinhaProcessoBruta;
}

function criarLoggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const configPadrao: ConfigWorker = {
  maxTentativas: 3,
  pastaGuias: '',
  pastaErros: '',
  horaLimiteEmissao: '22:00',
  hardStop22h: false,
};

function criarAdapterFalso(overrides: Partial<WorkerAdapter> = {}): WorkerAdapter {
  return {
    login: vi.fn().mockResolvedValue(undefined),
    emitirGru: vi.fn().mockResolvedValue({
      modo: 'emitida',
      nossoNumero: '12345678901234567',
      codigoGru: 'ABC123',
      valorGru: '445,00',
      linkBoleto: 'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/ABC123',
    }),
    baixarBoleto: vi.fn().mockResolvedValue(undefined),
    novoServico: vi.fn().mockResolvedValue(undefined),
    capturarScreenshot: vi.fn().mockResolvedValue(null),
    consultarGrusDoCliente: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function montarDeps(overrides: Partial<DependenciasWorker> = {}): DependenciasWorker {
  return {
    db,
    adapter: criarAdapterFalso(),
    workerId: 'worker-1',
    credenciais: { usuario: 'user', senha: 'pass' },
    config: configPadrao,
    logger: criarLoggerFalso(),
    esperaFilaVaziaMs: 10,
    pausaEntreAcoesMinMs: 1,
    pausaEntreAcoesMaxMs: 2,
    ...overrides,
  };
}

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-worker-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
  liberarOperacao(db, '13');
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('executarWorker — idempotência', () => {
  it('pula a emissão e só confirma o status quando o processo já tem nosso_numero', async () => {
    const id = inserirProcesso({ nossoNumero: '99999999999999999' });
    const adapter = criarAdapterFalso();

    await executarWorker(montarDeps({ adapter }));

    expect(adapter.emitirGru).not.toHaveBeenCalled();
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('GRU_EMITIDA');
  });
});

describe('executarWorker — caminho feliz', () => {
  it('emite, baixa o boleto, marca como GRU_EMITIDA e chama novoServico', async () => {
    const id = inserirProcesso();
    const adapter = criarAdapterFalso();

    await executarWorker(montarDeps({ adapter }));

    expect(adapter.baixarBoleto).toHaveBeenCalledWith(
      'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/ABC123',
      expect.stringContaining('940328100-12345678901234567.pdf'),
    );
    expect(adapter.novoServico).toHaveBeenCalledOnce();

    const processo = buscarProcesso(id);
    expect(processo.status).toBe('GRU_EMITIDA');
    expect(processo.nosso_numero).toBe('12345678901234567');
  });
});

describe('executarWorker — erro definitivo', () => {
  it('marca com o status do erro na hora, sem retry, quando o cliente não é encontrado', async () => {
    const id = inserirProcesso();
    const adapter = criarAdapterFalso({
      emitirGru: vi.fn().mockRejectedValue(new ClienteNaoEncontradoError('11144477735')),
    });

    await executarWorker(montarDeps({ adapter }));

    expect(adapter.emitirGru).toHaveBeenCalledOnce();
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('ERRO_CLIENTE_NAO_ENCONTRADO');
    expect(processo.erro_tipo).toBe('ERRO_CLIENTE_NAO_ENCONTRADO');
  });
});

describe('executarWorker — retry', () => {
  it('reautentica e tenta de novo quando a sessão cai, e no fim emite com sucesso', async () => {
    const id = inserirProcesso();
    const emitirGru = vi
      .fn()
      .mockRejectedValueOnce(new SessaoInpiError('sessão caiu'))
      .mockResolvedValueOnce({
        modo: 'emitida',
        nossoNumero: '11111111111111111',
        codigoGru: 'XYZ',
        valorGru: '445,00',
        linkBoleto: 'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/XYZ',
      });
    const adapter = criarAdapterFalso({ emitirGru });

    await executarWorker(montarDeps({ adapter }));

    expect(emitirGru).toHaveBeenCalledTimes(2);
    expect(adapter.login).toHaveBeenCalledTimes(2); // login inicial + reautenticação após a sessão cair
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('GRU_EMITIDA');
  });

  it('marca como falha definitiva quando as tentativas se esgotam', async () => {
    const id = inserirProcesso();
    const adapter = criarAdapterFalso({
      emitirGru: vi.fn().mockRejectedValue(new TimeoutInpiError('sempre demora')),
    });

    await executarWorker(montarDeps({ adapter, config: { ...configPadrao, maxTentativas: 1 } }));

    const processo = buscarProcesso(id);
    expect(processo.status).toBe('ERRO_TIMEOUT');
    expect(processo.erro_mensagem).toMatch(/tentativas esgotadas/);
  });
});

describe('executarWorker — pausa global', () => {
  it('pausa a operação inteira e devolve o processo (não é culpa dele) quando o objeto está indisponível', async () => {
    const id = inserirProcesso();
    const adapter = criarAdapterFalso({
      emitirGru: vi
        .fn()
        .mockRejectedValue(new ObjetoPeticaoIndisponivelError('TPH', ['Outra opção'])),
    });

    const sinal = { parar: false };
    // Depois que a operação pausa, o processo devolvido não seria mais
    // reivindicado (fila pausada) — sem isso o worker ficaria dormindo
    // para sempre no loop de "fila vazia/pausada". Sinaliza parada
    // assim que detecta a pausa, só para o teste não rodar indefinidamente.
    const parar = vi.fn(() => {
      if (obterOperacao(db).status === 'PAUSADA') sinal.parar = true;
    });
    const intervalId = setInterval(parar, 5);

    await executarWorker(montarDeps({ adapter, sinal }));
    clearInterval(intervalId);

    expect(obterOperacao(db).status).toBe('PAUSADA');
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('AGUARDANDO_ABERTURA'); // devolvido, não marcado como erro dele
  });
});

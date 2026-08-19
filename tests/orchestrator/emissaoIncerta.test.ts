import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abrirConexao } from '../../src/db/connection.js';
import { migrar } from '../../src/db/migrate.js';
import { liberarOperacao, obterOperacao } from '../../src/db/operacao.js';
import { TimeoutInpiError } from '../../src/inpi/erros.js';
import type { GruEncontrada } from '../../src/inpi/adapter.js';
import type {
  ConfigWorker,
  DependenciasWorker,
  WorkerAdapter,
} from '../../src/orchestrator/workerLoop.js';
import { executarWorker } from '../../src/orchestrator/workerLoop.js';
import type { Logger } from '../../src/utils/logger.js';

let pastaTemp: string;
let db: Database.Database;

function inserirProcesso(): number {
  const info = db
    .prepare(
      `
      INSERT INTO processos (posicao, fila, titular_documento, numero_processo, objeto_peticao, status)
      VALUES (1, 'PRINCIPAL', '11144477735', '940328100', 'TPH', 'AGUARDANDO_ABERTURA')
    `,
    )
    .run();
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
  valorEsperadoGru: 445,
  pastaGuias: '',
  pastaErros: '',
  horaLimiteEmissao: '22:00',
  hardStop22h: false,
};

function gruEncontrada(overrides: Partial<GruEncontrada> = {}): GruEncontrada {
  return {
    nossoNumero: '12345678901234567',
    servico: '3020 - Trâmite prioritário de marcas',
    valor: '445,00',
    situacao: 'Aguardando pagamento',
    urlSegundaVia: 'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/ABC123',
    dataCadastro: '01/09/2026',
    ...overrides,
  };
}

/**
 * Simula exatamente a janela crítica: o adapter real chama
 * `antesDeConfirmar` logo antes do clique irreversível em "Gerar boleto"
 * e só depois disso pode falhar (timeout esperando o nosso-número,
 * sessão caindo no meio da navegação, etc.). Este fake reproduz esse
 * comportamento sem precisar de Playwright — chama o hook, DEPOIS lança.
 */
function criarAdapterComFalhaPosClique(
  overridesConsulta: Partial<WorkerAdapter> = {},
): WorkerAdapter {
  const emitirGru = vi
    .fn()
    .mockImplementation(
      async (_dados: unknown, opcoes: { antesDeConfirmar?: () => void | Promise<void> } = {}) => {
        await opcoes.antesDeConfirmar?.();
        throw new TimeoutInpiError(
          'timeout esperando #nosso-numero depois de clicar em Gerar boleto',
        );
      },
    );

  return {
    login: vi.fn().mockResolvedValue(undefined),
    emitirGru,
    baixarBoleto: vi.fn().mockResolvedValue(undefined),
    novoServico: vi.fn().mockResolvedValue(undefined),
    capturarScreenshot: vi.fn().mockResolvedValue(null),
    consultarGrusDoCliente: vi.fn().mockResolvedValue([]),
    ...overridesConsulta,
  };
}

function montarDeps(
  adapter: WorkerAdapter,
  overrides: Partial<DependenciasWorker> = {},
): DependenciasWorker {
  return {
    db,
    adapter,
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
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-emissao-incerta-'));
  db = abrirConexao(join(pastaTemp, 'teste.db'));
  migrar(db);
  liberarOperacao(db, '13');
});

afterEach(() => {
  db.close();
  rmSync(pastaTemp, { recursive: true, force: true });
});

describe('janela crítica: falha entre o clique em Gerar boleto e a leitura do resultado', () => {
  it('sempre passa pela reconciliação (nunca pelo retry comum) quando a falha vem depois do clique, mesmo ao esgotar as tentativas', async () => {
    // maxTentativas: 1 força a exaustão já na 1ª falha — o ponto aqui não
    // é quantas vezes tenta, é PARA ONDE vai: mesmo esgotando na hora,
    // ainda precisa ter reconciliado antes (consultarGrusDoCliente
    // chamado) e nunca ter chamado emitirGru uma segunda vez. O status
    // final adota o erro ORIGINAL (ERRO_TIMEOUT) porque a reconciliação
    // já confirmou que não existe guia — deixou de ser "incerto".
    const id = inserirProcesso();
    const adapter = criarAdapterComFalhaPosClique();

    await executarWorker(montarDeps(adapter, { config: { ...configPadrao, maxTentativas: 1 } }));

    expect(adapter.consultarGrusDoCliente).toHaveBeenCalledTimes(1);
    expect(adapter.emitirGru).toHaveBeenCalledTimes(1);
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('ERRO_TIMEOUT');
    expect(processo.erro_mensagem).toMatch(/tentativas esgotadas/);
    expect(processo.erro_mensagem).toMatch(/guia não encontrada na reconciliação/);
  });

  it('NUNCA reemite: quando a reconciliação encontra a guia, completa o processo sem chamar emitirGru de novo', async () => {
    const id = inserirProcesso();
    const gru = gruEncontrada();
    const adapter = criarAdapterComFalhaPosClique({
      consultarGrusDoCliente: vi.fn().mockResolvedValue([gru]),
    });

    await executarWorker(montarDeps(adapter));

    // A prova central: emitirGru foi chamado exatamente uma vez. Se a
    // classificação tivesse caído em RETRY comum (o bug que este teste
    // existe para prevenir), o processo voltaria pra fila e uma segunda
    // chamada a emitirGru teria acontecido, gerando uma segunda guia paga.
    expect(adapter.emitirGru).toHaveBeenCalledTimes(1);
    expect(adapter.consultarGrusDoCliente).toHaveBeenCalledTimes(1);

    const processo = buscarProcesso(id);
    expect(processo.status).toBe('GRU_EMITIDA');
    expect(processo.nosso_numero).toBe(gru.nossoNumero);
  });

  it('baixa a guia pela 2ª via ao reconciliar, sem depender do fluxo normal de emissão', async () => {
    const id = inserirProcesso();
    const gru = gruEncontrada({
      urlSegundaVia: 'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/XYZ',
    });
    const adapter = criarAdapterComFalhaPosClique({
      consultarGrusDoCliente: vi.fn().mockResolvedValue([gru]),
    });

    await executarWorker(montarDeps(adapter));

    expect(adapter.baixarBoleto).toHaveBeenCalledWith(
      gru.urlSegundaVia,
      expect.stringContaining('940328100-12345678901234567.pdf'),
    );
    expect(buscarProcesso(id).status).toBe('GRU_EMITIDA');
  });

  it('fica em EMISSAO_INCERTA (nunca reemite) quando a reconciliação é ambígua — decisão humana, não automática', async () => {
    const id = inserirProcesso();
    const gru1 = gruEncontrada({ nossoNumero: '11111111111111111' });
    const gru2 = gruEncontrada({ nossoNumero: '22222222222222222' });
    const adapter = criarAdapterComFalhaPosClique({
      consultarGrusDoCliente: vi.fn().mockResolvedValue([gru1, gru2]),
    });

    await executarWorker(montarDeps(adapter));

    expect(adapter.emitirGru).toHaveBeenCalledTimes(1);
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('EMISSAO_INCERTA');
    expect(processo.erro_mensagem).toMatch(/ambígua/);
    expect(processo.erro_mensagem).toMatch(/11111111111111111/);
    expect(processo.erro_mensagem).toMatch(/22222222222222222/);
  });

  it('fica em EMISSAO_INCERTA (nunca reemite) quando a própria reconciliação falha', async () => {
    const id = inserirProcesso();
    const adapter = criarAdapterComFalhaPosClique({
      consultarGrusDoCliente: vi
        .fn()
        .mockRejectedValue(new Error('sessão caiu de novo durante a reconciliação')),
    });

    await executarWorker(montarDeps(adapter));

    expect(adapter.emitirGru).toHaveBeenCalledTimes(1);
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('EMISSAO_INCERTA');
  });

  it('quando a reconciliação confirma que a guia NÃO foi criada, devolve à fila e a 2ª tentativa emite normalmente', async () => {
    const id = inserirProcesso();
    const consultarGrusDoCliente = vi.fn().mockResolvedValue([]); // nunca encontra nada -> sempre seguro devolver

    let chamadas = 0;
    const emitirGru = vi
      .fn()
      .mockImplementation(
        async (_dados: unknown, opcoes: { antesDeConfirmar?: () => void | Promise<void> } = {}) => {
          chamadas += 1;
          if (chamadas === 1) {
            await opcoes.antesDeConfirmar?.();
            throw new TimeoutInpiError('timeout na 1ª tentativa');
          }
          return {
            modo: 'emitida' as const,
            nossoNumero: '99999999999999999',
            codigoGru: 'DEF456',
            valorGru: '445,00',
            linkBoleto: 'https://meu.inpi.gov.br/pag/gru/imprimir/codigo/DEF456',
          };
        },
      );

    const adapter: WorkerAdapter = {
      login: vi.fn().mockResolvedValue(undefined),
      emitirGru,
      baixarBoleto: vi.fn().mockResolvedValue(undefined),
      novoServico: vi.fn().mockResolvedValue(undefined),
      capturarScreenshot: vi.fn().mockResolvedValue(null),
      consultarGrusDoCliente,
    };

    await executarWorker(montarDeps(adapter));

    expect(consultarGrusDoCliente).toHaveBeenCalledTimes(1); // reconciliação rodou, confirmou que não existia
    expect(emitirGru).toHaveBeenCalledTimes(2); // só reemitiu DEPOIS de confirmar que a 1ª de fato não criou nada
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('GRU_EMITIDA');
    expect(processo.nosso_numero).toBe('99999999999999999');
  });

  it('não desvia para reconciliação quando a falha acontece ANTES do clique (antesDeConfirmar nunca chamado)', async () => {
    // Controle negativo: prova que o desvio depende de ter passado pelo
    // clique, não de qualquer erro qualquer. Aqui o adapter falha sem
    // nunca invocar antesDeConfirmar — deve seguir o RETRY comum.
    const id = inserirProcesso();
    const consultarGrusDoCliente = vi.fn().mockResolvedValue([]);
    const adapter: WorkerAdapter = {
      login: vi.fn().mockResolvedValue(undefined),
      emitirGru: vi
        .fn()
        .mockRejectedValue(new TimeoutInpiError('timeout antes de qualquer clique')),
      baixarBoleto: vi.fn().mockResolvedValue(undefined),
      novoServico: vi.fn().mockResolvedValue(undefined),
      capturarScreenshot: vi.fn().mockResolvedValue(null),
      consultarGrusDoCliente,
    };

    await executarWorker(montarDeps(adapter, { config: { ...configPadrao, maxTentativas: 1 } }));

    expect(consultarGrusDoCliente).not.toHaveBeenCalled(); // nunca tentou reconciliar — não era EMISSAO_INCERTA
    const processo = buscarProcesso(id);
    expect(processo.status).toBe('ERRO_TIMEOUT'); // caminho de DEFINITIVO/tentativas esgotadas comum, não EMISSAO_INCERTA
  });
});

describe('operacao continua RODANDO', () => {
  it('a operação global não é afetada por um caso de emissão incerta isolado', async () => {
    inserirProcesso();
    const adapter = criarAdapterComFalhaPosClique({
      consultarGrusDoCliente: vi.fn().mockResolvedValue([gruEncontrada()]),
    });

    await executarWorker(montarDeps(adapter));

    expect(obterOperacao(db).status).toBe('RODANDO');
  });
});

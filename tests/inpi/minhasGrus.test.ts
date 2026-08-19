import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdapterInpi, validarPeriodoConsulta } from '../../src/inpi/adapter.js';
import { PeriodoConsultaInvalidoError } from '../../src/inpi/erros.js';
import { reconciliarProcesso } from '../../src/inpi/reconciliacao.js';
import { BASE, ROTAS } from '../../src/inpi/selectors.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

interface GruCenario {
  nossoNumero: string;
  servico: string;
  valor: string;
  situacao: string;
  temSegundaVia: boolean;
  dataCadastro: string;
}

interface Cenario {
  resultadoBusca: string[];
  resultadoGrus: GruCenario[];
}

const cenarioPadrao: Cenario = {
  resultadoBusca: ['**.111.***/0001-**'],
  resultadoGrus: [
    {
      nossoNumero: '12345678901234567',
      servico: '3020 - Trâmite prioritário de marcas',
      valor: '445,00',
      situacao: 'Aguardando pagamento',
      temSegundaVia: true,
      dataCadastro: '19/08/2026',
    },
  ],
};

function renderizarFixture(nomeArquivo: string, cenario: Cenario): string {
  const bruto = readFileSync(`${FIXTURES_DIR}/${nomeArquivo}`, 'utf-8');
  const script = `<script>window.__CENARIO__ = ${JSON.stringify(cenario)};</script>`;
  return bruto.replace('<!-- CENARIO -->', script);
}

async function configurarContexto(browser: Browser, cenarioParcial: Partial<Cenario> = {}) {
  const cenario: Cenario = { ...cenarioPadrao, ...cenarioParcial };
  const context = await browser.newContext();

  // Mesma rede de segurança da Etapa 2: bloqueia tudo por padrão, depois
  // registra só as rotas explicitamente servidas por fixtures locais.
  await context.route('**/*', (route) => route.abort('blockedbyclient'));

  const minhasGrusHtml = renderizarFixture('minhas-grus.html', cenario);
  await context.route(ROTAS.minhasGrus, (route) =>
    route.fulfill({ contentType: 'text/html', body: minhasGrusHtml }),
  );

  return { context, cenario };
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

let contextosAbertos: BrowserContext[] = [];

afterEach(async () => {
  await Promise.all(contextosAbertos.map((c) => c.close()));
  contextosAbertos = [];
});

async function criarAdapter(cenarioParcial: Partial<Cenario> = {}) {
  const { context, cenario } = await configurarContexto(browser, cenarioParcial);
  contextosAbertos.push(context);
  const adapter = await AdapterInpi.criar(context);
  return { adapter, context, cenario };
}

const DOCUMENTO = '111.444.777-35';
const INICIO = new Date('2026-08-19');
const FIM = new Date('2026-08-19');

describe('validarPeriodoConsulta (pura, sem navegador)', () => {
  it('aceita um período de exatamente 30 dias', () => {
    expect(() =>
      validarPeriodoConsulta(new Date('2026-08-01'), new Date('2026-08-31')),
    ).not.toThrow();
  });

  it('rejeita um período de 31 dias', () => {
    expect(() => validarPeriodoConsulta(new Date('2026-08-01'), new Date('2026-09-01'))).toThrow(
      PeriodoConsultaInvalidoError,
    );
  });

  it('rejeita data fim anterior à data início', () => {
    expect(() => validarPeriodoConsulta(new Date('2026-08-19'), new Date('2026-08-01'))).toThrow(
      PeriodoConsultaInvalidoError,
    );
  });
});

describe('consultarGrusDoCliente', () => {
  it('retorna lista vazia quando o titular não tem GRU no período', async () => {
    const { adapter } = await criarAdapter({ resultadoGrus: [] });
    const resultado = await adapter.consultarGrusDoCliente(DOCUMENTO, INICIO, FIM);
    expect(resultado).toEqual([]);
  });

  it('lê uma única GRU, extraindo colunas por posição e resolvendo a URL da 2ª via', async () => {
    const { adapter } = await criarAdapter();
    const resultado = await adapter.consultarGrusDoCliente(DOCUMENTO, INICIO, FIM);

    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toEqual({
      nossoNumero: '12345678901234567',
      servico: '3020 - Trâmite prioritário de marcas',
      valor: '445,00',
      situacao: 'Aguardando pagamento',
      urlSegundaVia: `${BASE}/gru/imprimir/codigo/12345678901234567`,
      dataCadastro: '19/08/2026',
    });
  });

  it('lê múltiplas GRUs do mesmo titular sem tentar decidir qual é a certa', async () => {
    const { adapter } = await criarAdapter({
      resultadoGrus: [
        {
          nossoNumero: '11111111111111111',
          servico: '3020 - Trâmite prioritário de marcas',
          valor: '445,00',
          situacao: 'Paga',
          temSegundaVia: true,
          dataCadastro: '19/08/2026',
        },
        {
          nossoNumero: '22222222222222222',
          servico: '3020 - Trâmite prioritário de marcas',
          valor: '445,00',
          situacao: 'Aguardando pagamento',
          temSegundaVia: false,
          dataCadastro: '19/08/2026',
        },
      ],
    });

    const resultado = await adapter.consultarGrusDoCliente(DOCUMENTO, INICIO, FIM);

    expect(resultado).toHaveLength(2);
    expect(resultado.map((g) => g.nossoNumero)).toEqual(['11111111111111111', '22222222222222222']);
    expect(resultado[1]?.urlSegundaVia).toBeNull(); // sem link ainda — não inventa um
  });

  it('nunca toca a página quando o período pedido passa de 30 dias', async () => {
    const { adapter } = await criarAdapter();
    const inicio = new Date('2026-01-01');
    const fimAlemDoLimite = new Date('2026-03-01'); // ~59 dias

    await expect(
      adapter.consultarGrusDoCliente(DOCUMENTO, inicio, fimAlemDoLimite),
    ).rejects.toThrow(PeriodoConsultaInvalidoError);
    // Se tivesse tentado navegar, teria caído no bloqueio catch-all da
    // rede (route abortada) em vez do erro de validação — o fato de o
    // erro ser especificamente PeriodoConsultaInvalidoError já prova que
    // a validação rodou antes de qualquer goto/click.
  });
});

describe('reconciliarProcesso', () => {
  const processo = { titularDocumento: DOCUMENTO, dataOperacao: new Date('2026-09-01') };

  it('NENHUMA_ENCONTRADA quando não há guia 3020 para o titular na data', async () => {
    const consulta = { consultarGrusDoCliente: () => Promise.resolve([]) };
    const resultado = await reconciliarProcesso(consulta, processo);
    expect(resultado).toEqual({ status: 'NENHUMA_ENCONTRADA', candidatas: [] });
  });

  it('ENCONTRADA_UNICA quando há exatamente uma guia 3020', async () => {
    const gru = {
      nossoNumero: '1',
      servico: '3020 - Trâmite prioritário de marcas',
      valor: '445,00',
      situacao: 'Paga',
      urlSegundaVia: null,
      dataCadastro: '01/09/2026',
    };
    const consulta = { consultarGrusDoCliente: () => Promise.resolve([gru]) };
    const resultado = await reconciliarProcesso(consulta, processo);
    expect(resultado).toEqual({ status: 'ENCONTRADA_UNICA', candidatas: [gru] });
  });

  it('AMBIGUA e retorna as duas candidatas, sem escolher sozinha, quando há mais de uma guia 3020', async () => {
    const gru1 = {
      nossoNumero: '1',
      servico: '3020 - Trâmite prioritário de marcas',
      valor: '445,00',
      situacao: 'Paga',
      urlSegundaVia: null,
      dataCadastro: '01/09/2026',
    };
    const gru2 = { ...gru1, nossoNumero: '2' };
    const consulta = { consultarGrusDoCliente: () => Promise.resolve([gru1, gru2]) };
    const resultado = await reconciliarProcesso(consulta, processo);
    expect(resultado.status).toBe('AMBIGUA');
    expect(resultado.candidatas).toEqual([gru1, gru2]);
  });

  it('ignora guias de outros serviços que não o 3020', async () => {
    const outroServico = {
      nossoNumero: '9',
      servico: '3040 - Outro serviço qualquer',
      valor: '100,00',
      situacao: 'Paga',
      urlSegundaVia: null,
      dataCadastro: '01/09/2026',
    };
    const consulta = { consultarGrusDoCliente: () => Promise.resolve([outroServico]) };
    const resultado = await reconciliarProcesso(consulta, processo);
    expect(resultado).toEqual({ status: 'NENHUMA_ENCONTRADA', candidatas: [] });
  });
});

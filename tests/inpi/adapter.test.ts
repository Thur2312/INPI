import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdapterInpi } from '../../src/inpi/adapter.js';
import {
  CaptchaDetectadoError,
  ClienteAmbiguoError,
  ClienteNaoEncontradoError,
  ObjetoPeticaoIndisponivelError,
  SessaoInpiError,
  ValorInesperadoError,
} from '../../src/inpi/erros.js';
import { BASE, CLIENTE, ROTAS } from '../../src/inpi/selectors.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

interface Cenario {
  usuarioValido: string;
  senhaValida: string;
  sessaoValida: boolean;
  mostrarCaptcha: boolean;
  resultadoBusca: string[];
  opcoesObjeto: string[];
  valorGru: string;
  nossoNumero: string;
  linkBoletoRelativo: string;
  rotaGerar: string;
  rotaFinalizada: string;
  /** Ver comentário em `AdapterInpi.aguardarCampoProcessoComRetry` e na fixture `gru.html`. */
  tentativasRevelarProcesso?: number;
}

const cenarioPadrao: Cenario = {
  usuarioValido: 'usuario_teste',
  senhaValida: 'senha_teste',
  sessaoValida: true,
  mostrarCaptcha: false,
  resultadoBusca: ['**.111.***/0001-**'],
  opcoesObjeto: ['TPH', 'Ação na justiça', 'Start-ups'],
  valorGru: '445,00',
  nossoNumero: '12345678901234567',
  linkBoletoRelativo: '/pag/gru/imprimir/codigo/ABC123XYZ',
  rotaGerar: ROTAS.gerar,
  rotaFinalizada: ROTAS.finalizada,
};

function renderizarFixture(nomeArquivo: string, cenario: Cenario): string {
  const bruto = readFileSync(join(FIXTURES_DIR, nomeArquivo), 'utf-8');
  const captcha = cenario.mostrarCaptcha
    ? `document.write('<iframe src="about:blank?recaptcha" title="captcha"></iframe>');`
    : '';
  const script = `<script>window.__CENARIO__ = ${JSON.stringify(cenario)};${captcha}</script>`;
  return bruto.replace('<!-- CENARIO -->', script);
}

/**
 * Registra um bloqueio total de rede como padrão (nenhuma requisição sai
 * para a internet real por engano) e, por cima, as rotas específicas que
 * servem os fixtures locais para as URLs reais do INPI — a única forma
 * segura de testar contra `https://meu.inpi.gov.br` sem nunca falar com o
 * domínio de verdade. Rotas registradas depois têm prioridade sobre as de
 * antes (confirmado experimentalmente com esta versão do Playwright).
 */
async function configurarContexto(browser: Browser, cenarioParcial: Partial<Cenario> = {}) {
  const cenario: Cenario = { ...cenarioPadrao, ...cenarioParcial };
  const context = await browser.newContext();

  await context.route('**/*', (route) => route.abort('blockedbyclient'));

  const loginHtml = renderizarFixture('login.html', cenario);
  const gruHtml = renderizarFixture('gru.html', cenario);
  const finalizadaHtml = renderizarFixture('finalizada.html', cenario);

  await context.route(`${BASE}/`, (route) =>
    route.fulfill({ contentType: 'text/html', body: loginHtml }),
  );
  await context.route(ROTAS.gerar, async (route) => {
    const cookies = await context.cookies();
    const temSessao = cookies.some((c) => c.name === 'sessaoInpiTeste');
    const logado = cenario.sessaoValida && temSessao;
    return route.fulfill({ contentType: 'text/html', body: logado ? gruHtml : loginHtml });
  });
  await context.route(ROTAS.finalizada, (route) =>
    route.fulfill({ contentType: 'text/html', body: finalizadaHtml }),
  );
  await context.route(ROTAS.sair, (route) =>
    route.fulfill({ contentType: 'text/html', body: loginHtml }),
  );

  return { context, cenario };
}

const dadosEmissaoPadrao = {
  titularDocumento: '111.444.777-35',
  numeroProcesso: '940328100',
  objetoPeticaoTexto: 'TPH',
  valorEsperado: 445,
};

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

describe('login / estaLogado / logout', () => {
  it('autentica e conclui quando as credenciais batem', async () => {
    const { adapter, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);
    expect(await adapter.estaLogado()).toBe(true);
  });

  it('lança SessaoInpiError quando as credenciais não batem', async () => {
    const { adapter, cenario } = await criarAdapter();
    await expect(adapter.login(cenario.usuarioValido, 'senha-errada')).rejects.toThrow(
      SessaoInpiError,
    );
  });

  it('estaLogado retorna false quando a sessão caiu (INPI redireciona pro login)', async () => {
    const { adapter } = await criarAdapter({ sessaoValida: false });
    expect(await adapter.estaLogado()).toBe(false);
  });

  it('logout navega para a rota de encerrar sessão', async () => {
    const { adapter, context, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);
    await adapter.logout();
    const [page] = context.pages();
    expect(page?.url()).toBe(ROTAS.sair);
  });
});

describe('emitirGru — caminho feliz', () => {
  it('emite a GRU e retorna nossoNumero/codigoGru/valorGru/linkBoleto', async () => {
    const { adapter, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    const resultado = await adapter.emitirGru(dadosEmissaoPadrao);

    expect(resultado.modo).toBe('emitida');
    if (resultado.modo !== 'emitida') throw new Error('esperava modo emitida');
    expect(resultado.nossoNumero).toBe(cenario.nossoNumero);
    expect(resultado.codigoGru).toBe('ABC123XYZ');
    expect(resultado.linkBoleto).toBe(`${BASE}/gru/imprimir/codigo/ABC123XYZ`);
    expect(resultado.valorGru).toBe('445,00');
    // 'TPH' é a 1ª opção do dropdown no cenário padrão — value é o índice (1-based) que o fixture atribui.
    expect(resultado.objetoPeticaoValue).toBe('1');
  });
});

describe('emitirGru — instabilidade do campo "Processo administrativo"', () => {
  it('refaz a seleção do serviço 3020 e segue em frente quando a revelação do campo demora além da 1ª tentativa', async () => {
    const { adapter, cenario } = await criarAdapter({ tentativasRevelarProcesso: 2 });
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    const resultado = await adapter.emitirGru(dadosEmissaoPadrao);

    expect(resultado.modo).toBe('emitida');
  }, 35_000);
});

describe('emitirGru — os três detalhes do fluxo real', () => {
  it('lança ClienteNaoEncontradoError quando a busca não retorna nenhuma linha', async () => {
    const { adapter, cenario } = await criarAdapter({ resultadoBusca: [] });
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    await expect(adapter.emitirGru(dadosEmissaoPadrao)).rejects.toThrow(ClienteNaoEncontradoError);
  });

  it('lança ClienteAmbiguoError quando a busca retorna mais de uma linha (documento vem mascarado)', async () => {
    const { adapter, cenario } = await criarAdapter({
      resultadoBusca: ['**.111.***/0001-**', '**.222.***/0001-**'],
    });
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    await expect(adapter.emitirGru(dadosEmissaoPadrao)).rejects.toThrow(ClienteAmbiguoError);
  });

  it('lança ObjetoPeticaoIndisponivelError listando as opções existentes quando o texto não bate', async () => {
    const { adapter, cenario } = await criarAdapter({ opcoesObjeto: ['TPH', 'Start-ups'] });
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    let erro: unknown;
    try {
      await adapter.emitirGru({
        ...dadosEmissaoPadrao,
        objetoPeticaoTexto: 'Plataforma de Mercado Virtual',
      });
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(ObjetoPeticaoIndisponivelError);
    expect((erro as ObjetoPeticaoIndisponivelError).opcoesDisponiveis).toEqual([
      'Selecione',
      'TPH',
      'Start-ups',
    ]);
  });

  it('lança ValorInesperadoError e cancela o serviço (nunca clica em Gerar boleto) quando o valor não bate', async () => {
    const { adapter, context, cenario } = await criarAdapter({ valorGru: '999,00' });
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    await expect(adapter.emitirGru(dadosEmissaoPadrao)).rejects.toThrow(ValorInesperadoError);

    const [page] = context.pages();
    const cancelado = await page?.evaluate(
      () => (globalThis as Record<string, unknown>)['__CANCELADO__'],
    );
    expect(cancelado).toBe(true);
  });
});

describe('emitirGru — modo ensaio (--dry-run)', () => {
  it('para antes do Gerar boleto, não gera guia, mas registra o valor lido', async () => {
    const { adapter, context, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    const resultado = await adapter.emitirGru(dadosEmissaoPadrao, { dryRun: true });

    expect(resultado).toEqual({ modo: 'dry-run', valorConferido: '445,00', objetoPeticaoValue: '1' });
    const [page] = context.pages();
    expect(page?.url()).toBe(ROTAS.gerar); // nunca navegou para a tela finalizada
  });

  it('permite encadear vários itens em sequência sem novoServico() — cancelar já devolve a tela de busca', async () => {
    const { adapter, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    const primeiro = await adapter.emitirGru(dadosEmissaoPadrao, { dryRun: true });
    const segundo = await adapter.emitirGru(
      { ...dadosEmissaoPadrao, numeroProcesso: '940328200' },
      { dryRun: true },
    );

    expect(primeiro.modo).toBe('dry-run');
    expect(segundo.modo).toBe('dry-run');
  }, 30_000);
});

describe('novoServico', () => {
  it('volta para uma tela de busca de cliente limpa, sem refazer login', async () => {
    const { adapter, context, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);
    await adapter.emitirGru(dadosEmissaoPadrao);

    await adapter.novoServico();

    const [page] = context.pages();
    expect(page?.url()).toBe(ROTAS.gerar);
    expect(await page!.locator(CLIENTE.abrirBusca).isVisible()).toBe(true);
  }, 20_000);
});

describe('capturarScreenshot', () => {
  it('retorna null e não grava arquivo quando há campo de senha visível na tela', async () => {
    const { adapter, context } = await criarAdapter();
    const [page] = context.pages();
    await page!.goto(`${BASE}/`);

    const pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-screenshot-'));
    const destino = join(pastaTemp, 'tela.png');

    const resultado = await adapter.capturarScreenshot(destino);

    expect(resultado).toBeNull();
    expect(existsSync(destino)).toBe(false);
    rmSync(pastaTemp, { recursive: true, force: true });
  });

  it('captura normalmente quando não há campo de senha visível', async () => {
    const { adapter, cenario } = await criarAdapter();
    await adapter.login(cenario.usuarioValido, cenario.senhaValida);

    const pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-screenshot-'));
    const destino = join(pastaTemp, 'tela.png');

    const resultado = await adapter.capturarScreenshot(destino);

    expect(resultado).toBe(destino);
    expect(existsSync(destino)).toBe(true);
    rmSync(pastaTemp, { recursive: true, force: true });
  });
});

describe('detecção de captcha', () => {
  it('lança CaptchaDetectadoError e não tenta resolver nada', async () => {
    const { adapter, cenario } = await criarAdapter({ mostrarCaptcha: true });
    await expect(adapter.login(cenario.usuarioValido, cenario.senhaValida)).rejects.toThrow(
      CaptchaDetectadoError,
    );
  });
});

describe('baixarBoleto', () => {
  let servidor: Server;
  let porta: number;
  const conteudoFalso = Buffer.from('%PDF-FAKE-CONTENT-PARA-TESTE');

  beforeEach(async () => {
    // Servidor HTTP local de verdade — nunca o domínio real do INPI.
    // `context.request.get()` comprovadamente NÃO respeita `context.route()`
    // nesta versão do Playwright, então interceptar o domínio real não
    // seria seguro para este método.
    await new Promise<void>((resolve) => {
      servidor = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(conteudoFalso);
      });
      servidor.listen(0, '127.0.0.1', () => resolve());
    });
    const endereco = servidor.address();
    porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  });

  it('baixa os bytes via context.request e grava exatamente no disco', async () => {
    const { adapter } = await criarAdapter();
    const pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-boleto-'));
    const destino = join(pastaTemp, 'boleto.pdf');

    await adapter.baixarBoleto(`http://127.0.0.1:${porta}/boleto.pdf`, destino);

    expect(readFileSync(destino)).toEqual(conteudoFalso);
    rmSync(pastaTemp, { recursive: true, force: true });
  });
});

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { CODIGO_SERVICO_3020, TIPO_SERVICO_MARCAS_VALUE } from '../config/constants.js';
import {
  CaptchaDetectadoError,
  ClienteAmbiguoError,
  ClienteNaoEncontradoError,
  ErroDesconhecidoInpi,
  ObjetoPeticaoIndisponivelError,
  PeriodoConsultaInvalidoError,
  SessaoInpiError,
  ValorInesperadoError,
} from './erros.js';
import {
  BASE,
  CAPTCHA_SELETORES,
  CLIENTE,
  CONFERENCIA,
  FINALIZADA,
  LOGIN,
  MINHAS_GRUS,
  MINHAS_GRUS_MAX_DIAS,
  ROTAS,
  SERVICO,
  SERVICO_SELECT2,
} from './selectors.js';

export interface DadosEmissaoGru {
  /** CPF/CNPJ do titular — validar dígito verificador *antes* de chamar isso (camada de validação). */
  titularDocumento: string;
  numeroProcesso: string;
  /**
   * Texto a ser casado por regex contra as opções do dropdown de objeto da
   * petição — nunca um `value` fixo (a modalidade pode não existir ainda
   * no ar; ver `ObjetoPeticaoIndisponivelError`).
   */
  objetoPeticaoTexto: string;
  /** Valor esperado da guia, em reais (ex.: 445.00), conferido antes da ação irreversível. */
  valorEsperado: number;
}

export type ResultadoEmissaoGru =
  | {
      modo: 'emitida';
      nossoNumero: string;
      codigoGru: string;
      valorGru: string;
      linkBoleto: string;
      /** `value` real do `<option>` de objeto da petição casado pelo regex — ver `preencherServico`. */
      objetoPeticaoValue: string;
    }
  | {
      modo: 'dry-run';
      valorConferido: string;
      objetoPeticaoValue: string;
    };

export interface GruEncontrada {
  nossoNumero: string;
  servico: string;
  valor: string;
  situacao: string;
  /**
   * Fallback para recuperar o PDF quando o arquivo local se perdeu — passe
   * direto para `baixarBoleto(urlSegundaVia, destino)`, já reaproveita
   * `context.request.get`.
   */
  urlSegundaVia: string | null;
  dataCadastro: string;
}

/**
 * Único ponto do projeto que fala com a interface do INPI. Nada fora
 * daqui deve conhecer um seletor — quando o INPI mudar uma tela, o
 * ajuste é neste arquivo (e em `selectors.ts`).
 *
 * Não introduz pausas artificiais entre ações (ritmo humano, backoff): é
 * responsabilidade do orquestrador (Etapa 3), que sabe quantos workers
 * estão rodando e pode calibrar o ritmo — o adapter fica determinístico e
 * fácil de testar contra fixtures.
 */
export class AdapterInpi {
  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  static async criar(context: BrowserContext): Promise<AdapterInpi> {
    const page = await context.newPage();
    return new AdapterInpi(context, page);
  }

  async login(usuario: string, senha: string): Promise<void> {
    await this.page.goto(`${BASE}/`);
    await this.page.waitForSelector(LOGIN.form);
    await this.page.fill(LOGIN.usuario, usuario);
    await this.page.fill(LOGIN.senha, senha);
    await this.page.click(LOGIN.submit);
    // O submit pode disparar uma navegação (sucesso) ou ficar na mesma
    // página (credenciais erradas). Espera o load state assentar antes de
    // checar captcha — sem isso, há uma corrida em que a checagem roda
    // contra o documento antigo, ainda no meio da troca de página.
    await this.page.waitForLoadState('load');
    await this.verificarCaptcha();

    const logado = await this.estaLogado();
    if (!logado) {
      throw new SessaoInpiError(
        'login falhou: formulário de login ainda presente após submeter (credenciais incorretas ou sessão rejeitada)',
      );
    }
  }

  /**
   * Navega para a tela de geração de GRU e verifica se ainda está
   * autenticado (se caiu, o INPI redireciona de volta ao formulário de
   * login). Só faz sentido chamar isso quando não há uma emissão em
   * andamento — não interrompe um fluxo já aberto na tela de conferência.
   */
  async estaLogado(): Promise<boolean> {
    await this.page.goto(ROTAS.gerar);
    const [temFormLogin, temBuscaCliente] = await Promise.all([
      this.page.locator(LOGIN.form).count(),
      this.page.locator(CLIENTE.abrirBusca).count(),
    ]);
    return temFormLogin === 0 && temBuscaCliente > 0;
  }

  async logout(): Promise<void> {
    await this.page.goto(ROTAS.sair);
  }

  /**
   * Checa se um objeto de petição já está disponível no dropdown, sem
   * passar pelo resto do fluxo (sem selecionar cliente nem preencher
   * processo). Usado pelo verificador único de abertura de cota — ele
   * faz o polling, não cada worker, exatamente para não gerar 4 workers
   * batendo no INPI em loop ao mesmo tempo.
   *
   * Assume que o dropdown de objeto é populado a partir do tipo de
   * serviço (Marcas/3020) selecionado, independente de cliente —
   * confirmado contra o sistema real via --dry-run em 25/08/2026.
   */
  async objetoPeticaoDisponivel(
    textoBuscado: string,
  ): Promise<{ encontrado: boolean; value: string | null; opcoesAtuais: readonly string[] }> {
    if (this.page.url().startsWith(ROTAS.gerar)) {
      await this.page.reload();
    } else {
      await this.page.goto(ROTAS.gerar);
    }
    await this.page.selectOption(SERVICO.tipo, TIPO_SERVICO_MARCAS_VALUE);
    await this.page.waitForSelector(`${SERVICO.codigo} option[value="${CODIGO_SERVICO_3020}"]`, {
      state: 'attached',
    });
    await this.selecionarServico3020ComRetry();

    const opcoes = this.page.locator(`${SERVICO.objeto} option`);
    const textos = await opcoes.allTextContents();
    const values = await opcoes.evaluateAll((elementos) =>
      elementos.map((el) => (el as unknown as { value: string }).value),
    );

    const regex = new RegExp(escapeRegExp(textoBuscado), 'i');
    const indice = textos.findIndex((texto) => regex.test(texto));

    return {
      encontrado: indice !== -1,
      value: indice !== -1 ? (values[indice] ?? null) : null,
      opcoesAtuais: textos,
    };
  }

  /**
   * Consulta as GRUs de um titular num intervalo de datas — rede de
   * segurança de reconciliação, não parte do fluxo de emissão. A tela não
   * tem listagem geral da conta: a busca é sempre por cliente, o que já
   * torna isso uma ferramenta pontual (não uma varredura em massa) por
   * natureza. Reaproveita o mesmo modal de seleção de cliente da emissão
   * — mesma regra de "exatamente uma linha", mesmo erro se ambíguo.
   */
  async consultarGrusDoCliente(
    documento: string,
    inicio: Date,
    fim: Date,
  ): Promise<GruEncontrada[]> {
    validarPeriodoConsulta(inicio, fim);

    if (!this.page.url().startsWith(ROTAS.minhasGrus)) {
      await this.page.goto(ROTAS.minhasGrus);
    }

    await this.selecionarCliente(documento);

    await this.page.check(MINHAS_GRUS.radioData);
    await this.page.fill(MINHAS_GRUS.dataInicio, formatarDataBr(inicio));
    await this.page.fill(MINHAS_GRUS.dataFim, formatarDataBr(fim));
    await this.page.click(MINHAS_GRUS.pesquisar);
    // Mesmo motivo de `selecionarCliente`: zero resultados é um estado
    // legítimo aqui (título sem nenhuma GRU no período), então não espera
    // a tabela ficar "visível" — espera a rede assentar e lê direto.
    await this.page.waitForLoadState('networkidle');

    return this.lerTabelaGrus();
  }

  /**
   * Percorre o fluxo completo de emissão. Se `dados.valorEsperado` não
   * bater com o valor lido na tela de conferência, cancela o serviço e
   * lança `ValorInesperadoError` — nunca clica em "Gerar boleto" com um
   * valor não conferido.
   *
   * Em modo ensaio, para exatamente antes do clique em "Gerar boleto"
   * (nenhuma guia é gerada) e retorna o valor lido para auditoria.
   *
   * `antesDeConfirmar`, se fornecido, roda logo antes desse clique — o
   * ponto exato em que a ação se torna irreversível (a guia passa a
   * existir no INPI). É o gancho que o worker usa para gravar um estado
   * intermediário no banco *antes* de arriscar a rede: se qualquer coisa
   * falhar entre o clique e a leitura do resultado (timeout, sessão
   * caindo, navegação incompleta), o processo já está marcado como
   * "emissão incerta" e nunca é reemitido às cegas — vira reconciliação,
   * não retry. O adapter não sabe nada sobre banco; só expõe o momento.
   */
  async emitirGru(
    dados: DadosEmissaoGru,
    opcoes: { dryRun?: boolean; antesDeConfirmar?: () => void | Promise<void> } = {},
  ): Promise<ResultadoEmissaoGru> {
    if (!this.page.url().startsWith(ROTAS.gerar)) {
      await this.page.goto(ROTAS.gerar);
    }

    await this.selecionarCliente(dados.titularDocumento);
    const objetoPeticaoValue = await this.preencherServico(dados);
    await this.page.click(SERVICO.confirmar);
    // Mesmo raciocínio de `selecionarCliente`: a tela de conferência é
    // montada de forma assíncrona (mesma URL, sem navegação) — espera a
    // rede assentar em vez de esperar um elemento específico ficar
    // visível, que pode ter conteúdo vazio até a resposta chegar.
    await this.page.waitForLoadState('networkidle');
    await this.verificarCaptcha();

    const valorConferido = await this.conferirValor(dados.valorEsperado);

    if (opcoes.dryRun) {
      await this.page.click(CONFERENCIA.cancelar);
      return { modo: 'dry-run', valorConferido, objetoPeticaoValue };
    }

    await opcoes.antesDeConfirmar?.();

    await this.page.click(CONFERENCIA.gerarBoleto);
    // Mesma corrida do login: este clique navega para a tela finalizada.
    await this.page.waitForLoadState('load');
    await this.verificarCaptcha();
    await this.page.waitForSelector(FINALIZADA.nossoNumero);

    return this.lerResultadoFinalizada(valorConferido, objetoPeticaoValue);
  }

  /** Reseta a tela de geração para o próximo serviço, sem refazer login. */
  async novoServico(): Promise<void> {
    await this.page.click(FINALIZADA.novoServico);
    await this.page.waitForSelector(CLIENTE.abrirBusca);
  }

  /**
   * O PDF é GET direto — nada de popup/evento de download. Reaproveita os
   * cookies da sessão via `context.request` e grava o buffer em disco.
   */
  async baixarBoleto(linkBoleto: string, destinoPdf: string): Promise<void> {
    const resposta = await this.context.request.get(linkBoleto);
    if (!resposta.ok()) {
      throw new ErroDesconhecidoInpi(
        `download do boleto falhou: HTTP ${resposta.status()} (${linkBoleto})`,
      );
    }
    const buffer = await resposta.body();
    await mkdir(dirname(destinoPdf), { recursive: true });
    await writeFile(destinoPdf, buffer);
  }

  /**
   * Screenshot automático de diagnóstico, mas nunca de uma tela com campo
   * de senha visível (login, ou o modal de troca de senha que pode
   * aparecer em outras telas) — retorna `null` em vez de capturar.
   */
  async capturarScreenshot(caminhoPng: string): Promise<string | null> {
    const temCampoSenha = await this.page.locator('input[type="password"]:visible').count();
    if (temCampoSenha > 0) {
      return null;
    }
    await mkdir(dirname(caminhoPng), { recursive: true });
    await this.page.screenshot({ path: caminhoPng, fullPage: true });
    return caminhoPng;
  }

  // --- passos internos do fluxo de emissão ---

  private async selecionarCliente(titularDocumento: string): Promise<void> {
    await this.page.click(CLIENTE.abrirBusca);
    await this.page.waitForSelector(CLIENTE.modal);
    await this.page.check(CLIENTE.radioDocumento);
    await this.page.fill(CLIENTE.campoBusca, titularDocumento);
    await this.page.click(CLIENTE.pesquisar);
    // Não espera CLIENTE.tabela ficar "visível": uma busca com zero
    // resultados deixa a tabela sem <tr>, e um container vazio pode ter
    // bounding box zero — o Playwright trataria isso como "não visível" e
    // ficaria esperando até o timeout mesmo num caso legítimo de
    // ClienteNaoEncontradoError. Espera a rede assentar (a busca é
    // assíncrona) e então lê a contagem de linhas diretamente, que é
    // válida tanto para zero quanto para N resultados.
    await this.page.waitForLoadState('networkidle');

    const linhas = this.page.locator(CLIENTE.linhas);
    const total = await linhas.count();

    if (total === 0) {
      throw new ClienteNaoEncontradoError(titularDocumento);
    }
    if (total > 1) {
      // Documento vem mascarado na tela — não há como o robô desempatar
      // sozinho. Decisão humana, não automática.
      throw new ClienteAmbiguoError(titularDocumento, total);
    }

    await linhas.first().locator(CLIENTE.selecionar).click();
  }

  /**
   * Retorna o `value` real do `<option>` casado pelo regex — não é o texto
   * visível, é o atributo que o form efetivamente envia. Documentar esse
   * valor no log (ver `workerLoop`/`dryRun`) é o que permite depurar rápido
   * no dia da operação se o INPI trocar o value sem avisar.
   */
  private async preencherServico(dados: DadosEmissaoGru): Promise<string> {
    await this.page.selectOption(SERVICO.tipo, TIPO_SERVICO_MARCAS_VALUE);
    // Espera o <option> do serviço 3020 existir de verdade antes de
    // selecioná-lo — sem isso, `selecionarServico3020ComRetry` pode
    // disparar o change contra um <select> ainda sendo populado pelo AJAX
    // de `buscar/servico/diretoria/{tipo}` (ver comentário lá embaixo).
    // `state: 'attached'`, não o padrão 'visible': um <option> nunca tem
    // bounding box enquanto o <select> está fechado — esperar 'visible'
    // trava para sempre.
    await this.page.waitForSelector(`${SERVICO.codigo} option[value="${CODIGO_SERVICO_3020}"]`, {
      state: 'attached',
    });

    const opcoes = await this.selecionarServico3020ComRetry();
    const regex = new RegExp(escapeRegExp(dados.objetoPeticaoTexto), 'i');
    const opcaoEncontrada = opcoes.find((texto) => regex.test(texto));

    if (!opcaoEncontrada) {
      throw new ObjetoPeticaoIndisponivelError(dados.objetoPeticaoTexto, opcoes);
    }

    await this.page.selectOption(SERVICO.objeto, { label: opcaoEncontrada });
    await this.page.fill(SERVICO.processo, dados.numeroProcesso);
    return this.page.locator(SERVICO.objeto).inputValue();
  }

  /**
   * Seleciona o serviço 3020 e devolve as opções do dropdown de objeto da
   * petição que essa seleção popula.
   *
   * `#select-servico` (`SERVICO.codigo`) é escondido pelo select2 — usar
   * `page.selectOption` direto nele (com `force`, senão o Playwright
   * espera uma visibilidade que nunca vem) chega a marcar o valor certo,
   * mas o handler do INPI que popula `SERVICO.objeto` fica vazio: ele
   * depende de algo do próprio fluxo de seleção do widget select2, não só
   * do evento `change` final no `<select>` nativo (confirmado em teste
   * manual contra o site real — `force` nunca populou o objeto, um clique
   * de verdade no widget populou). Por isso aqui é clique real: abre o
   * widget, filtra pelo código no campo de busca (a classe "autocomplete"
   * do `<select>` original liga essa busca) e clica no resultado.
   *
   * O motivo do retry: mesmo clicando de verdade, a mesma sequência às
   * vezes dispara `GET .../pesquisar/servico/3020/diretoria/300` (correto,
   * popula o objeto) e às vezes `.../diretoria/` com o código da diretoria
   * vazio (404, objeto fica vazio) — sem diferença observável do lado do
   * Playwright, aparenta ser uma corrida interna do JS do INPI. Repetir a
   * interação dá outra chance de a corrida resolver a favor.
   */
  private async selecionarServico3020ComRetry(): Promise<string[]> {
    const MAX_TENTATIVAS = 3;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
      await this.page.click(SERVICO_SELECT2.widget);
      await this.page.waitForSelector(SERVICO_SELECT2.resultados);

      const campoBusca = this.page.locator(SERVICO_SELECT2.campoBusca);
      if ((await campoBusca.count()) > 0) {
        await campoBusca.fill(CODIGO_SERVICO_3020);
      }

      await this.page
        .locator(SERVICO_SELECT2.resultados, { hasText: CODIGO_SERVICO_3020 })
        .first()
        .click();
      await this.page.waitForLoadState('networkidle');

      const opcoes = await this.page.locator(`${SERVICO.objeto} option`).allTextContents();
      // "--Selecione--" sozinho = a corrida deu ruim e o objeto não populou.
      if (opcoes.length > 1) {
        return opcoes;
      }
      if (tentativa < MAX_TENTATIVAS) {
        await this.page.waitForTimeout(500);
      }
    }

    return [];
  }

  private async conferirValor(valorEsperado: number): Promise<string> {
    const valorTexto = (await this.page.locator(CONFERENCIA.valorTotal).innerText()).trim();
    const valorNumerico = parseValorBr(valorTexto);

    if (valorNumerico === null || Math.abs(valorNumerico - valorEsperado) > 0.001) {
      await this.page.click(CONFERENCIA.cancelar);
      throw new ValorInesperadoError(valorEsperado, valorNumerico ?? Number.NaN);
    }

    return valorTexto;
  }

  private async lerResultadoFinalizada(
    valorGru: string,
    objetoPeticaoValue: string,
  ): Promise<ResultadoEmissaoGru> {
    const nossoNumero = (await this.page.locator(FINALIZADA.nossoNumero).innerText()).trim();
    const href = await this.page.locator(FINALIZADA.linkBoleto).getAttribute('href');

    if (!href) {
      throw new ErroDesconhecidoInpi('link do boleto não encontrado na tela de finalização');
    }

    // Resolve contra a URL da página atual, não contra a constante BASE
    // (que não tem barra final — usá-la como base trataria "pag" como um
    // nome de arquivo em vez de diretório, e um href começando com "/"
    // derrubaria o "/pag" do caminho ao resolver). `page.url()` é sempre
    // um documento real carregado, então essa é a mesma resolução que o
    // navegador faria nativamente para o link.
    const linkBoleto = new URL(href, this.page.url()).toString();
    const codigoGru = linkBoleto.split('/').filter(Boolean).pop() ?? '';

    return { modo: 'emitida', nossoNumero, codigoGru, valorGru, linkBoleto, objetoPeticaoValue };
  }

  /**
   * Tabela sem id — extrai por posição de coluna (ver
   * `MINHAS_GRUS_COLUNAS` em `selectors.ts`), não por seletor de célula.
   */
  private async lerTabelaGrus(): Promise<GruEncontrada[]> {
    const linhas = this.page.locator(`${MINHAS_GRUS.tabela} tbody tr`);
    const total = await linhas.count();
    const resultado: GruEncontrada[] = [];

    for (let i = 0; i < total; i += 1) {
      const celulas = linhas.nth(i).locator('td');
      const linkSegundaVia = celulas.nth(4).locator(MINHAS_GRUS.segundaVia);
      const temLinkSegundaVia = (await linkSegundaVia.count()) > 0;
      const hrefSegundaVia = temLinkSegundaVia ? await linkSegundaVia.getAttribute('href') : null;

      resultado.push({
        nossoNumero: (await celulas.nth(0).innerText()).trim(),
        servico: (await celulas.nth(1).innerText()).trim(),
        valor: (await celulas.nth(2).innerText()).trim(),
        situacao: (await celulas.nth(3).innerText()).trim(),
        urlSegundaVia: hrefSegundaVia ? new URL(hrefSegundaVia, this.page.url()).toString() : null,
        dataCadastro: (await celulas.nth(6).innerText()).trim(),
      });
    }

    return resultado;
  }

  /**
   * Heurística defensiva (ver aviso em `selectors.ts`): nenhum captcha
   * apareceu no fluxo mapeado em 18/08/2026. Existe para cumprir a regra
   * de nunca contornar captcha — só detecta e lança, nunca tenta resolver.
   */
  private async verificarCaptcha(): Promise<void> {
    for (const seletor of CAPTCHA_SELETORES) {
      const encontrado = await this.page.locator(seletor).count();
      if (encontrado > 0) {
        throw new CaptchaDetectadoError(seletor);
      }
    }
  }
}

/**
 * Falha antes de tocar a página: o INPI recusa (com erro na própria
 * tela) uma janela de busca maior que `MINHAS_GRUS_MAX_DIAS`. Melhor
 * pegar isso aqui do que submeter e ter que interpretar a mensagem de
 * erro da tela.
 */
export function validarPeriodoConsulta(inicio: Date, fim: Date): void {
  if (fim < inicio) {
    throw new PeriodoConsultaInvalidoError(
      `data fim (${fim.toISOString()}) é anterior à data início (${inicio.toISOString()})`,
    );
  }
  const dias = (fim.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24);
  if (dias > MINHAS_GRUS_MAX_DIAS) {
    throw new PeriodoConsultaInvalidoError(
      `período de ${Math.ceil(dias)} dias excede o máximo de ${MINHAS_GRUS_MAX_DIAS} dias permitido pelo INPI`,
    );
  }
}

function formatarDataBr(data: Date): string {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}

function escapeRegExp(valor: string): string {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "445,00" -> 445.00. Retorna null se não conseguir interpretar o texto lido. */
function parseValorBr(texto: string): number | null {
  const limpo = texto.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3},)/g, '');
  const normalizado = limpo.replace(',', '.');
  const valor = Number.parseFloat(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

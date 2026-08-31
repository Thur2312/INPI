import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import {
  CODIGO_SERVICO_3020,
  PAUSA_ENTRE_PASSOS_FORMULARIO_MAX_MS,
  PAUSA_ENTRE_PASSOS_FORMULARIO_MIN_MS,
  TIPO_SERVICO_MARCAS_VALUE,
} from '../config/constants.js';
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
import { pausaAleatoria } from '../utils/sleep.js';
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
   * Precisa de um cliente e de um número de processo reais (de algum
   * requerimento já na fila) para checar de verdade: sem cliente
   * selecionado o INPI nem populava a lista de serviços (retorna um erro
   * — "Favor informar o Cliente...", nunca a lista real), e o dropdown de
   * objeto só existe depois do processo administrativo preenchido (ver
   * `selecionarTipoEServicoObtendoOpcoesObjeto`). A suposição anterior —
   * "independente de cliente" — estava errada e fazia esta checagem
   * nunca funcionar de verdade, travando o verificador de abertura para
   * sempre (corrigido em 27/08/2026, às vésperas da cota de "plataforma
   * de mercado virtual" abrir em 01/09/2026).
   */
  async objetoPeticaoDisponivel(
    textoBuscado: string,
    titularDocumento: string,
    numeroProcesso: string,
  ): Promise<{ encontrado: boolean; value: string | null; opcoesAtuais: readonly string[] }> {
    if (this.page.url().startsWith(ROTAS.gerar)) {
      await this.page.reload();
    } else {
      await this.page.goto(ROTAS.gerar);
    }

    await this.selecionarCliente(titularDocumento);
    const textos = await this.selecionarTipoEServicoObtendoOpcoesObjeto(numeroProcesso);
    const values = await this.page
      .locator(`${SERVICO.objeto} option`)
      .evaluateAll((elementos) => elementos.map((el) => (el as unknown as { value: string }).value));

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
    await this.pausaHumana();
    const objetoPeticaoValue = await this.preencherServico(dados);
    await this.pausaHumana();
    await this.page.click(SERVICO.confirmar);
    // Mesmo raciocínio de `selecionarCliente`: a tela de conferência é
    // montada de forma assíncrona (mesma URL, sem navegação) — espera a
    // rede assentar em vez de esperar um elemento específico ficar
    // visível, que pode ter conteúdo vazio até a resposta chegar.
    await this.page.waitForLoadState('networkidle');
    await this.verificarCaptcha();

    const valorConferido = await this.conferirValor(dados.valorEsperado);

    if (opcoes.dryRun) {
      await this.page.click(`${CONFERENCIA.cancelar}:visible`);
      return { modo: 'dry-run', valorConferido, objetoPeticaoValue };
    }

    await opcoes.antesDeConfirmar?.();

    await this.page.click(`${CONFERENCIA.gerarBoleto}:visible`);
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
    const opcoes = await this.selecionarTipoEServicoObtendoOpcoesObjeto(dados.numeroProcesso);

    const regex = new RegExp(escapeRegExp(dados.objetoPeticaoTexto), 'i');
    const opcaoEncontrada = opcoes.find((texto) => regex.test(texto));

    if (!opcaoEncontrada) {
      throw new ObjetoPeticaoIndisponivelError(dados.objetoPeticaoTexto, opcoes);
    }

    await this.page.selectOption(SERVICO.objeto, { label: opcaoEncontrada });
    return this.page.locator(SERVICO.objeto).inputValue();
  }

  /**
   * Seleciona Tipo de Serviço (Marcas) → Serviço (3020) → preenche o
   * processo administrativo e devolve as opções do dropdown de objeto da
   * petição resultante. Compartilhado por `preencherServico` (emissão
   * real) e `objetoPeticaoDisponivel` (verificador de abertura) — ambos
   * precisam exatamente da mesma sequência para o INPI popular o
   * dropdown de objeto de verdade. Pressupõe que um cliente já foi
   * selecionado antes (`selecionarCliente`).
   */
  private async selecionarTipoEServicoObtendoOpcoesObjeto(numeroProcesso: string): Promise<string[]> {
    await this.selecionarTipoServicoMarcasComRetry();
    await this.pausaHumana();
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

    await this.selecionarServico3020ComRetry();
    await this.pausaHumana();

    await this.aguardarCampoProcessoComRetry();
    await this.page.fill(SERVICO.processo, numeroProcesso);
    await this.pausaHumana();
    return this.aguardarOpcoesObjeto();
  }

  /**
   * Seleciona "Marcas" em Tipo de Serviço e confirma que o valor realmente
   * ficou marcado antes de seguir — `page.selectOption` normalmente é
   * confiável num `<select>` nativo (não é select2), mas como o resto
   * desse fluxo depende inteiramente dessa seleção ter disparado o AJAX
   * que popula `SERVICO.codigo`, mais vale checar e repetir do que deixar
   * o restante do fluxo esperar por algo que nunca vai aparecer.
   */
  private async selecionarTipoServicoMarcasComRetry(): Promise<void> {
    const MAX_TENTATIVAS = 3;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
      await this.page.selectOption(SERVICO.tipo, TIPO_SERVICO_MARCAS_VALUE);

      if ((await this.page.locator(SERVICO.tipo).inputValue()) === TIPO_SERVICO_MARCAS_VALUE) {
        return;
      }
      if (tentativa < MAX_TENTATIVAS) {
        await this.page.waitForTimeout(500);
      }
    }
  }

  /**
   * Seleciona o serviço 3020 no widget select2.
   *
   * `#select-servico` (`SERVICO.codigo`) é escondido pelo select2 — usar
   * `page.selectOption` direto nele (com `force`, senão o Playwright
   * espera uma visibilidade que nunca vem) marca o valor no `<select>`
   * nativo, mas sem passar pelo fluxo de clique do widget o restante da
   * tela (que lê o widget, não o `<select>`) não reflete a seleção
   * (confirmado em teste manual contra o site real). Por isso aqui é
   * clique real: abre o widget, filtra pelo código no campo de busca (a
   * classe "autocomplete" do `<select>` original liga essa busca) e clica
   * no resultado.
   *
   * O motivo do retry: mesmo clicando de verdade, a mesma sequência às
   * vezes não deixa o valor `3020` de fato marcado em `SERVICO.codigo`
   * (sem diferença observável do lado do Playwright, aparenta ser uma
   * corrida interna do JS do INPI). Repetir a interação dá outra chance de
   * a corrida resolver a favor. Só verifica o valor marcado — a revelação
   * da seção do processo administrativo e a população do dropdown de
   * objeto são conferidas depois, com espera paciente e sem reclicar (ver
   * `preencherServico`): reclicar o widget enquanto essa cadeia
   * assíncrona ainda está em andamento a reinicia e piora a demora em vez
   * de resolver (confirmado contra o sistema real em 27/08/2026).
   */
  private async selecionarServico3020ComRetry(): Promise<void> {
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

      if ((await this.page.locator(SERVICO.codigo).inputValue()) === CODIGO_SERVICO_3020) {
        return;
      }
      if (tentativa < MAX_TENTATIVAS) {
        await this.page.waitForTimeout(500);
      }
    }
  }

  /**
   * Espera o campo "Processo administrativo" ficar visível depois da
   * seleção do serviço 3020 — a seleção dispara, de forma assíncrona,
   * tanto a revelação dessa seção (escondida por padrão) quanto a chamada
   * que popula o dropdown de objeto da petição. É genuinamente
   * lento/instável do lado do INPI — às vezes ~1s, às vezes bem mais, e
   * às vezes a revelação simplesmente não acontece (corrida no JS do
   * INPI, sem diferença observável do lado do Playwright).
   *
   * Cada tentativa espera pacientemente, sem reclicar nada — reclicar o
   * widget NO MEIO da espera reinicia a cadeia e piora o problema em vez
   * de resolver (confirmado contra o sistema real em 27/08/2026, ver
   * `selecionarServico3020ComRetry`). Só depois que uma tentativa esgota
   * de vez (a cadeia não ia mesmo completar sozinha) é que refaz a
   * seleção do serviço do zero, o que é uma interação nova, não uma
   * repetição no meio de uma pendente.
   */
  private async aguardarCampoProcessoComRetry(): Promise<void> {
    const MAX_TENTATIVAS = 4;
    const TIMEOUT_POR_TENTATIVA_MS = 8_000;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
      try {
        await this.page.waitForSelector(SERVICO.processo, {
          state: 'visible',
          timeout: TIMEOUT_POR_TENTATIVA_MS,
        });
        return;
      } catch (erro) {
        if (tentativa === MAX_TENTATIVAS) throw erro;
        await this.selecionarServico3020ComRetry();
        await this.pausaHumana();
      }
    }
  }

  /**
   * Espera o dropdown de objeto da petição ganhar opções de verdade (além
   * do "--Selecione--" inicial) depois que o processo administrativo é
   * preenchido, e devolve os textos das opções. Não lança se o timeout
   * estourar — devolve o que tiver (mesmo que só "--Selecione--"), e quem
   * chama (`preencherServico`) já trata lista sem a opção buscada via
   * `ObjetoPeticaoIndisponivelError`.
   */
  private async aguardarOpcoesObjeto(): Promise<string[]> {
    const MAX_TENTATIVAS = 40;
    const INTERVALO_MS = 500;

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
      const total = await this.page.locator(`${SERVICO.objeto} option`).count();
      if (total > 1) {
        break;
      }
      await this.page.waitForTimeout(INTERVALO_MS);
    }

    return this.page.locator(`${SERVICO.objeto} option`).allTextContents();
  }

  /** Ritmo humano entre os passos do formulário — ver `PAUSA_ENTRE_PASSOS_FORMULARIO_*`. */
  private async pausaHumana(): Promise<void> {
    await pausaAleatoria(PAUSA_ENTRE_PASSOS_FORMULARIO_MIN_MS, PAUSA_ENTRE_PASSOS_FORMULARIO_MAX_MS);
  }

  /**
   * O campo de valor às vezes fica vazio por um tempo depois do
   * `networkidle` da tela de conferência — o cálculo do valor parece
   * chegar por uma chamada assíncrona separada da que monta o resto da
   * tela. Espera o texto deixar de ser vazio antes de ler pra valer, em
   * vez de confiar só no `networkidle` (ver `docs/runbook-vps.md`,
   * instabilidades conhecidas do lado do INPI).
   */
  private async aguardarValorPreenchido(): Promise<string> {
    const MAX_TENTATIVAS = 40;
    const INTERVALO_MS = 500;
    const locator = this.page.locator(CONFERENCIA.valorTotal);

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa += 1) {
      const texto = (await locator.innerText()).trim();
      if (texto !== '') {
        return texto;
      }
      await this.page.waitForTimeout(INTERVALO_MS);
    }

    return (await locator.innerText()).trim();
  }

  private async conferirValor(valorEsperado: number): Promise<string> {
    const valorTexto = await this.aguardarValorPreenchido();
    const valorNumerico = parseValorBr(valorTexto);

    if (valorNumerico === null || Math.abs(valorNumerico - valorEsperado) > 0.001) {
      await this.capturarScreenshot(
        `output/diagnostico/valor-inesperado-${Date.now()}.png`,
      ).catch(() => null);
      await this.page.click(`${CONFERENCIA.cancelar}:visible`);
      throw new ValorInesperadoError(valorEsperado, valorNumerico ?? Number.NaN, valorTexto);
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

/**
 * Único arquivo do projeto que conhece a estrutura HTML real do sistema do
 * INPI. Mapeado no navegador em 18/08/2026 — não são seletores adivinhados.
 * Quando o INPI mudar uma tela, o ajuste é aqui, não espalhado pelo projeto.
 *
 * `TIPO_SERVICO_MARCAS_VALUE` e `CODIGO_SERVICO_3020` ficam em
 * `src/config/constants.ts` por serem regras de negócio (o serviço é
 * sempre 3020), não detalhes de tela — mas são usados aqui, junto dos
 * seletores, para montar o fluxo de preenchimento.
 */

export const BASE = 'https://meu.inpi.gov.br/pag';

export const LOGIN = {
  form: '#loginForm',
  usuario: '#usuarioLogin',
  senha: 'input[name="usuario.senha"]',
  submit: '#loginForm button[type="submit"]',
} as const;

export const CLIENTE = {
  abrirBusca: '#button_pesquisar',
  modal: '#modal-pesquisar-cliente',
  radioDocumento: '#tipoPesquisaModalDocumento',
  radioNome: '#tipoPesquisaModalNome',
  campoBusca: '#documento_modal',
  pesquisar: '#botao_pesquisa_modal',
  tabela: '#table-lista-clientes',
  linhas: '#table-lista-clientes tbody tr',
  selecionar: '.button-pesquisar-cliente',
} as const;

export const SERVICO = {
  tipo: '#select-tipo-servico',
  codigo: '#select-servico',
  objeto: '#select-dados-servico-objeto-peticao',
  processo: '#input-servico-processo-administrativo',
  confirmar: '#button_confirmar',
} as const;

/**
 * `#select-servico` (`SERVICO.codigo`) é escondido (`display: none`) e
 * substituído por um widget select2 — o INPI não reage a um `change`
 * disparado direto no `<select>` nativo do mesmo jeito que reage a uma
 * interação real no widget (o handler que popula `SERVICO.objeto` lê algo
 * do próprio evento de seleção do select2, não só o valor final do
 * select). Por isso a seleção do serviço 3020 clica no widget de verdade
 * em vez de usar `page.selectOption`. Nome do container gerado pelo
 * select2 segue o padrão `select2-{id-do-select-original}-container`.
 */
export const SERVICO_SELECT2 = {
  widget: 'span[aria-labelledby="select2-select-servico-container"]',
  campoBusca: '.select2-search__field',
  resultados: '.select2-results__option',
} as const;

export const CONFERENCIA = {
  tabela: '#tabela-preview-dados-servicos',
  valorTotal: '#valor-total-guia',
  gerarBoleto: '#button-finalizar-servico',
  pagarOnline: '#button-pagar-online',
  cancelar: '#button-cancelar-servico',
} as const;

export const FINALIZADA = {
  nossoNumero: '#nosso-numero',
  linkBoleto: 'a.btn-download',
  novoServico: 'button:has-text("Novo Serviço")',
} as const;

export const ROTAS = {
  gerar: `${BASE}/gru/gerar`,
  finalizada: `${BASE}/gru/finalizada`,
  minhasGrus: `${BASE}/minhasgrus/`,
  sair: `${BASE}/sairSessao`,
  imprimir: (codigo: string) => `${BASE}/gru/imprimir/codigo/${codigo}`,
} as const;

/**
 * Tela "Minhas GRUs" — rede de segurança de reconciliação (Etapa 2.5), não
 * o fluxo de emissão. O modal de cliente é o mesmo de `CLIENTE.*`
 * (`#button_pesquisar` / `#modal-pesquisar-cliente` reaproveitados), por
 * isso não duplicados aqui. `url` já existe como `ROTAS.minhasGrus`; fica
 * só o comentário para não duplicar a string e ela sair de sincronia.
 */
export const MINHAS_GRUS = {
  radioData: '#pesquisaDatas',
  radioGru: '#pesquisaGru',
  dataInicio: '#dataInicioP', // formato dd/mm/aaaa
  dataFim: '#dataFimP',
  pesquisar: '#button_pesquisar_grus',
  tabela: 'table.table-striped',
  segundaVia: 'a.linkgeravia', // href direto para o PDF
} as const;

/**
 * Ordem das colunas na tabela de resultado (sem id, extraído por posição):
 * 0 GRU (nosso número) | 1 Serviço | 2 Valor | 3 Situação | 4 2ª via |
 * 5 Recibo | 6 Data Cadastro
 */
export const MINHAS_GRUS_COLUNAS = {
  nossoNumero: 0,
  servico: 1,
  valor: 2,
  situacao: 3,
  segundaVia: 4,
  recibo: 5,
  dataCadastro: 6,
} as const;

/** O INPI recusa uma janela de busca maior que isto (erro na própria tela). */
export const MINHAS_GRUS_MAX_DIAS = 30;

/**
 * Padrões genéricos de captcha (reCAPTCHA/hCaptcha/Turnstile). Não são
 * seletores confirmados no INPI — em 18/08/2026 nenhum captcha apareceu no
 * fluxo mapeado. É uma heurística defensiva; valide contra o sistema real
 * (modo --dry-run) antes do dia da operação e ajuste aqui se necessário.
 */
export const CAPTCHA_SELETORES = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="turnstile" i]',
  'iframe[title*="captcha" i]',
  '[class*="captcha" i]',
] as const;

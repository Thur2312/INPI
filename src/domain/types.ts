export const FILAS = ['PRINCIPAL', 'RESERVA'] as const;
export type Fila = (typeof FILAS)[number];

/**
 * Estados do fluxo feliz, em ordem.
 * `AGUARDANDO_ABERTURA` é aplicado a todo processo VALIDADO até o
 * verificador único de cota liberar a operação (ver `operacao` no schema).
 */
export const STATUS_FLUXO = [
  'IMPORTADO',
  'VALIDANDO',
  'VALIDADO',
  'AGUARDANDO_ABERTURA',
  'GRU_EM_PROCESSAMENTO',
  'GRU_EMITIDA',
] as const;

/**
 * Estados de exceção. `PENDENCIA_*` são decisões de negócio (não erros
 * técnicos) que exigem intervenção humana antes de tentar emitir.
 * `ERRO_OBJETO_INDISPONIVEL` é tratado como falha global da operação, não
 * definitiva por processo — ver orquestrador (Etapa 3).
 *
 * `EMISSAO_INCERTA` não é bem um "erro": é o estado de um processo cuja
 * falha aconteceu depois do clique irreversível em "Gerar boleto" — a
 * guia pode já existir no INPI, mesmo sem `nosso_numero` gravado aqui.
 * Nunca é reivindicado de novo automaticamente (não é
 * `AGUARDANDO_ABERTURA`); só sai desse estado via reconciliação
 * (Etapa 2.5), nunca por retry comum — reemitir às cegas geraria uma
 * segunda guia paga.
 */
export const STATUS_EXCECAO = [
  'PENDENCIA_DADOS',
  'PENDENCIA_LIMITE',
  'ERRO_CLIENTE_NAO_ENCONTRADO',
  'ERRO_CLIENTE_AMBIGUO',
  'ERRO_OBJETO_INDISPONIVEL',
  'ERRO_TIMEOUT',
  'ERRO_SESSAO',
  'ERRO_CAPTCHA',
  'ERRO_DESCONHECIDO',
  'EMISSAO_INCERTA',
] as const;

export const STATUS = [...STATUS_FLUXO, ...STATUS_EXCECAO] as const;
export type Status = (typeof STATUS)[number];

/** Erros definitivos: não adianta retentar a mesma ação, o dado está errado. */
export const STATUS_ERRO_DEFINITIVO = [
  'ERRO_CLIENTE_NAO_ENCONTRADO',
  'ERRO_CLIENTE_AMBIGUO',
] as const;

/** Erros temporários: retry com backoff pode resolver (sessão caiu, timeout de rede). */
export const STATUS_ERRO_TEMPORARIO = ['ERRO_TIMEOUT', 'ERRO_SESSAO'] as const;

export interface Processo {
  id: number;
  posicao: number;
  fila: Fila;
  cliente: string | null;
  titularDocumento: string;
  titularNome: string | null;
  numeroProcesso: string;
  objetoPeticao: string;
  prioridade: number | null;
  protocolosJaUtilizados: number;
  status: Status;
  worker: string | null;
  tentativas: number;
  nossoNumero: string | null;
  codigoGru: string | null;
  valorGru: string | null;
  caminhoPdf: string | null;
  erroTipo: string | null;
  erroMensagem: string | null;
  caminhoScreenshot: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export type ResultadoEvento = 'SUCESSO' | 'FALHA' | 'INFO';

export interface Evento {
  id: number;
  processoId: number;
  timestamp: string;
  etapa: string;
  acao: string;
  resultado: ResultadoEvento;
  mensagem: string | null;
  duracaoMs: number | null;
}

export type StatusOperacao = 'AGUARDANDO_ABERTURA' | 'RODANDO' | 'PAUSADA';

export interface Operacao {
  status: StatusOperacao;
  motivo: string | null;
  objetoPeticaoValue: string | null;
  pausadaEm: string | null;
  retomadaEm: string | null;
  atualizadoEm: string;
  /**
   * Opções novas detectadas pelo verificador de abertura no dropdown de
   * objeto da petição que não batem com o texto configurado — ver
   * `verificarAbertura`. `null` = nenhum alerta pendente. Nunca decide
   * sozinho qual é a categoria certa, só avisa.
   */
  alertaCategoriaOpcoes: string[] | null;
  alertaCategoriaEm: string | null;
}

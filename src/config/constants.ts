/** Regras de negócio do INPI que não vêm do .env — são fixas pela norma, não por operação. */

/** Máximo de requerimentos de trâmite prioritário por titular (CPF/CNPJ), por regra do INPI. */
export const MAX_TRAMITE_PRIORITARIO_POR_TITULAR = 10;

/** Código do serviço 3020 (trâmite prioritário de marcas) na tela de geração de GRU. */
export const CODIGO_SERVICO_3020 = '3020';

/** Value do select "Tipo de Serviço" para Marcas. */
export const TIPO_SERVICO_MARCAS_VALUE = '300';

/** Quantidade de dígitos esperada no número do processo administrativo (ex.: 940328100). */
export const DIGITOS_NUMERO_PROCESSO = 9;

/** Ritmo humano entre ações de um mesmo worker (spec: 2–4s). */
export const PAUSA_ENTRE_ACOES_MIN_MS = 2000;
export const PAUSA_ENTRE_ACOES_MAX_MS = 4000;

/** Largada escalonada dos workers (spec: 10–15s entre um worker e o próximo). */
export const LARGADA_WORKER_MIN_MS = 10_000;
export const LARGADA_WORKER_MAX_MS = 15_000;

/** Intervalo de polling do verificador único de abertura de cota (spec: 20-30s). */
export const VERIFICADOR_INTERVALO_MIN_MS = 20_000;
export const VERIFICADOR_INTERVALO_MAX_MS = 30_000;

/** Espera de um worker antes de checar a fila de novo quando ela está vazia/pausada. */
export const ESPERA_FILA_VAZIA_MS = 3_000;

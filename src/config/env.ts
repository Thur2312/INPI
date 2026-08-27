import 'dotenv/config';
import { z } from 'zod';
import {
  ESPERA_FILA_VAZIA_MS,
  LARGADA_WORKER_MAX_MS,
  LARGADA_WORKER_MIN_MS,
  PAUSA_ENTRE_ACOES_MAX_MS,
  PAUSA_ENTRE_ACOES_MIN_MS,
  VERIFICADOR_INTERVALO_MAX_MS,
  VERIFICADOR_INTERVALO_MIN_MS,
} from './constants.js';

const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato esperado HH:MM');

/**
 * Campo de segredo opcional (`DASHBOARD_SENHA`, `PORTAL_CLIENTE_*`) que
 * trata string vazia como "não configurado" — sem isso, `CAMPO=` vazio no
 * `.env` (exatamente o que `.env.example` deixa como placeholder) vira um
 * erro de validação confuso ("deve ter pelo menos N caracteres") em vez de
 * cair no comportamento de "ausente" que o resto do sistema já espera.
 */
function segredoOpcional(tamanhoMinimo: number, mensagem: string) {
  return z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(tamanhoMinimo, mensagem).optional(),
  );
}

/**
 * `MAX_WORKERS` some acima de 4 (o valor com que o sistema foi operado e
 * testado — largada escalonada + ritmo humano no INPI). Nada aqui impede
 * escalar mais: o teto de 20 é só um limite de sanidade contra erro de
 * digitação no `.env` (ex.: "40" virar 400 zeros). Subir isso é uma
 * decisão do operador no dia, não uma trava de segurança do sistema — o
 * teto de negócio real (10 requerimentos por titular) é outro, fixo em
 * `MAX_TRAMITE_PRIORITARIO_POR_TITULAR`, e não passa por aqui. Quanto mais
 * workers e quanto mais agressivo `PAUSA_ENTRE_ACOES_*`/`LARGADA_WORKER_*`
 * ficarem, maior o risco de o tráfego ser identificado como automação
 * pelo INPI — ver `docs/runbook-vps.md`.
 */
const envSchema = z
  .object({
    INPI_USUARIO: z.string().min(1, 'INPI_USUARIO é obrigatório'),
    INPI_SENHA: z.string().min(1, 'INPI_SENHA é obrigatório'),

    DB_PATH: z.string().default('./data/inpi.db'),

    MAX_WORKERS: z.coerce.number().int().min(1).max(20).default(4),
    VALOR_ESPERADO_GRU: z.coerce.number().positive().default(445.0),
    HORA_ABERTURA_COTA: horaSchema.default('10:00'),
    HORA_LIMITE_EMISSAO: horaSchema.default('22:00'),
    HARD_STOP_22H: z
      .string()
      .default('false')
      .transform((v) => v.toLowerCase() === 'true'),
    MAX_TENTATIVAS: z.coerce.number().int().min(1).default(3),
    ORFAO_TIMEOUT_MINUTOS: z.coerce.number().int().min(1).default(15),
    BACKUP_INTERVALO_MINUTOS: z.coerce.number().int().min(1).default(5),

    /**
     * Cada worker já roda num `BrowserContext` isolado (sessão própria,
     * como um operador humano diferente) — com `HEADLESS=false` isso
     * aparece na tela como uma janela do Chrome por worker, útil para
     * acompanhar a operação ao vivo localmente. Default `true` porque a
     * VPS (ver `docs/runbook-vps.md`) não tem display: rodar headed lá
     * sem Xvfb configurado derruba o processo.
     */
    HEADLESS: z
      .string()
      .default('true')
      .transform((v) => v.toLowerCase() === 'true'),

    // Ritmo entre ações de um mesmo worker. Padrão = comportamento já
    // testado (2-4s). Reduzir aumenta throughput por worker, mas também a
    // chance de parecer tráfego robótico.
    PAUSA_ENTRE_ACOES_MIN_MS: z.coerce.number().int().min(0).default(PAUSA_ENTRE_ACOES_MIN_MS),
    PAUSA_ENTRE_ACOES_MAX_MS: z.coerce.number().int().min(0).default(PAUSA_ENTRE_ACOES_MAX_MS),
    // Intervalo entre a largada de um worker e o próximo. Padrão = 10-15s.
    LARGADA_WORKER_MIN_MS: z.coerce.number().int().min(0).default(LARGADA_WORKER_MIN_MS),
    LARGADA_WORKER_MAX_MS: z.coerce.number().int().min(0).default(LARGADA_WORKER_MAX_MS),
    // Intervalo de polling do verificador único de abertura de cota.
    // Menor = reage mais rápido no instante em que a cota abre, mas bate
    // no INPI com mais frequência antes disso.
    VERIFICADOR_INTERVALO_MIN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(VERIFICADOR_INTERVALO_MIN_MS),
    VERIFICADOR_INTERVALO_MAX_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(VERIFICADOR_INTERVALO_MAX_MS),
    // Quanto um worker espera antes de checar a fila de novo quando ela
    // está vazia/pausada — afeta a velocidade de reação quando a RESERVA
    // libera ou a operação é retomada depois de uma pausa.
    ESPERA_FILA_VAZIA_MS: z.coerce.number().int().min(0).default(ESPERA_FILA_VAZIA_MS),

    OUTPUT_DIR: z.string().default('./output'),
    DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * Senha do HTTP Basic Auth do painel. Opcional só para não quebrar
     * ambiente de teste/dev — em produção, agora que o painel pode subir a
     * automação e recebe planilha com CPF/CNPJ, configure sempre (ver aviso
     * em `dashboard/main.ts` quando ausente).
     */
    DASHBOARD_SENHA: segredoOpcional(8, 'DASHBOARD_SENHA deve ter pelo menos 8 caracteres'),

    /**
     * Backend separado (`src/portalCliente`) onde o cliente final acompanha
     * e baixa os boletos GRU dos próprios requerimentos, autenticado só
     * pelo CNPJ/CPF. `PORTAL_CLIENTE_TOKEN_SEGREDO` assina a sessão emitida
     * no login — sem ele configurado, `portalCliente/main.ts` recusa subir
     * (é a única coisa que impede alguém de forjar uma sessão para
     * qualquer CNPJ, então não tem default seguro).
     */
    PORTAL_CLIENTE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    PORTAL_CLIENTE_TOKEN_SEGREDO: segredoOpcional(
      32,
      'PORTAL_CLIENTE_TOKEN_SEGREDO deve ter pelo menos 32 caracteres',
    ),
    PORTAL_CLIENTE_ADMIN_SENHA: segredoOpcional(
      8,
      'PORTAL_CLIENTE_ADMIN_SENHA deve ter pelo menos 8 caracteres',
    ),

    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .refine((env) => env.PAUSA_ENTRE_ACOES_MIN_MS <= env.PAUSA_ENTRE_ACOES_MAX_MS, {
    message: 'PAUSA_ENTRE_ACOES_MIN_MS não pode ser maior que PAUSA_ENTRE_ACOES_MAX_MS',
    path: ['PAUSA_ENTRE_ACOES_MIN_MS'],
  })
  .refine((env) => env.LARGADA_WORKER_MIN_MS <= env.LARGADA_WORKER_MAX_MS, {
    message: 'LARGADA_WORKER_MIN_MS não pode ser maior que LARGADA_WORKER_MAX_MS',
    path: ['LARGADA_WORKER_MIN_MS'],
  })
  .refine((env) => env.VERIFICADOR_INTERVALO_MIN_MS <= env.VERIFICADOR_INTERVALO_MAX_MS, {
    message: 'VERIFICADOR_INTERVALO_MIN_MS não pode ser maior que VERIFICADOR_INTERVALO_MAX_MS',
    path: ['VERIFICADOR_INTERVALO_MIN_MS'],
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Carrega e valida as variáveis de ambiente. Falha rápido (fail-fast) se algo
 * obrigatório estiver ausente ou mal formatado — preferível a descobrir isso
 * no meio da operação do dia 01/09.
 */
export function carregarEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const resultado = envSchema.safeParse(source);
  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${problemas}`);
  }
  return resultado.data;
}

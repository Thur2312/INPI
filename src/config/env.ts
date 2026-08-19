import 'dotenv/config';
import { z } from 'zod';

const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato esperado HH:MM');

const envSchema = z.object({
  INPI_USUARIO: z.string().min(1, 'INPI_USUARIO é obrigatório'),
  INPI_SENHA: z.string().min(1, 'INPI_SENHA é obrigatório'),

  DB_PATH: z.string().default('./data/inpi.db'),

  MAX_WORKERS: z.coerce.number().int().min(1).max(4).default(4),
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

  OUTPUT_DIR: z.string().default('./output'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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

import { z } from 'zod';

/**
 * Colunas esperadas na planilha de entrada (CSV/XLSX). `xlsx` entrega cada
 * linha como objeto com essas chaves (cabeçalho da planilha). Campos
 * numéricos vêm com `coerce` porque o Excel pode entregar tanto number
 * quanto string dependendo da formatação da célula.
 */
export const linhaPlanilhaSchema = z.object({
  cliente: z.string().trim().min(1).nullable().optional(),
  titular_documento: z.coerce.string().trim().min(1, 'titular_documento é obrigatório'),
  titular_nome: z.string().trim().min(1).nullable().optional(),
  numero_processo: z.coerce.string().trim().min(1, 'numero_processo é obrigatório'),
  objeto_peticao: z.string().trim().min(1, 'objeto_peticao é obrigatório'),
  prioridade: z.coerce.number().int().nullable().optional(),
  protocolos_ja_utilizados: z.coerce.number().int().min(0).default(0),
  fila: z.enum(['PRINCIPAL', 'RESERVA']).default('PRINCIPAL'),
});

export type LinhaPlanilha = z.infer<typeof linhaPlanilhaSchema>;

import { z } from 'zod';

/**
 * Célula vazia numa planilha chega aqui como `null` (ver `celulaParaValor`
 * em `importarPlanilha.ts`), nunca como `undefined`. `z.coerce.string()`
 * NÃO serve para tratar isso: o coerce roda `String(valor)` *antes* de
 * qualquer checagem de obrigatoriedade, então tanto `null` quanto
 * `undefined` virariam as strings literais `"null"`/`"undefined"` (4+
 * caracteres, passariam tranquilamente num `.min(1)`!) em vez de
 * dispararem o erro de campo obrigatório.
 *
 * Esta função faz a única coerção que realmente precisamos (Excel entrega
 * células numéricas — ex.: um numero_processo sem formatação de texto —
 * como `number`, não `string`) e devolve `undefined` para vazio, para que
 * o `z.string()` comum (sem `.coerce`) trate isso como campo ausente e
 * gere o erro "Required" de verdade.
 */
function paraTextoOuAusente(valor: unknown): unknown {
  if (valor === null || valor === undefined) return undefined;
  if (typeof valor === 'number') return String(valor);
  return valor;
}

/**
 * Colunas esperadas na planilha de entrada (CSV/XLSX). `xlsx` entrega cada
 * linha como objeto com essas chaves (cabeçalho da planilha).
 */
export const linhaPlanilhaSchema = z.object({
  cliente: z.string().trim().min(1).nullable().optional(),
  titular_documento: z.preprocess(
    paraTextoOuAusente,
    z.string().trim().min(1, 'titular_documento é obrigatório'),
  ),
  titular_nome: z.string().trim().min(1).nullable().optional(),
  numero_processo: z.preprocess(
    paraTextoOuAusente,
    z.string().trim().min(1, 'numero_processo é obrigatório'),
  ),
  objeto_peticao: z.preprocess(
    paraTextoOuAusente,
    z.string().trim().min(1, 'objeto_peticao é obrigatório'),
  ),
  prioridade: z.coerce.number().int().nullable().optional(),
  protocolos_ja_utilizados: z.coerce.number().int().min(0).default(0),
  // `fila` também chega `null` numa célula vazia — sem tratar isso antes,
  // o `.default('PRINCIPAL')` nunca dispara (só dispara para
  // `undefined`), e a linha seria rejeitada inteira por um `fila` em branco.
  fila: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.enum(['PRINCIPAL', 'RESERVA']).default('PRINCIPAL'),
  ),
});

export type LinhaPlanilha = z.infer<typeof linhaPlanilhaSchema>;

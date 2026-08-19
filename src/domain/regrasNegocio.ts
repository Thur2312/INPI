import { MAX_TRAMITE_PRIORITARIO_POR_TITULAR } from '../config/constants.js';
import type { Fila } from './types.js';
import { somenteDigitos } from './validarDocumento.js';

export interface CandidatoProcesso {
  posicao: number;
  fila: Fila;
  cliente: string | null;
  titularDocumento: string;
  titularNome: string | null;
  numeroProcesso: string;
  objetoPeticao: string;
  prioridade: number | null;
  protocolosJaUtilizados: number;
}

export interface ResultadoTeto extends CandidatoProcesso {
  elegivel: boolean;
  motivoPendencia: string | null;
}

/**
 * Aplica o teto de 10 requerimentos de trâmite prioritário por titular
 * (CPF/CNPJ), considerando `protocolosJaUtilizados` já consumidos no
 * quadrimestre. Combina as filas PRINCIPAL e RESERVA do mesmo titular na
 * mesma contagem — é um limite do INPI, não da nossa fila interna.
 *
 * Desempate: `prioridade` menor primeiro; quando ausente/empatada, usa a
 * ordem de aparição na planilha (`posicao`) — determinístico, nunca
 * aleatório. Quem fica de fora vai para PENDENCIA_LIMITE com o motivo
 * registrado; a decisão de quem realmente fica fora é humana (do cliente
 * final), não automática.
 */
export function aplicarTetoPorTitular(candidatos: CandidatoProcesso[]): ResultadoTeto[] {
  const porTitular = new Map<string, CandidatoProcesso[]>();

  for (const c of candidatos) {
    const doc = somenteDigitos(c.titularDocumento);
    const grupo = porTitular.get(doc);
    if (grupo) {
      grupo.push(c);
    } else {
      porTitular.set(doc, [c]);
    }
  }

  const resultado: ResultadoTeto[] = [];

  for (const [doc, grupo] of porTitular) {
    const valoresBaseline = new Set(grupo.map((g) => g.protocolosJaUtilizados));

    if (valoresBaseline.size > 1) {
      const valores = [...valoresBaseline].sort((a, b) => a - b).join(', ');
      for (const c of grupo) {
        resultado.push({
          ...c,
          elegivel: false,
          motivoPendencia: `titular ${doc}: valores inconsistentes de protocolos_ja_utilizados na planilha (${valores}) — necessário confirmar o número correto antes de validar`,
        });
      }
      continue;
    }

    const jaUtilizados = grupo[0]!.protocolosJaUtilizados;
    const disponivel = Math.max(0, MAX_TRAMITE_PRIORITARIO_POR_TITULAR - jaUtilizados);

    const ordenado = [...grupo].sort((a, b) => {
      const pa = a.prioridade ?? Number.POSITIVE_INFINITY;
      const pb = b.prioridade ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.posicao - b.posicao;
    });

    ordenado.forEach((c, indice) => {
      const elegivel = indice < disponivel;
      const criterioDesempate =
        c.prioridade !== null ? `prioridade=${c.prioridade}` : 'sem prioridade — ordem de planilha';
      resultado.push({
        ...c,
        elegivel,
        motivoPendencia: elegivel
          ? null
          : `titular ${doc}: limite de ${MAX_TRAMITE_PRIORITARIO_POR_TITULAR} requerimentos (${jaUtilizados} já utilizados, ${disponivel} disponíveis, ${grupo.length} candidatos na planilha) — excedente por ${criterioDesempate}`,
      });
    });
  }

  return resultado;
}

import type Database from 'better-sqlite3';
import { inserirProcessos, moverValidadosParaAguardandoAbertura } from '../db/processos.js';
import type { Logger } from '../utils/logger.js';
import { importarPlanilha, type ErroImportacao } from './importarPlanilha.js';
import { validarLinhas } from './validador.js';

export interface ResumoImportacao {
  arquivo: string;
  totalNaPlanilha: number;
  errosDeFormato: ErroImportacao[];
  validados: number;
  pendenciaDados: number;
  pendenciaLimite: number;
  movidosParaAguardandoAbertura: number;
}

/**
 * Liga os pedaços testados isoladamente (leitura de planilha, validação de
 * negócio, gravação no banco) no único fluxo que faltava para o pipeline
 * funcionar de ponta a ponta: sem isso, planilha nenhuma chegava ao banco —
 * `importarPlanilha`, `validarLinhas` e `inserirProcessos` existiam, mas
 * nada os chamava em sequência.
 *
 * Erros de schema (`errosDeFormato`) são linhas que nem `importarPlanilha`
 * conseguiu interpretar (campo obrigatório ausente, tipo errado) — não
 * entram no banco de jeito nenhum, o operador precisa corrigir a planilha e
 * reimportar. Já `PENDENCIA_DADOS`/`PENDENCIA_LIMITE` (de `validarLinhas`)
 * entram normalmente: fazem parte do relatório e podem ser resolvidas
 * depois, sem precisar reimportar nada.
 */
export async function importarPlanilhaParaBanco(
  db: Database.Database,
  caminhoPlanilha: string,
  logger: Logger,
): Promise<ResumoImportacao> {
  const { linhas, erros } = await importarPlanilha(caminhoPlanilha);

  for (const erro of erros) {
    logger.warn('linha da planilha rejeitada no schema — não entra no banco', { ...erro });
  }

  const numerosProcessoExistentes = new Set(
    (
      db.prepare('SELECT numero_processo FROM processos').all() as {
        numero_processo: string;
      }[]
    ).map((r) => r.numero_processo),
  );

  const processadas = validarLinhas(linhas, numerosProcessoExistentes);
  inserirProcessos(db, processadas);
  const movidos = moverValidadosParaAguardandoAbertura(db);

  const resumo: ResumoImportacao = {
    arquivo: caminhoPlanilha,
    totalNaPlanilha: linhas.length + erros.length,
    errosDeFormato: erros,
    validados: processadas.filter((p) => p.status === 'VALIDADO').length,
    pendenciaDados: processadas.filter((p) => p.status === 'PENDENCIA_DADOS').length,
    pendenciaLimite: processadas.filter((p) => p.status === 'PENDENCIA_LIMITE').length,
    movidosParaAguardandoAbertura: movidos,
  };

  logger.info('importação concluída', { ...resumo });
  return resumo;
}

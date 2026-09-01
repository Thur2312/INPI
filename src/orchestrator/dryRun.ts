import type Database from 'better-sqlite3';
import { PAUSA_ENTRE_ACOES_MAX_MS, PAUSA_ENTRE_ACOES_MIN_MS } from '../config/constants.js';
import { listarProximosDaFila } from '../db/processos.js';
import type { DadosEmissaoGru, ResultadoEmissaoGru } from '../inpi/adapter.js';
import type { Logger } from '../utils/logger.js';
import { pausaAleatoria } from '../utils/sleep.js';
import type { CredenciaisInpi } from './workerLoop.js';

/** Só o que o modo ensaio precisa do adapter — sem baixarBoleto/novoServico/etc, que não se aplicam. */
export interface DryRunAdapter {
  login(usuario: string, senha: string): Promise<void>;
  emitirGru(
    dados: DadosEmissaoGru,
    opcoes: { dryRun: true },
  ): Promise<ResultadoEmissaoGru>;
}

export interface OpcoesDryRun {
  db: Database.Database;
  adapter: DryRunAdapter;
  credenciais: CredenciaisInpi;
  limite: number;
  logger: Logger;
  pausaEntreAcoesMinMs?: number;
  pausaEntreAcoesMaxMs?: number;
}

/**
 * Modo ensaio: percorre o fluxo completo de emissão (login, busca de
 * cliente, seleção de serviço/objeto/processo, Confirmar) e para na tela de
 * conferência, antes do clique em "Gerar boleto" — `emitirGru(..., {dryRun:
 * true})` já garante isso e cancela o serviço. Nenhuma guia é gerada.
 *
 * Deliberadamente não usa `reivindicarProximo`/`executarWorker`: aquele
 * caminho muda status, worker e tentativas como parte do claim atômico — o
 * ensaio não pode consumir a fila real, então lê os N primeiros elegíveis
 * só para leitura (`listarProximosDaFila`) e nunca escreve em `processos`.
 * Sequencial de propósito (não múltiplos workers): é um teste manual que o
 * operador acompanha item a item antes de soltar a fila inteira, não a
 * operação cronometrada de verdade.
 */
export async function executarDryRun(opcoes: OpcoesDryRun): Promise<void> {
  const {
    db,
    adapter,
    credenciais,
    limite,
    logger,
    pausaEntreAcoesMinMs = PAUSA_ENTRE_ACOES_MIN_MS,
    pausaEntreAcoesMaxMs = PAUSA_ENTRE_ACOES_MAX_MS,
  } = opcoes;

  const processos = listarProximosDaFila(db, limite);

  if (processos.length === 0) {
    logger.info(
      'modo ensaio (--dry-run): nenhum processo elegível encontrado (esperado status VALIDADO ou AGUARDANDO_ABERTURA) — nada para testar',
    );
    return;
  }

  logger.info(
    `modo ensaio (--dry-run): iniciando com ${processos.length} processo(s) — NENHUMA guia será gerada, NENHUM status será alterado no banco`,
    { limite, processoIds: processos.map((p) => p.id) },
  );

  await adapter.login(credenciais.usuario, credenciais.senha);
  logger.info('modo ensaio: autenticado');

  for (const processo of processos) {
    await pausaAleatoria(pausaEntreAcoesMinMs, pausaEntreAcoesMaxMs);

    try {
      const resultado = await adapter.emitirGru(
        {
          titularDocumento: processo.titularDocumento,
          numeroProcesso: processo.numeroProcesso,
          objetoPeticaoTexto: processo.objetoPeticao,
        },
        { dryRun: true },
      );

      logger.info('modo ensaio: OK — conferência lida com sucesso, nenhuma guia gerada', {
        processoId: processo.id,
        numeroProcesso: processo.numeroProcesso,
        titularDocumento: processo.titularDocumento,
        objetoPeticaoValue: resultado.objetoPeticaoValue,
        valorConferido: resultado.modo === 'dry-run' ? resultado.valorConferido : null,
      });
    } catch (erro) {
      logger.error('modo ensaio: falha ao processar item — nenhum status foi alterado no banco', {
        processoId: processo.id,
        numeroProcesso: processo.numeroProcesso,
        titularDocumento: processo.titularDocumento,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  logger.info('modo ensaio (--dry-run) concluído');
}

import type Database from 'better-sqlite3';
import type { Browser, BrowserContext } from 'playwright';
import { LARGADA_WORKER_MAX_MS, LARGADA_WORKER_MIN_MS } from '../config/constants.js';
import { liberarOperacao, obterOperacao } from '../db/operacao.js';
import { varrerOrfaos } from '../db/queue.js';
import { AdapterInpi } from '../inpi/adapter.js';
import type { Logger } from '../utils/logger.js';
import { pausaAleatoria } from '../utils/sleep.js';
import { iniciarBackupPeriodico } from './backup.js';
import type { VerificadorObjeto } from './verificadorAbertura.js';
import { verificarAbertura } from './verificadorAbertura.js';
import type { ConfigWorker, CredenciaisInpi, WorkerAdapter } from './workerLoop.js';
import { executarWorker } from './workerLoop.js';

/** O que o orquestrador precisa de um adapter — workers e verificador combinados. */
export type AdapterCompleto = WorkerAdapter &
  VerificadorObjeto & {
    login(usuario: string, senha: string): Promise<void>;
  };

export interface OpcoesOperacao {
  db: Database.Database;
  browser: Browser;
  credenciais: CredenciaisInpi;
  maxWorkers: number;
  objetoPeticaoTexto: string;
  config: ConfigWorker;
  logger: Logger;
  pastaBackup: string;
  backupIntervaloMinutos: number;
  orfaoTimeoutMinutos: number;
  /** Ponto de injeção para teste — em produção é sempre `AdapterInpi.criar`. */
  criarAdapter?: (context: BrowserContext) => Promise<AdapterCompleto>;
  /** Override de teste para a largada escalonada (produção usa as constantes de 10–15s). */
  largadaMinMs?: number;
  largadaMaxMs?: number;
  /** Overrides de teste repassados a cada worker — ver `DependenciasWorker`. */
  esperaFilaVaziaMs?: number;
  pausaEntreAcoesMinMs?: number;
  pausaEntreAcoesMaxMs?: number;
}

export interface OperacaoEmAndamento {
  /** Sinal cooperativo de parada — para depois que a emissão em curso de cada worker terminar, não no meio. */
  parar: () => void;
  /** Resolve quando verificador + todos os workers encerraram (fila esgotada, pausada por muito tempo, ou `parar()` chamado). */
  concluida: Promise<void>;
}

/**
 * Monta a operação inteira: verificador único de abertura (só se a cota
 * ainda não estiver liberada), N workers com largada escalonada, backup
 * periódico do banco e varredura de órfãos — tudo em paralelo, cada um
 * cuidando da própria parte.
 *
 * Workers começam a fazer login e entram no próprio loop de espera
 * (`executarWorker` já dorme e tenta de novo quando a fila está
 * `AGUARDANDO_ABERTURA`/`PAUSADA`) independente do verificador — não faz
 * sentido atrasar o login e a largada escalonada até a cota abrir; o
 * ideal é que os workers já estejam autenticados e prontos no instante
 * em que ela abrir.
 */
export function rodarOperacao(opcoes: OpcoesOperacao): OperacaoEmAndamento {
  const {
    db,
    browser,
    credenciais,
    maxWorkers,
    objetoPeticaoTexto,
    config,
    logger,
    pastaBackup,
    backupIntervaloMinutos,
    orfaoTimeoutMinutos,
    criarAdapter = (context: BrowserContext) => AdapterInpi.criar(context),
    largadaMinMs = LARGADA_WORKER_MIN_MS,
    largadaMaxMs = LARGADA_WORKER_MAX_MS,
    esperaFilaVaziaMs,
    pausaEntreAcoesMinMs,
    pausaEntreAcoesMaxMs,
  } = opcoes;

  const sinal = { parar: false };
  const pararSinal = () => {
    sinal.parar = true;
  };

  const pararBackup = iniciarBackupPeriodico(db, pastaBackup, backupIntervaloMinutos, logger);

  const intervalOrfaos = setInterval(() => {
    const revertidos = varrerOrfaos(db, orfaoTimeoutMinutos);
    if (revertidos.length > 0) {
      logger.warn('varredura de órfãos devolveu processos presos à fila', {
        processoIds: revertidos,
      });
    }
  }, 60_000);

  // A largada escalonada por si só leva até (maxWorkers-1) * 15s. Se o
  // corpo dessa função só retornasse depois de lançar todo mundo, o
  // `parar()` devolvido não existiria ainda durante essa janela — um
  // SIGINT no meio da largada não teria como interromper nada. Por isso
  // o lançamento roda numa tarefa em segundo plano: `parar` fica
  // disponível para o chamador imediatamente.
  const concluida = (async () => {
    const tarefas: Promise<void>[] = [];

    const operacaoAtual = obterOperacao(db);
    if (operacaoAtual.status === 'AGUARDANDO_ABERTURA') {
      const watcherContext = await browser.newContext();
      const watcherAdapter = await criarAdapter(watcherContext);
      await watcherAdapter.login(credenciais.usuario, credenciais.senha);
      logger.info('verificador de abertura autenticado, iniciando polling', { objetoPeticaoTexto });

      tarefas.push(
        verificarAbertura(
          watcherAdapter,
          {
            obterOperacao: () => obterOperacao(db),
            liberarOperacao: (value) => {
              liberarOperacao(db, value);
            },
          },
          objetoPeticaoTexto,
          { logger, sinal },
        ).finally(() => watcherContext.close()),
      );
    } else {
      logger.info('operação já não está AGUARDANDO_ABERTURA — verificador não é necessário', {
        status: operacaoAtual.status,
      });
    }

    for (let i = 0; i < maxWorkers; i += 1) {
      if (sinal.parar) break;
      if (i > 0) {
        await pausaAleatoria(largadaMinMs, largadaMaxMs);
      }
      if (sinal.parar) break;

      const workerId = `worker-${i + 1}`;
      const context = await browser.newContext();
      const adapter = await criarAdapter(context);

      tarefas.push(
        executarWorker({
          db,
          adapter,
          workerId,
          credenciais,
          config,
          logger,
          sinal,
          ...(esperaFilaVaziaMs !== undefined && { esperaFilaVaziaMs }),
          ...(pausaEntreAcoesMinMs !== undefined && { pausaEntreAcoesMinMs }),
          ...(pausaEntreAcoesMaxMs !== undefined && { pausaEntreAcoesMaxMs }),
        }).finally(() => context.close()),
      );
    }

    await Promise.all(tarefas);
  })().finally(() => {
    pararBackup();
    clearInterval(intervalOrfaos);
    logger.info('operação encerrada — todas as tarefas pararam');
  });

  return { parar: pararSinal, concluida };
}

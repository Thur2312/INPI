import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { PAUSA_ENTRE_ACOES_MAX_MS, PAUSA_ENTRE_ACOES_MIN_MS } from '../config/constants.js';
import { registrarEvento } from '../db/eventos.js';
import { pausarOperacao } from '../db/operacao.js';
import {
  buscarProcessoPorId,
  existemProcessosPendentes,
  marcarComoDefinitivo,
  marcarComoEmissaoIncerta,
  marcarComoEmitida,
} from '../db/processos.js';
import { devolverAFila, reivindicarProximo } from '../db/queue.js';
import type { Processo } from '../domain/types.js';
import type { DadosEmissaoGru, GruEncontrada, ResultadoEmissaoGru } from '../inpi/adapter.js';
import { SessaoInpiError } from '../inpi/erros.js';
import { reconciliarProcesso } from '../inpi/reconciliacao.js';
import { calcularBackoffMs } from '../utils/backoff.js';
import type { Logger } from '../utils/logger.js';
import { pausaAleatoria, sleep } from '../utils/sleep.js';
import { classificarErro, mensagemDoErro, statusDoErro } from './classificarErro.js';
import { passouDoHorarioLimite } from './horario.js';

/**
 * Só o que o loop precisa do adapter — permite testar a lógica de
 * orquestração (idempotência, retry, pausa global, backoff, reconciliação)
 * com um adapter falso, sem Playwright nem fixture nenhuma. `AdapterInpi`
 * satisfaz isso estruturalmente, sem precisar declarar nada extra nele.
 */
export interface WorkerAdapter {
  login(usuario: string, senha: string): Promise<void>;
  emitirGru(
    dados: DadosEmissaoGru,
    opcoes?: { antesDeConfirmar?: () => void | Promise<void> },
  ): Promise<ResultadoEmissaoGru>;
  baixarBoleto(linkBoleto: string, destinoPdf: string): Promise<void>;
  novoServico(): Promise<void>;
  capturarScreenshot(caminhoPng: string): Promise<string | null>;
  /** Usado para reconciliar um processo em EMISSAO_INCERTA — ver `tratarEmissaoIncerta`. */
  consultarGrusDoCliente(documento: string, inicio: Date, fim: Date): Promise<GruEncontrada[]>;
}

export interface CredenciaisInpi {
  usuario: string;
  senha: string;
}

export interface ConfigWorker {
  maxTentativas: number;
  valorEsperadoGru: number;
  pastaGuias: string;
  pastaErros: string;
  horaLimiteEmissao: string;
  hardStop22h: boolean;
}

export interface DependenciasWorker {
  db: Database.Database;
  adapter: WorkerAdapter;
  workerId: string;
  credenciais: CredenciaisInpi;
  config: ConfigWorker;
  logger: Logger;
  /** Sinal cooperativo de parada (ex.: SIGINT) — checado entre iterações, não interrompe uma emissão no meio. */
  sinal?: { parar: boolean };
  /** Intervalo de espera quando a fila está vazia/pausada (produção: 3s). Override de teste para não esperar segundos reais. */
  esperaFilaVaziaMs?: number;
  /** Override de teste para a pausa humana entre ações (produção: 2–4s, ver `PAUSA_ENTRE_ACOES_*`). */
  pausaEntreAcoesMinMs?: number;
  pausaEntreAcoesMaxMs?: number;
}

/**
 * Loop principal de um worker: reivindica da fila, emite, trata erro,
 * repete até a fila esgotar de verdade ou receber sinal de parada. Nunca
 * lança para fora — uma falha inesperada no login ou num item específico
 * fica registrada e o worker encerra sozinho, sem derrubar os outros.
 */
export async function executarWorker(deps: DependenciasWorker): Promise<void> {
  const {
    db,
    adapter,
    workerId,
    credenciais,
    config,
    logger,
    sinal,
    esperaFilaVaziaMs = 3000,
    pausaEntreAcoesMinMs = PAUSA_ENTRE_ACOES_MIN_MS,
    pausaEntreAcoesMaxMs = PAUSA_ENTRE_ACOES_MAX_MS,
  } = deps;

  try {
    await adapter.login(credenciais.usuario, credenciais.senha);
    logger.info('worker autenticado', { workerId });
  } catch (erro) {
    logger.error('worker não conseguiu autenticar — encerrando sem processar nada', {
      workerId,
      erro: mensagemDoErro(erro),
    });
    return;
  }

  let avisou22h = false;

  while (!sinal?.parar) {
    if (passouDoHorarioLimite(config.horaLimiteEmissao) && !avisou22h) {
      avisou22h = true;
      logger.warn(
        'passou do horário limite de emissão — guias geradas agora só podem ser pagas no próximo dia útil (aviso, fila continua rodando)',
        { workerId },
      );
    }
    if (avisou22h && config.hardStop22h) {
      logger.info('HARD_STOP_22H ativo e horário limite passado — worker encerrando', { workerId });
      return;
    }

    const processo = reivindicarProximo(db, workerId);

    if (!processo) {
      if (!existemProcessosPendentes(db)) {
        logger.info('fila esgotada — worker encerrando', { workerId });
        return;
      }
      // Fila pausada (operação global) ou tudo já reivindicado por outros workers.
      await sleep(esperaFilaVaziaMs);
      continue;
    }

    if (processo.nossoNumero) {
      // Idempotência: já foi emitido antes (ex.: worker morreu depois de
      // emitir mas antes de marcar). Não emite de novo, só confirma o
      // status local e segue.
      marcarComoEmitida(db, processo.id, {
        nossoNumero: processo.nossoNumero,
        codigoGru: processo.codigoGru ?? '',
        valorGru: processo.valorGru ?? '',
        caminhoPdf: processo.caminhoPdf,
      });
      logger.info('processo já tinha nosso_numero — emissão pulada (idempotência)', {
        workerId,
        processoId: processo.id,
        nossoNumero: processo.nossoNumero,
      });
      continue;
    }

    await pausaAleatoria(pausaEntreAcoesMinMs, pausaEntreAcoesMaxMs);

    try {
      await processarUmItem(deps, processo);
    } catch (erro) {
      await tratarErro(deps, processo, erro);
    }
  }

  logger.info('worker recebeu sinal de parada', { workerId });
}

async function processarUmItem(deps: DependenciasWorker, processo: Processo): Promise<void> {
  const { db, adapter, workerId, config, logger } = deps;

  const resultado = await adapter.emitirGru(
    {
      titularDocumento: processo.titularDocumento,
      numeroProcesso: processo.numeroProcesso,
      objetoPeticaoTexto: processo.objetoPeticao,
      valorEsperado: config.valorEsperadoGru,
    },
    {
      antesDeConfirmar: () => {
        marcarComoEmissaoIncerta(
          db,
          processo.id,
          'clique em "Gerar boleto" realizado, aguardando confirmação da leitura do resultado',
        );
      },
    },
  );

  if (resultado.modo !== 'emitida') {
    // Não deveria acontecer no worker de produção (dry-run é um modo à
    // parte, ver Etapa 5) — devolve em vez de perder o processo.
    devolverAFila(db, processo.id, `emitirGru retornou modo "${resultado.modo}" inesperado`);
    return;
  }

  const caminhoPdf = join(
    config.pastaGuias,
    `${processo.numeroProcesso}-${resultado.nossoNumero}.pdf`,
  );
  await adapter.baixarBoleto(resultado.linkBoleto, caminhoPdf);

  marcarComoEmitida(db, processo.id, {
    nossoNumero: resultado.nossoNumero,
    codigoGru: resultado.codigoGru,
    valorGru: resultado.valorGru,
    caminhoPdf,
  });

  registrarEvento(db, {
    processoId: processo.id,
    etapa: 'EMISSAO',
    acao: 'EMITIR_GRU',
    resultado: 'SUCESSO',
    mensagem: resultado.nossoNumero,
  });

  logger.info('GRU emitida', {
    workerId,
    processoId: processo.id,
    nossoNumero: resultado.nossoNumero,
  });

  await adapter.novoServico();
}

async function tratarErro(
  deps: DependenciasWorker,
  processo: Processo,
  erro: unknown,
): Promise<void> {
  const { db, adapter, workerId, config, logger } = deps;

  const mensagem = mensagemDoErro(erro);
  const statusErro = statusDoErro(erro);

  const caminhoScreenshot = await adapter
    .capturarScreenshot(
      join(
        config.pastaErros,
        `processo-${processo.id}-tentativa${processo.tentativas}-${Date.now()}.png`,
      ),
    )
    .catch(() => null);

  registrarEvento(db, {
    processoId: processo.id,
    etapa: 'EMISSAO',
    acao: 'ERRO',
    resultado: 'FALHA',
    mensagem: `${statusErro}: ${mensagem}`,
  });

  // O clique em "Gerar boleto" já pode ter acontecido antes deste erro —
  // `antesDeConfirmar` grava EMISSAO_INCERTA no banco *antes* do clique,
  // então reconsultar o status atual (não o snapshot de antes do claim)
  // é a única forma confiável de saber se passamos daquele ponto. Se
  // passamos, a guia pode já existir no INPI: reconciliar, nunca reemitir.
  const atual = buscarProcessoPorId(db, processo.id);
  if (atual?.status === 'EMISSAO_INCERTA') {
    await tratarEmissaoIncerta(deps, processo, statusErro, mensagem, caminhoScreenshot);
    return;
  }

  const classificacao = classificarErro(erro);

  if (classificacao === 'PAUSA_GLOBAL') {
    pausarOperacao(db, `${statusErro}: ${mensagem}`);
    devolverAFila(db, processo.id, `pausa global (${statusErro}): ${mensagem}`);
    logger.error(
      'PAUSA GLOBAL — operação inteira pausada, aguardando intervenção humana (não é falha deste processo)',
      { workerId, processoId: processo.id, statusErro, motivo: mensagem },
    );
    return;
  }

  if (classificacao === 'DEFINITIVO') {
    marcarComoDefinitivo(db, processo.id, statusErro, mensagem, caminhoScreenshot);
    logger.warn('processo marcado como falha definitiva', {
      workerId,
      processoId: processo.id,
      statusErro,
      mensagem,
    });
    return;
  }

  await aplicarRetryOuDefinitivo(
    deps,
    processo,
    statusErro,
    mensagem,
    caminhoScreenshot,
    erro instanceof SessaoInpiError,
  );
}

/**
 * Cauda comum do RETRY: esgotou tentativas vira DEFINITIVO, senão espera
 * o backoff (reautenticando primeiro se foi queda de sessão) e devolve à
 * fila. Reusado tanto pelo fluxo normal de erro quanto pelo resultado
 * NENHUMA_ENCONTRADA da reconciliação — nesse segundo caso, a
 * reconciliação já confirmou que não existe guia, então devolver à fila
 * é seguro.
 */
async function aplicarRetryOuDefinitivo(
  deps: DependenciasWorker,
  processo: Processo,
  statusErro: string,
  mensagem: string,
  caminhoScreenshot: string | null,
  reautenticar: boolean,
): Promise<void> {
  const { db, adapter, workerId, credenciais, config, logger } = deps;

  if (processo.tentativas >= config.maxTentativas) {
    marcarComoDefinitivo(
      db,
      processo.id,
      statusErro,
      `tentativas esgotadas (${processo.tentativas}/${config.maxTentativas}): ${mensagem}`,
      caminhoScreenshot,
    );
    logger.warn('tentativas esgotadas — processo marcado como falha definitiva', {
      workerId,
      processoId: processo.id,
      tentativas: processo.tentativas,
    });
    return;
  }

  const backoffMs = calcularBackoffMs(processo.tentativas);
  logger.info('erro temporário — retry com backoff', {
    workerId,
    processoId: processo.id,
    statusErro,
    tentativas: processo.tentativas,
    backoffMs: Math.round(backoffMs),
  });
  await sleep(backoffMs);

  if (reautenticar) {
    try {
      await adapter.login(credenciais.usuario, credenciais.senha);
      logger.info('sessão recuperada após reautenticação', { workerId });
    } catch (erroLogin) {
      logger.error(
        'falha ao reautenticar após sessão cair — worker vai tentar seguir mesmo assim',
        {
          workerId,
          erro: mensagemDoErro(erroLogin),
        },
      );
    }
  }

  devolverAFila(db, processo.id, `retry (${statusErro}): ${mensagem}`);
}

/**
 * Um processo cai aqui quando o clique em "Gerar boleto" já aconteceu e
 * a falha veio depois — a guia pode já existir no INPI. Nunca reemite
 * às cegas: consulta "Minhas GRUs" do titular (Etapa 2.5) e só decide
 * com base no que a tela realmente mostra.
 *
 * - NENHUMA_ENCONTRADA: a guia de fato não foi criada (o clique falhou
 *   antes de chegar no servidor) — seguro devolver para nova tentativa.
 * - ENCONTRADA_UNICA: a guia existe — adota o resultado, sem reemitir.
 * - AMBIGUA ou a própria reconciliação falhando: fica em EMISSAO_INCERTA
 *   de propósito. Decisão humana, não automática — mesma filosofia da
 *   linha única na busca de cliente.
 */
async function tratarEmissaoIncerta(
  deps: DependenciasWorker,
  processo: Processo,
  statusErroOriginal: string,
  mensagemOriginal: string,
  caminhoScreenshot: string | null,
): Promise<void> {
  const { db, adapter, workerId, config, logger } = deps;

  logger.error(
    'EMISSAO_INCERTA: falha depois do clique em "Gerar boleto" — a guia pode já existir no INPI. Tentando reconciliar antes de qualquer nova tentativa.',
    { workerId, processoId: processo.id, statusErroOriginal, mensagemOriginal },
  );

  try {
    const resultado = await reconciliarProcesso(adapter, {
      titularDocumento: processo.titularDocumento,
      dataOperacao: new Date(),
    });

    if (resultado.status === 'NENHUMA_ENCONTRADA') {
      logger.warn('reconciliação confirma que a guia NÃO foi criada — segura para tentar de novo', {
        workerId,
        processoId: processo.id,
      });
      // Usa o status/mensagem do erro ORIGINAL (ex.: ERRO_TIMEOUT), não
      // "EMISSAO_INCERTA" — a reconciliação já confirmou que não existe
      // guia, então se as tentativas se esgotarem agora o motivo real é
      // o mesmo de sempre (timeout, sessão etc.), não mais incerteza.
      await aplicarRetryOuDefinitivo(
        deps,
        processo,
        statusErroOriginal,
        `${mensagemOriginal} (guia não encontrada na reconciliação — seguro tentar de novo)`,
        caminhoScreenshot,
        false,
      );
      return;
    }

    if (resultado.status === 'ENCONTRADA_UNICA') {
      const gru = resultado.candidatas[0]!;
      const codigoGru = gru.urlSegundaVia
        ? (gru.urlSegundaVia.split('/').filter(Boolean).pop() ?? '')
        : '';

      let caminhoPdf: string | null = null;
      if (gru.urlSegundaVia) {
        caminhoPdf = join(config.pastaGuias, `${processo.numeroProcesso}-${gru.nossoNumero}.pdf`);
        try {
          await adapter.baixarBoleto(gru.urlSegundaVia, caminhoPdf);
        } catch (erroDownload) {
          logger.warn(
            'reconciliação confirmou a guia mas o download da 2ª via falhou — marcando emitida mesmo assim',
            { workerId, processoId: processo.id, erro: mensagemDoErro(erroDownload) },
          );
          caminhoPdf = null;
        }
      }

      marcarComoEmitida(db, processo.id, {
        nossoNumero: gru.nossoNumero,
        codigoGru,
        valorGru: gru.valor,
        caminhoPdf,
      });
      logger.info('reconciliação confirmou a guia — processo completado sem reemitir', {
        workerId,
        processoId: processo.id,
        nossoNumero: gru.nossoNumero,
      });
      return;
    }

    // AMBIGUA
    marcarComoEmissaoIncerta(
      db,
      processo.id,
      `reconciliação ambígua: ${resultado.candidatas.length} guias 3020 encontradas para o titular na data — decisão humana necessária (nossoNumero candidatos: ${resultado.candidatas.map((c) => c.nossoNumero).join(', ')})`,
    );
    logger.error(
      'reconciliação AMBÍGUA — mais de uma guia 3020 do titular na data, não decide sozinha',
      {
        workerId,
        processoId: processo.id,
        candidatas: resultado.candidatas.map((c) => c.nossoNumero),
      },
    );
  } catch (erroReconciliacao) {
    // Já está EMISSAO_INCERTA desde antes do clique — não devolve à
    // fila. Fica assim até uma reconciliação manual/futura resolver.
    logger.error(
      'falha ao tentar reconciliar — processo permanece EMISSAO_INCERTA, precisa de reconciliação manual',
      { workerId, processoId: processo.id, erro: mensagemDoErro(erroReconciliacao) },
    );
  }
}

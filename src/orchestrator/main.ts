import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { obterObjetoPeticaoPrincipal } from '../db/processos.js';
import { AdapterInpi } from '../inpi/adapter.js';
import { criarLogger } from '../utils/logger.js';
import { parseArgumentosCli } from './cli.js';
import { executarDryRun } from './dryRun.js';
import type { ConfigWorker } from './workerLoop.js';
import { rodarOperacao } from './orquestrador.js';

async function main(): Promise<void> {
  const argumentos = parseArgumentosCli(process.argv.slice(2));
  const env = carregarEnv();

  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  const logger = criarLogger(
    join(env.OUTPUT_DIR, 'logs', `${argumentos.dryRun ? 'ensaio' : 'operacao'}-${Date.now()}.jsonl`),
    [env.INPI_SENHA],
  );

  if (argumentos.dryRun) {
    const browser = await chromium.launch({ headless: env.HEADLESS });
    const context = await browser.newContext();
    const adapter = await AdapterInpi.criar(context);

    await executarDryRun({
      db,
      adapter,
      credenciais: { usuario: env.INPI_USUARIO, senha: env.INPI_SENHA },
      limite: argumentos.limite,
      logger,
    });

    await context.close();
    await browser.close();
    db.close();
    return;
  }

  const objetoInfo = obterObjetoPeticaoPrincipal(db);
  if (!objetoInfo) {
    logger.info('nenhum processo AGUARDANDO_ABERTURA — nada para fazer, encerrando.');
    db.close();
    return;
  }
  if (objetoInfo.valoresDistintos.length > 1) {
    logger.warn(
      'planilha tem mais de um objeto_peticao distinto — o verificador só monitora o primeiro por posição; os outros vão travar em ERRO_OBJETO_INDISPONIVEL até alguém ajustar manualmente',
      { valoresDistintos: objetoInfo.valoresDistintos, usando: objetoInfo.texto },
    );
  }

  const config: ConfigWorker = {
    maxTentativas: env.MAX_TENTATIVAS,
    pastaGuias: join(env.OUTPUT_DIR, 'guias'),
    pastaErros: join(env.OUTPUT_DIR, 'erros'),
    horaLimiteEmissao: env.HORA_LIMITE_EMISSAO,
    hardStop22h: env.HARD_STOP_22H,
  };

  const browser = await chromium.launch({ headless: env.HEADLESS });

  logger.info('parâmetros de ritmo desta operação', {
    headless: env.HEADLESS,
    maxWorkers: env.MAX_WORKERS,
    pausaEntreAcoesMinMs: env.PAUSA_ENTRE_ACOES_MIN_MS,
    pausaEntreAcoesMaxMs: env.PAUSA_ENTRE_ACOES_MAX_MS,
    largadaWorkerMinMs: env.LARGADA_WORKER_MIN_MS,
    largadaWorkerMaxMs: env.LARGADA_WORKER_MAX_MS,
    verificadorIntervaloMinMs: env.VERIFICADOR_INTERVALO_MIN_MS,
    verificadorIntervaloMaxMs: env.VERIFICADOR_INTERVALO_MAX_MS,
    esperaFilaVaziaMs: env.ESPERA_FILA_VAZIA_MS,
  });

  const operacao = rodarOperacao({
    db,
    browser,
    credenciais: { usuario: env.INPI_USUARIO, senha: env.INPI_SENHA },
    maxWorkers: env.MAX_WORKERS,
    objetoPeticaoTexto: objetoInfo.texto,
    titularDocumentoVerificador: objetoInfo.titularDocumento,
    numeroProcessoVerificador: objetoInfo.numeroProcesso,
    config,
    logger,
    pastaBackup: join(dirname(env.DB_PATH), 'backups'),
    backupIntervaloMinutos: env.BACKUP_INTERVALO_MINUTOS,
    orfaoTimeoutMinutos: env.ORFAO_TIMEOUT_MINUTOS,
    pastaRelatorios: join(env.OUTPUT_DIR, 'relatorios'),
    pausaEntreAcoesMinMs: env.PAUSA_ENTRE_ACOES_MIN_MS,
    pausaEntreAcoesMaxMs: env.PAUSA_ENTRE_ACOES_MAX_MS,
    largadaMinMs: env.LARGADA_WORKER_MIN_MS,
    largadaMaxMs: env.LARGADA_WORKER_MAX_MS,
    verificadorIntervaloMinMs: env.VERIFICADOR_INTERVALO_MIN_MS,
    verificadorIntervaloMaxMs: env.VERIFICADOR_INTERVALO_MAX_MS,
    esperaFilaVaziaMs: env.ESPERA_FILA_VAZIA_MS,
  });

  let encerrando = false;
  const encerrarComSinal = (sinalNome: string) => {
    if (encerrando) return;
    encerrando = true;
    logger.info(
      `${sinalNome} recebido — sinalizando parada (workers terminam a ação atual antes de sair)`,
    );
    operacao.parar();
  };
  process.once('SIGINT', () => encerrarComSinal('SIGINT'));
  process.once('SIGTERM', () => encerrarComSinal('SIGTERM'));

  await operacao.concluida;
  await browser.close();
  db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((erro: unknown) => {
    console.error('erro fatal no orquestrador:', erro);
    process.exitCode = 1;
  });
}

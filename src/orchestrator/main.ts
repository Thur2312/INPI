import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { obterObjetoPeticaoPrincipal } from '../db/processos.js';
import { criarLogger } from '../utils/logger.js';
import type { ConfigWorker } from './workerLoop.js';
import { rodarOperacao } from './orquestrador.js';

async function main(): Promise<void> {
  const env = carregarEnv();

  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  const logger = criarLogger(join(env.OUTPUT_DIR, 'logs', `operacao-${Date.now()}.jsonl`), [
    env.INPI_SENHA,
  ]);

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
    valorEsperadoGru: env.VALOR_ESPERADO_GRU,
    pastaGuias: join(env.OUTPUT_DIR, 'guias'),
    pastaErros: join(env.OUTPUT_DIR, 'erros'),
    horaLimiteEmissao: env.HORA_LIMITE_EMISSAO,
    hardStop22h: env.HARD_STOP_22H,
  };

  const browser = await chromium.launch({ headless: true });

  const operacao = rodarOperacao({
    db,
    browser,
    credenciais: { usuario: env.INPI_USUARIO, senha: env.INPI_SENHA },
    maxWorkers: env.MAX_WORKERS,
    objetoPeticaoTexto: objetoInfo.texto,
    config,
    logger,
    pastaBackup: join(dirname(env.DB_PATH), 'backups'),
    backupIntervaloMinutos: env.BACKUP_INTERVALO_MINUTOS,
    orfaoTimeoutMinutos: env.ORFAO_TIMEOUT_MINUTOS,
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

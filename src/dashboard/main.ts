import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { criarLogger } from '../utils/logger.js';
import { criarGerenciadorOperacao } from './gerenciadorOperacao.js';
import { criarApp } from './servidor.js';

const RAIZ_PROJETO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function main(): void {
  const env = carregarEnv();

  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  if (!env.DASHBOARD_SENHA) {
    console.warn(
      'AVISO: DASHBOARD_SENHA não configurada — o painel está sem autenticação própria. ' +
        'Só é seguro se ele estiver acessível apenas pela rede Tailscale (ver docs/runbook-vps.md). ' +
        'Agora que o painel pode subir a automação e receber planilhas com CPF/CNPJ de cliente, configure DASHBOARD_SENHA no .env antes de operar de verdade.',
    );
  }

  const logger = criarLogger(
    join(env.OUTPUT_DIR, 'logs', 'dashboard.jsonl'),
    [env.INPI_SENHA, ...(env.DASHBOARD_SENHA ? [env.DASHBOARD_SENHA] : [])],
  );

  const gerenciadorOperacao = criarGerenciadorOperacao({
    cwd: RAIZ_PROJETO,
    pidPath: join(env.OUTPUT_DIR, 'operacao.pid'),
    logPath: join(env.OUTPUT_DIR, 'logs', 'operacao-processo.log'),
  });

  const app = criarApp(db, {
    gerenciadorOperacao,
    logger,
    raizProjeto: RAIZ_PROJETO,
    logPath: join(env.OUTPUT_DIR, 'logs', 'operacao-processo.log'),
    ...(env.DASHBOARD_SENHA !== undefined && { senha: env.DASHBOARD_SENHA }),
    configPadrao: {
      maxWorkers: env.MAX_WORKERS,
      pausaEntreAcoesMinMs: env.PAUSA_ENTRE_ACOES_MIN_MS,
      pausaEntreAcoesMaxMs: env.PAUSA_ENTRE_ACOES_MAX_MS,
      largadaWorkerMinMs: env.LARGADA_WORKER_MIN_MS,
      largadaWorkerMaxMs: env.LARGADA_WORKER_MAX_MS,
      verificadorIntervaloMinMs: env.VERIFICADOR_INTERVALO_MIN_MS,
      verificadorIntervaloMaxMs: env.VERIFICADOR_INTERVALO_MAX_MS,
    },
  });
  const servidor = app.listen(env.DASHBOARD_PORT, () => {
    console.log(`dashboard disponível em http://localhost:${env.DASHBOARD_PORT}`);
  });

  const encerrar = (): void => {
    servidor.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', encerrar);
  process.once('SIGTERM', encerrar);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

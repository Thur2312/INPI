import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { criarLogger } from '../utils/logger.js';
import { importarPlanilhaParaBanco } from './importarParaBanco.js';

async function main(): Promise<void> {
  const caminhoPlanilha = process.argv[2];
  if (!caminhoPlanilha) {
    console.error('uso: npm run importar -- <caminho-da-planilha.csv|.xlsx>');
    process.exitCode = 1;
    return;
  }

  const env = carregarEnv();
  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  const logger = criarLogger(
    join(env.OUTPUT_DIR, 'logs', `importacao-${Date.now()}.jsonl`),
    [env.INPI_SENHA],
  );

  try {
    const resumo = await importarPlanilhaParaBanco(db, caminhoPlanilha, logger);

    console.log(`Planilha: ${resumo.arquivo}`);
    console.log(`Total de linhas na planilha: ${resumo.totalNaPlanilha}`);
    if (resumo.errosDeFormato.length > 0) {
      console.log(`Rejeitadas no schema (não entraram no banco): ${resumo.errosDeFormato.length}`);
      for (const erro of resumo.errosDeFormato) {
        console.log(`  - linha ${erro.posicao}: ${erro.mensagem}`);
      }
    }
    console.log(`Validadas (prontas para a fila): ${resumo.validados}`);
    console.log(`Pendência de dados (precisa correção manual): ${resumo.pendenciaDados}`);
    console.log(`Pendência de limite (excedeu o teto por titular): ${resumo.pendenciaLimite}`);
    console.log(`Movidas para AGUARDANDO_ABERTURA: ${resumo.movidosParaAguardandoAbertura}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((erro: unknown) => {
    console.error('erro fatal na importação:', erro);
    process.exitCode = 1;
  });
}

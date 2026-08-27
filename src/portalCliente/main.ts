import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { criarAppPortalCliente } from './servidor.js';

const RAIZ_PROJETO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function main(): void {
  const env = carregarEnv();

  if (!env.PORTAL_CLIENTE_TOKEN_SEGREDO) {
    throw new Error(
      'PORTAL_CLIENTE_TOKEN_SEGREDO não configurado — obrigatório para subir o portal do cliente ' +
        '(é o segredo que assina a sessão de login por CNPJ/CPF; sem ele, qualquer um poderia forjar ' +
        'uma sessão para qualquer documento). Gere um valor aleatório de pelo menos 32 caracteres.',
    );
  }
  if (!env.PORTAL_CLIENTE_ADMIN_SENHA) {
    console.warn(
      'AVISO: PORTAL_CLIENTE_ADMIN_SENHA não configurada — as rotas /api/admin/* do portal do cliente ' +
        'ficam sem autenticação própria. Só é seguro atrás de uma rede fechada.',
    );
  }

  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  const app = criarAppPortalCliente(db, {
    segredoToken: env.PORTAL_CLIENTE_TOKEN_SEGREDO,
    raizProjeto: RAIZ_PROJETO,
    ...(env.PORTAL_CLIENTE_ADMIN_SENHA !== undefined && { senhaAdmin: env.PORTAL_CLIENTE_ADMIN_SENHA }),
  });

  const servidor = app.listen(env.PORTAL_CLIENTE_PORT, () => {
    console.log(`portal do cliente disponível em http://localhost:${env.PORTAL_CLIENTE_PORT}`);
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

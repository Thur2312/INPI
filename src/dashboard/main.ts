import { fileURLToPath } from 'node:url';
import { carregarEnv } from '../config/env.js';
import { abrirConexao } from '../db/connection.js';
import { migrar } from '../db/migrate.js';
import { criarApp } from './servidor.js';

function main(): void {
  const env = carregarEnv();

  const db = abrirConexao(env.DB_PATH);
  migrar(db);

  const app = criarApp(db);
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

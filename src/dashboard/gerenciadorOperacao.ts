import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EstadoOperacao {
  rodando: boolean;
  pid: number | null;
  iniciadoEm: string | null;
}

export interface GerenciadorOperacao {
  estado(): EstadoOperacao;
  /** Lança se já houver uma operação rodando — nunca inicia duas em paralelo. */
  iniciar(overridesEnv: Record<string, string>): EstadoOperacao;
  /** Sinal de parada graciosa (SIGTERM) — `orchestrator/main.ts` já trata isso: termina o item em andamento antes de sair. Não faz nada se não estiver rodando. */
  parar(): void;
}

function pidVivo(pid: number): boolean {
  try {
    // sinal 0 não mata nada — só testa se o processo existe e é acessível.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Só o essencial para rastrear "existe um `npm run operar` em andamento e
 * qual é o PID dele" através de reinícios do próprio dashboard (ex.: PM2
 * reiniciando o painel não pode perder o controle de um processo real que
 * ainda está rodando) — por isso o PID vai para um arquivo, não só memória.
 */
export function criarGerenciadorOperacao(opcoes: {
  cwd: string;
  pidPath: string;
  logPath: string;
  /** Override de teste: comando real é `npm run operar`, mas testes injetam algo inofensivo. */
  comando?: readonly string[];
}): GerenciadorOperacao {
  const { cwd, pidPath, logPath } = opcoes;
  const comando = opcoes.comando ?? [
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    'run',
    'operar',
  ];

  let processoAtual: ChildProcess | null = null;

  function lerPidArquivo(): number | null {
    if (!existsSync(pidPath)) return null;
    const conteudo = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(conteudo, 10);
    return Number.isFinite(pid) ? pid : null;
  }

  function estado(): EstadoOperacao {
    if (processoAtual && processoAtual.pid !== undefined && pidVivo(processoAtual.pid)) {
      return { rodando: true, pid: processoAtual.pid, iniciadoEm: lerIniciadoEm() };
    }
    // Painel pode ter reiniciado depois do `iniciar()` — reconcilia pelo arquivo de PID.
    const pidDoArquivo = lerPidArquivo();
    if (pidDoArquivo !== null && pidVivo(pidDoArquivo)) {
      return { rodando: true, pid: pidDoArquivo, iniciadoEm: lerIniciadoEm() };
    }
    if (pidDoArquivo !== null) {
      // processo morreu sem ninguém limpar o arquivo (crash, kill -9 externo).
      try {
        unlinkSync(pidPath);
      } catch {
        // arquivo já sumiu — nada a fazer.
      }
    }
    return { rodando: false, pid: null, iniciadoEm: null };
  }

  function lerIniciadoEm(): string | null {
    const caminhoIniciadoEm = `${pidPath}.iniciado_em`;
    if (!existsSync(caminhoIniciadoEm)) return null;
    return readFileSync(caminhoIniciadoEm, 'utf-8').trim();
  }

  function iniciar(overridesEnv: Record<string, string>): EstadoOperacao {
    if (estado().rodando) {
      throw new Error('já existe uma operação em andamento — pare antes de iniciar outra');
    }

    mkdirSync(dirname(pidPath), { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true });

    const arquivoLog = openSync(logPath, 'a');
    const [comandoBin, ...argsComando] = comando;
    const filho = spawn(comandoBin as string, argsComando, {
      cwd,
      env: { ...process.env, ...overridesEnv },
      detached: true,
      stdio: ['ignore', arquivoLog, arquivoLog],
    });
    filho.unref();

    if (filho.pid === undefined) {
      throw new Error('falha ao iniciar o processo da operação (sem PID)');
    }

    processoAtual = filho;
    writeFileSync(pidPath, String(filho.pid), 'utf-8');
    const iniciadoEm = new Date().toISOString();
    writeFileSync(`${pidPath}.iniciado_em`, iniciadoEm, 'utf-8');

    filho.once('exit', () => {
      processoAtual = null;
      try {
        unlinkSync(pidPath);
      } catch {
        // já removido — nada a fazer.
      }
    });

    return { rodando: true, pid: filho.pid, iniciadoEm };
  }

  function parar(): void {
    const atual = estado();
    if (!atual.rodando || atual.pid === null) return;
    try {
      process.kill(atual.pid, 'SIGTERM');
    } catch {
      // processo já não existe mais — nada a fazer.
    }
  }

  return { estado, iniciar, parar };
}

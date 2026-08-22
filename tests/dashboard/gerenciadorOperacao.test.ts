import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarGerenciadorOperacao } from '../../src/dashboard/gerenciadorOperacao.js';

let pastaTemp: string;

// Comando inofensivo que fica "vivo" por um tempo controlável, sem tocar
// Playwright/INPI — só para exercitar spawn/estado/parar de verdade.
function comandoDeTeste(duracaoMs: number): string[] {
  return [process.execPath, '-e', `setTimeout(() => process.exit(0), ${duracaoMs})`];
}

beforeEach(() => {
  pastaTemp = mkdtempSync(join(tmpdir(), 'inpi-gerenciador-'));
});

afterEach(async () => {
  // No Windows, o handle do arquivo de log (aberto via `openSync` e
  // herdado pelo processo filho) pode levar um instante a mais para ser
  // liberado pelo SO depois do SIGTERM — `rmSync` imediato pode esbarrar
  // num EPERM passageiro. Não é um bug do gerenciador, só um detalhe de
  // limpeza de teste no Windows.
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    try {
      rmSync(pastaTemp, { recursive: true, force: true });
      return;
    } catch (erro) {
      if (tentativa === 4) throw erro;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

describe('criarGerenciadorOperacao', () => {
  it('estado() inicial: não rodando', () => {
    const gerenciador = criarGerenciadorOperacao({
      cwd: pastaTemp,
      pidPath: join(pastaTemp, 'operacao.pid'),
      logPath: join(pastaTemp, 'operacao.log'),
      comando: comandoDeTeste(5000),
    });

    expect(gerenciador.estado()).toEqual({ rodando: false, pid: null, iniciadoEm: null });
  });

  it('iniciar() sobe o processo, grava o PID em arquivo e estado() reflete rodando=true', async () => {
    const pidPath = join(pastaTemp, 'operacao.pid');
    const gerenciador = criarGerenciadorOperacao({
      cwd: pastaTemp,
      pidPath,
      logPath: join(pastaTemp, 'operacao.log'),
      comando: comandoDeTeste(5000),
    });

    const estadoIniciar = gerenciador.iniciar({});
    expect(estadoIniciar.rodando).toBe(true);
    expect(estadoIniciar.pid).toBeGreaterThan(0);

    expect(gerenciador.estado()).toEqual(estadoIniciar);
    expect(readFileSync(pidPath, 'utf-8').trim()).toBe(String(estadoIniciar.pid));

    gerenciador.parar();
    await vi.waitFor(() => expect(gerenciador.estado().rodando).toBe(false), { timeout: 3000 });
  });

  it('iniciar() lança quando já existe uma operação em andamento', () => {
    const gerenciador = criarGerenciadorOperacao({
      cwd: pastaTemp,
      pidPath: join(pastaTemp, 'operacao.pid'),
      logPath: join(pastaTemp, 'operacao.log'),
      comando: comandoDeTeste(5000),
    });

    gerenciador.iniciar({});
    expect(() => gerenciador.iniciar({})).toThrow(/já existe uma operação em andamento/);

    gerenciador.parar();
  });

  it('parar() em processo já saudável leva estado() a rodando=false depois que o SIGTERM é processado', async () => {
    const gerenciador = criarGerenciadorOperacao({
      cwd: pastaTemp,
      pidPath: join(pastaTemp, 'operacao.pid'),
      logPath: join(pastaTemp, 'operacao.log'),
      comando: comandoDeTeste(5000),
    });

    gerenciador.iniciar({});
    gerenciador.parar();

    await vi.waitFor(() => expect(gerenciador.estado().rodando).toBe(false), { timeout: 3000 });
  });

  it('parar() sem nada rodando não lança', () => {
    const gerenciador = criarGerenciadorOperacao({
      cwd: pastaTemp,
      pidPath: join(pastaTemp, 'operacao.pid'),
      logPath: join(pastaTemp, 'operacao.log'),
      comando: comandoDeTeste(5000),
    });

    expect(() => gerenciador.parar()).not.toThrow();
  });

  it('reconcilia pelo arquivo de PID quando é uma instância nova do gerenciador (simula reinício do painel)', async () => {
    const pidPath = join(pastaTemp, 'operacao.pid');
    const logPath = join(pastaTemp, 'operacao.log');

    const gerenciador1 = criarGerenciadorOperacao({ cwd: pastaTemp, pidPath, logPath, comando: comandoDeTeste(5000) });
    const estadoIniciar = gerenciador1.iniciar({});

    // "painel reiniciou" = nova instância, sem memória do processoAtual em RAM.
    const gerenciador2 = criarGerenciadorOperacao({ cwd: pastaTemp, pidPath, logPath, comando: comandoDeTeste(5000) });
    expect(gerenciador2.estado().rodando).toBe(true);
    expect(gerenciador2.estado().pid).toBe(estadoIniciar.pid);

    gerenciador2.parar();
    await vi.waitFor(() => expect(gerenciador2.estado().rodando).toBe(false), { timeout: 3000 });
  });
});

import { describe, expect, it } from 'vitest';
import { carregarEnv } from '../../src/config/env.js';

const BASE = { INPI_USUARIO: 'user', INPI_SENHA: 'pass' };

describe('carregarEnv', () => {
  it('lança com mensagem clara quando INPI_USUARIO/INPI_SENHA estão ausentes', () => {
    expect(() => carregarEnv({})).toThrow(/INPI_USUARIO/);
  });

  it('aplica os defaults documentados quando só o obrigatório é informado', () => {
    const env = carregarEnv(BASE);
    expect(env.MAX_WORKERS).toBe(4);
    expect(env.PAUSA_ENTRE_ACOES_MIN_MS).toBe(2000);
    expect(env.PAUSA_ENTRE_ACOES_MAX_MS).toBe(4000);
    expect(env.LARGADA_WORKER_MIN_MS).toBe(10_000);
    expect(env.LARGADA_WORKER_MAX_MS).toBe(15_000);
    expect(env.VERIFICADOR_INTERVALO_MIN_MS).toBe(20_000);
    expect(env.VERIFICADOR_INTERVALO_MAX_MS).toBe(30_000);
    expect(env.ESPERA_FILA_VAZIA_MS).toBe(3000);
  });

  it('permite MAX_WORKERS acima de 4 (até o teto de sanidade de 20)', () => {
    expect(carregarEnv({ ...BASE, MAX_WORKERS: '12' }).MAX_WORKERS).toBe(12);
    expect(carregarEnv({ ...BASE, MAX_WORKERS: '20' }).MAX_WORKERS).toBe(20);
  });

  it('rejeita MAX_WORKERS acima de 20', () => {
    expect(() => carregarEnv({ ...BASE, MAX_WORKERS: '21' })).toThrow();
  });

  it('rejeita MAX_WORKERS abaixo de 1', () => {
    expect(() => carregarEnv({ ...BASE, MAX_WORKERS: '0' })).toThrow();
  });

  it('aceita ritmo mais agressivo quando explicitamente configurado', () => {
    const env = carregarEnv({
      ...BASE,
      PAUSA_ENTRE_ACOES_MIN_MS: '200',
      PAUSA_ENTRE_ACOES_MAX_MS: '500',
      LARGADA_WORKER_MIN_MS: '2000',
      LARGADA_WORKER_MAX_MS: '4000',
    });
    expect(env.PAUSA_ENTRE_ACOES_MIN_MS).toBe(200);
    expect(env.PAUSA_ENTRE_ACOES_MAX_MS).toBe(500);
    expect(env.LARGADA_WORKER_MIN_MS).toBe(2000);
    expect(env.LARGADA_WORKER_MAX_MS).toBe(4000);
  });

  it('rejeita PAUSA_ENTRE_ACOES_MIN_MS maior que o MAX', () => {
    expect(() =>
      carregarEnv({ ...BASE, PAUSA_ENTRE_ACOES_MIN_MS: '5000', PAUSA_ENTRE_ACOES_MAX_MS: '1000' }),
    ).toThrow(/PAUSA_ENTRE_ACOES_MIN_MS/);
  });

  it('rejeita LARGADA_WORKER_MIN_MS maior que o MAX', () => {
    expect(() =>
      carregarEnv({ ...BASE, LARGADA_WORKER_MIN_MS: '20000', LARGADA_WORKER_MAX_MS: '5000' }),
    ).toThrow(/LARGADA_WORKER_MIN_MS/);
  });

  it('rejeita VERIFICADOR_INTERVALO_MIN_MS maior que o MAX', () => {
    expect(() =>
      carregarEnv({
        ...BASE,
        VERIFICADOR_INTERVALO_MIN_MS: '40000',
        VERIFICADOR_INTERVALO_MAX_MS: '10000',
      }),
    ).toThrow(/VERIFICADOR_INTERVALO_MIN_MS/);
  });
});

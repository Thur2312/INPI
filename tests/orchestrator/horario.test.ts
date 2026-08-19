import { describe, expect, it } from 'vitest';
import { passouDoHorarioLimite } from '../../src/orchestrator/horario.js';

describe('passouDoHorarioLimite', () => {
  it('false antes do horário limite', () => {
    const agora = new Date('2026-09-01T21:59:59');
    expect(passouDoHorarioLimite('22:00', agora)).toBe(false);
  });

  it('true exatamente no horário limite', () => {
    const agora = new Date('2026-09-01T22:00:00');
    expect(passouDoHorarioLimite('22:00', agora)).toBe(true);
  });

  it('true depois do horário limite', () => {
    const agora = new Date('2026-09-01T23:30:00');
    expect(passouDoHorarioLimite('22:00', agora)).toBe(true);
  });

  it('false num horário qualquer da manhã', () => {
    const agora = new Date('2026-09-01T10:00:00');
    expect(passouDoHorarioLimite('22:00', agora)).toBe(false);
  });
});

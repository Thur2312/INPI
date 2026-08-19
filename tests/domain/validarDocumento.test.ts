import { describe, expect, it } from 'vitest';
import { validarCNPJ, validarCPF, validarDocumento } from '../../src/domain/validarDocumento.js';

describe('validarCPF', () => {
  it('aceita CPF válido, com ou sem máscara', () => {
    expect(validarCPF('111.444.777-35')).toBe(true);
    expect(validarCPF('11144477735')).toBe(true);
  });

  it('rejeita dígito verificador incorreto', () => {
    expect(validarCPF('11144477736')).toBe(false);
  });

  it('rejeita sequência de dígitos repetidos (passaria no cálculo, mas é lixo)', () => {
    expect(validarCPF('11111111111')).toBe(false);
  });

  it('rejeita tamanho errado', () => {
    expect(validarCPF('123')).toBe(false);
  });
});

describe('validarCNPJ', () => {
  it('aceita CNPJ válido, com ou sem máscara', () => {
    expect(validarCNPJ('11.222.333/0001-81')).toBe(true);
    expect(validarCNPJ('11222333000181')).toBe(true);
  });

  it('rejeita dígito verificador incorreto', () => {
    expect(validarCNPJ('11222333000182')).toBe(false);
  });

  it('rejeita sequência de dígitos repetidos', () => {
    expect(validarCNPJ('11111111111111')).toBe(false);
  });
});

describe('validarDocumento', () => {
  it('detecta CPF pelo tamanho e valida', () => {
    expect(validarDocumento('11144477735')).toEqual({ valido: true, tipo: 'CPF' });
  });

  it('detecta CNPJ pelo tamanho e valida', () => {
    expect(validarDocumento('11222333000181')).toEqual({ valido: true, tipo: 'CNPJ' });
  });

  it('tamanho que não é nem CPF nem CNPJ é inválido sem tipo', () => {
    expect(validarDocumento('123456')).toEqual({ valido: false, tipo: null });
  });
});

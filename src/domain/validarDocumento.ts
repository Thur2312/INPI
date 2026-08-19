/**
 * Validação de dígito verificador de CPF/CNPJ.
 *
 * Por quê isso importa aqui: a base do INPI aceita documentos com DV
 * inválido (ex.: "11111111111111" retorna um cliente cadastrado — testado
 * em 18/08/2026). Se não validarmos do nosso lado antes de buscar, o robô
 * pode acabar emitindo uma GRU para um titular errado só porque o dado de
 * entrada da planilha veio digitado errado.
 */

export type TipoDocumento = 'CPF' | 'CNPJ';

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

export function validarCPF(valor: string): boolean {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais: sempre "válido" pelo cálculo, mas é lixo

  const digitos = cpf.split('').map(Number);

  const dv1 = calcularDigitoVerificador(digitos.slice(0, 9), 10);
  if (dv1 !== digitos[9]) return false;

  const dv2 = calcularDigitoVerificador(digitos.slice(0, 10), 11);
  if (dv2 !== digitos[10]) return false;

  return true;
}

export function validarCNPJ(valor: string): boolean {
  const cnpj = somenteDigitos(valor);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const digitos = cnpj.split('').map(Number);
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const dv1 = calcularDigitoVerificadorComPesos(digitos.slice(0, 12), pesos1);
  if (dv1 !== digitos[12]) return false;

  const dv2 = calcularDigitoVerificadorComPesos(digitos.slice(0, 13), pesos2);
  if (dv2 !== digitos[13]) return false;

  return true;
}

/** Detecta o tipo pelo tamanho (após normalizar) e valida o DV correspondente. */
export function validarDocumento(valor: string): { valido: boolean; tipo: TipoDocumento | null } {
  const digitos = somenteDigitos(valor);
  if (digitos.length === 11) {
    return { valido: validarCPF(digitos), tipo: 'CPF' };
  }
  if (digitos.length === 14) {
    return { valido: validarCNPJ(digitos), tipo: 'CNPJ' };
  }
  return { valido: false, tipo: null };
}

function calcularDigitoVerificador(digitos: number[], pesoInicial: number): number {
  let soma = 0;
  let peso = pesoInicial;
  for (const d of digitos) {
    soma += d * peso;
    peso -= 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function calcularDigitoVerificadorComPesos(digitos: number[], pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < digitos.length; i += 1) {
    soma += (digitos[i] as number) * (pesos[i] as number);
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

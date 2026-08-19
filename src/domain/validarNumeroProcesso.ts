import { DIGITOS_NUMERO_PROCESSO } from '../config/constants.js';

/**
 * Formato do número de processo administrativo do INPI (ex.: "940328100").
 * Só dígitos, tamanho fixo. Aceita a entrada com pontuação e normaliza.
 */
export function validarNumeroProcesso(valor: string): { valido: boolean; normalizado: string } {
  const normalizado = valor.replace(/\D/g, '');
  return { valido: normalizado.length === DIGITOS_NUMERO_PROCESSO, normalizado };
}

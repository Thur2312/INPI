import { describe, expect, it } from 'vitest';
import { assinarToken, verificarToken } from '../../src/portalCliente/token.js';

const SEGREDO = 'segredo-de-teste-bem-comprido-1234567890';

describe('assinarToken / verificarToken', () => {
  it('emite um token que verifica de volta para o mesmo documento', () => {
    const token = assinarToken('11144477735', SEGREDO, 60_000);
    const resultado = verificarToken(token, SEGREDO);
    expect(resultado).toEqual({ documento: '11144477735' });
  });

  it('rejeita token expirado', () => {
    const token = assinarToken('11144477735', SEGREDO, -1);
    expect(verificarToken(token, SEGREDO)).toBeNull();
  });

  it('rejeita token assinado com outro segredo', () => {
    const token = assinarToken('11144477735', SEGREDO, 60_000);
    expect(verificarToken(token, 'outro-segredo-diferente-qualquer')).toBeNull();
  });

  it('rejeita token adulterado (documento trocado depois de assinado)', () => {
    const token = assinarToken('11144477735', SEGREDO, 60_000);
    const decodificado = Buffer.from(token, 'base64url').toString('utf-8');
    const [, validoAte, assinatura] = decodificado.split('.');
    const tokenAdulterado = Buffer.from(`99999999999.${validoAte}.${assinatura}`, 'utf-8').toString(
      'base64url',
    );
    expect(verificarToken(tokenAdulterado, SEGREDO)).toBeNull();
  });

  it('rejeita lixo que não é um token válido', () => {
    expect(verificarToken('isso-nao-e-um-token', SEGREDO)).toBeNull();
    expect(verificarToken('', SEGREDO)).toBeNull();
  });
});

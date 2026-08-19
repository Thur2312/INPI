/**
 * Corte das 22h: por padrão só um aviso (guias emitidas após esse horário
 * só podem ser pagas no dia útil seguinte — mensagem do INPI é sobre
 * pagamento, não proibição de emitir). Travar a fila por padrão poderia
 * interromper um lote quase terminado sem necessidade; vira hard stop só
 * com a flag `HARD_STOP_22H` explicitamente ligada.
 */
export function passouDoHorarioLimite(horaLimite: string, agora: Date = new Date()): boolean {
  const [horas, minutos] = horaLimite.split(':').map(Number);
  const limite = new Date(agora);
  limite.setHours(horas ?? 22, minutos ?? 0, 0, 0);
  return agora >= limite;
}

-- Alerta do verificador de abertura de cota: quando o dropdown de objeto
-- da petição ganha opções novas (a cota abriu com alguma modalidade) mas
-- nenhuma bate com o texto configurado, o robô nunca escolhe sozinho —
-- só registra o que apareceu para um humano decidir. Colunas separadas de
-- status/motivo (que já existiam) de propósito: aquelas controlam o
-- semáforo RODANDO/PAUSADA que os workers obedecem; isto aqui é só
-- informativo para o painel, não deve interferir na fila.
ALTER TABLE operacao ADD COLUMN alerta_categoria_opcoes TEXT;
ALTER TABLE operacao ADD COLUMN alerta_categoria_em TEXT;

-- Tabela principal: um registro por processo/requerimento de GRU 3020.
CREATE TABLE processos (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  posicao                INTEGER NOT NULL,                 -- ordem de aparição na planilha importada; usada como desempate determinístico
  fila                   TEXT NOT NULL CHECK (fila IN ('PRINCIPAL', 'RESERVA')),
  cliente                TEXT,
  titular_documento      TEXT NOT NULL,                    -- CPF/CNPJ normalizado (somente dígitos)
  titular_nome           TEXT,
  numero_processo        TEXT NOT NULL,
  objeto_peticao         TEXT NOT NULL,                    -- texto a ser casado por regex no dropdown, nunca um value fixo
  prioridade             INTEGER,                          -- menor = mais prioritário; NULL = desempate por posicao
  protocolos_ja_utilizados INTEGER NOT NULL DEFAULT 0,      -- já usados pelo titular no quadrimestre corrente
  status                 TEXT NOT NULL DEFAULT 'IMPORTADO',
  worker                 TEXT,
  tentativas             INTEGER NOT NULL DEFAULT 0,
  nosso_numero           TEXT,
  codigo_gru             TEXT,
  valor_gru              TEXT,
  caminho_pdf            TEXT,
  erro_tipo              TEXT,
  erro_mensagem          TEXT,
  caminho_screenshot     TEXT,
  iniciado_em            TEXT,
  concluido_em           TEXT,
  criado_em              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_processos_status ON processos (status);
CREATE INDEX idx_processos_titular_documento ON processos (titular_documento);
CREATE INDEX idx_processos_posicao ON processos (posicao);

-- Log de auditoria, append-only. Nunca é UPDATE/DELETE, só INSERT.
CREATE TABLE eventos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  processo_id  INTEGER NOT NULL REFERENCES processos (id),
  timestamp    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  etapa        TEXT NOT NULL,
  acao         TEXT NOT NULL,
  resultado    TEXT NOT NULL,                              -- SUCESSO | FALHA | INFO
  mensagem     TEXT,
  duracao_ms   INTEGER
);

CREATE INDEX idx_eventos_processo_id ON eventos (processo_id);

-- Tabela de controle de operação: linha única (id fixo = 1). Usada pelo
-- verificador de abertura de cota para pausar/liberar todos os workers de
-- uma vez, sem que cada um faça polling individual do INPI.
CREATE TABLE operacao (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  status                 TEXT NOT NULL DEFAULT 'AGUARDANDO_ABERTURA' CHECK (
                           status IN ('AGUARDANDO_ABERTURA', 'RODANDO', 'PAUSADA')
                         ),
  motivo                 TEXT,
  objeto_peticao_value   TEXT,                             -- value do <option> descoberto pelo verificador, para log/auditoria
  pausada_em             TEXT,
  retomada_em            TEXT,
  atualizado_em          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO operacao (id, status) VALUES (1, 'AGUARDANDO_ABERTURA');

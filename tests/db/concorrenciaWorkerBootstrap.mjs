// Ponto de entrada da worker thread. Fica em JS puro de propósito: o Node
// precisa conseguir carregar este arquivo sem nenhum loader de TypeScript
// já ativo. Ele usa a API `tsImport` do tsx para então importar
// concorrenciaWorker.ts sob demanda — `execArgv: ['--import', 'tsx/esm']`
// não propaga o loader para dentro de uma worker thread (testado; o
// import do .ts falha silenciosamente com "Cannot find module"), então
// isso não pode ser feito por fora, via execArgv, e precisa ser feito por
// dentro, via API.
import { tsImport } from 'tsx/esm/api';

await tsImport('./concorrenciaWorker.ts', import.meta.url);

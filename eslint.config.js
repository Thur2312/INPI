// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Scripts em JS puro (worker de teste, scripts/) rodam fora do
    // pipeline TS de propósito — mas ainda são Node de verdade, então
    // precisam dos globals do Node (URL, console, process...), que
    // `disableTypeChecked` sozinho não dá (só desliga regras de tipo).
    files: ['**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    // Arquivo de configuração de tooling, fora do tsconfig do projeto.
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    // `expect(objetoFalso.metodo).toHaveBeenCalledWith(...)` é o padrão
    // normal de asserção do vitest sobre mocks — a regra confunde isso
    // com "método desacoplado do objeto" e dá falso positivo constante.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // JS de navegador servido estático pelo dashboard/portal do cliente — fora do pipeline TS/Node de propósito.
    ignores: ['dist/', 'node_modules/', 'output/', 'data/', 'src/dashboard/public/', 'src/portalCliente/public/'],
  },
  prettier,
);

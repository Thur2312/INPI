// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
    // Worker de teste em JS puro, roda fora do pipeline TS de propósito (ver comentário no arquivo).
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Arquivo de configuração de tooling, fora do tsconfig do projeto.
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
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
    // JS de navegador servido estático pelo dashboard — fora do pipeline TS/Node de propósito.
    ignores: ['dist/', 'node_modules/', 'output/', 'data/', 'src/dashboard/public/'],
  },
  prettier,
);

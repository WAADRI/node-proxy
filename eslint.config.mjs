// ESLint flat config (ESLint 9) - Phase 0 of the TypeScript migration (#42).
// Rules only apply to .ts files; the existing JS codebase is untouched until
// each module migrates. New code must be TypeScript and must not use `any`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/public/**',
      'server/web/**',
      'deploy/**',
    ],
  },
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  }
);

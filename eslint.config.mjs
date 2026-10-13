import tseslint from 'typescript-eslint';
export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ['out/**', 'node_modules/**', '.local/**'],
  rules: {'@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}], '@typescript-eslint/no-explicit-any': 'error'}
});

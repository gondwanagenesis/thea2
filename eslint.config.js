// ESLint flat config. Beyond generic hygiene this enforces the determinism law
// (AGENTS.md §3): module code never touches wall-clock or entropy directly —
// Clock and Rng are injected from M01-kernel. src/kernel/clock.ts is the single
// sanctioned escape hatch; tests additionally forbid network access.

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const noTimeOrEntropy = [
  'error',
  {
    selector: 'MemberExpression[object.name="Date"][property.name="now"]',
    message: 'Inject Clock from M01-kernel and call epochMs() — Date.now is a determinism violation.',
  },
  {
    selector: 'NewExpression[callee.name="Date"]',
    message: 'Inject Clock from M01-kernel and call now() — new Date is a determinism violation.',
  },
  {
    selector: 'MemberExpression[object.name="Math"][property.name="random"]',
    message: 'Inject Rng from M01-kernel — Math.random is a determinism violation.',
  },
  {
    selector: 'CallExpression[callee.name="setTimeout"]',
    message: 'Use Clock.waitUntil from M01-kernel — bare setTimeout is a determinism violation.',
  },
  {
    selector: 'MemberExpression[object.name="globalThis"][property.name="setTimeout"]',
    message: 'Use Clock.waitUntil from M01-kernel — setTimeout is a determinism violation.',
  },
  {
    selector: 'CallExpression[callee.name="setInterval"]',
    message: 'Use Clock.waitUntil in a loop from M01-kernel — setInterval is a determinism violation.',
  },
];

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'scratch/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-var': 'error',
    },
  },
  {
    // Determinism law in shipped code. The system clock itself is exempt.
    files: ['src/**/*.ts', 'schemas/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/kernel/clock.ts'],
    rules: {
      'no-restricted-syntax': noTimeOrEntropy,
    },
  },
  {
    // Hermetic tests: no network. If a test needs a real service it is a probe.
    files: ['test/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No network in tests — use MockModel / FakeChannel / injected seams.' },
        { name: 'WebSocket', message: 'No network in tests — use FakeChannel.' },
      ],
      'no-restricted-syntax': noTimeOrEntropy,
    },
  },
];

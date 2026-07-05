import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                console: 'readonly',
                globalThis: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'smart'],
            'no-invalid-this': 'error',
            'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
            'object-shorthand': 'error',
            'prefer-template': 'error',
            'prefer-arrow-callback': 'error',
            'consistent-return': 'error',
            'no-shadow': 'error',
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['gi://Gtk*', 'gi://Adw*', 'gi://Gdk*'],
                    message: 'Gtk/Adw/Gdk run in the preferences process, not the Shell process this file runs in.',
                }],
            }],
        },
    },
];

const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^require$/]',
          message: 'require()-based feature detection is forbidden (open-core §7) — use feature flags.',
        },
        {
          selector: 'MemberExpression[object.name="Metro"][property.name="require"]',
          message: 'Metro.require is forbidden (open-core §7) — use feature flags.',
        },
      ],
    },
  },
]);

module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-syntax-highlighter/dist/esm/(.*)$': 'react-syntax-highlighter/dist/cjs/$1',
  },
  testEnvironment: 'jsdom',
};

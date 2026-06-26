module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/test/integration/'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};

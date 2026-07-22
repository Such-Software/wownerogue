module.exports = {
  // Run tests in Node environment
  testEnvironment: 'node',
  // Move Jest's logical root to the project root (one level above this config file)
  rootDir: '..',
  // Look for tests inside the existing top-level test directory
  roots: ['<rootDir>/test'],
  collectCoverage: false,
  moduleFileExtensions: ['js','json'],
};

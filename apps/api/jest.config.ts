export default {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/api',
  // The tRPC router itself is tested in libs/trpc; the specs here cover the
  // Express shell (config parsing, rate limiter, security headers, CORS).
  passWithNoTests: true,
};

export default {
  displayName: 'keeper',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/keeper',
  // The keeper app is a thin bootstrap (src/main.ts); all keeper logic and
  // its specs live in libs/trpc/src/lib/keeper and run under `nx test trpc`.
  // Allow the test target to pass when there are no spec files here.
  passWithNoTests: true,
};

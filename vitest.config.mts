import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Measure ALL application source. Per CLAUDE.md, nothing is excluded to
      // flatter the number — cover the code instead. Generated artifacts (e.g.
      // db/types.generated.ts) are simply not hand-written source, so `include`
      // scopes to src/** rather than listing them as exclusions.
      include: ['src/**/*.ts'],
      exclude: [],
    },
  },
});

// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // tsconfig's `noUncheckedIndexedAccess` is what makes `!` load-bearing
      // throughout this codebase (array/record lookups the code has already
      // reasoned are present); banning it would just move the same certainty
      // into unchecked casts instead.
      "@typescript-eslint/no-non-null-assertion": "off",
      // A plain number is always safe to interpolate; only `object`/`any`-ish
      // values are worth flagging here.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // The compile-time-only assertions in schema.ts (and similar) are read
      // by `tsc`, never imported — leading `_` marks that as deliberate.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // node:test's `test()` returns a promise that the test runner itself
    // tracks; nothing in a test file is meant to await or handle it further,
    // and a fake backend's `chat()` often has nothing to `await` at all.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);

import { defineConfig, globalIgnores } from "eslint/config";
import { baseConfig } from "../../eslint.config.base.mjs";

const eslintConfig = defineConfig([
  // Generated migration artifacts and build/cache output are not source.
  globalIgnores(["drizzle/**", ".turbo/**", "dist/**"]),

  ...baseConfig(import.meta.dirname),
]);

export default eslintConfig;

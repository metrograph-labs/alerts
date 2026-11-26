import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/. index.js is the library and index.d.ts has its types. priors.js has the committed priors, with the file in it.
// The workspace runs the source (main is src/index.ts). publishConfig points the published package at the build.
export default defineConfig({
  entry: ["src/index.ts", "src/priors.ts"],
  // priors.ts imports the root by the name of the package, so the root stays one file.
  deps: { neverBundle: ["@mark1russell7/alerts"] },
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});

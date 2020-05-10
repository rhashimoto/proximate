import typescript from "@rollup/plugin-typescript";

function config({ format, minify }) {
  const dir = `dist/${format}/`;
  return {
    input: "src/Proximate.ts",
    output: {
      name: "Proximate",
      file: `dist/${format}/Proximate${minify ? ".min" : ""}.js`,
      format,
      sourcemap: true
    },
    plugins: [
      typescript({ noEmitOnError: false })
    ]
  };
}

export default [
  { format: "es",  minify: false },
  { format: "umd", minify: false }
].map(config);

import type { Configuration } from 'webpack';

import { plugins } from './webpack.plugins';

// Renderer-only module rules.
//
// The renderer runs in a BROWSER context: it has NO Node.js globals such as
// __dirname, __filename, require, or process. Therefore we must NOT reuse the
// main-process rules from ./webpack.rules (node-loader and
// @vercel/webpack-asset-relocator-loader). Those loaders are intended for the
// Electron MAIN process and emit Node-only code (require()/__dirname) which is
// undefined in the renderer, producing:
//   Uncaught ReferenceError: __dirname is not defined
const rendererRules = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
      },
    },
  },
  {
    test: /\.css$/,
    use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
  },
];

export const rendererConfig: Configuration = {
  // Pin the target to the browser so webpack does not leave Node globals
  // (__dirname / __filename / require) as free variables in the renderer
  // bundle. Without an explicit target the shared main-process loaders could
  // still be pulled in and reference __dirname at runtime.
  target: 'web',
  module: {
    rules: rendererRules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};

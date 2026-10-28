const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const {CleanWebpackPlugin} = require('clean-webpack-plugin');

// `chrome` -> dist/ with src/manifest.json (Chromium, MV3 service worker)
// `firefox` -> dist-firefox/ with src/manifest.firefox.json (Firefox has no
// service worker support, so the background is a plain event page there).
module.exports = ({target = 'chrome'} = {}) => {
  const outDir = target === 'firefox' ? 'dist-firefox' : 'dist';
  const manifest = target === 'firefox' ? 'src/manifest.firefox.json' : 'src/manifest.json';

  return {
    entry: {
      background: path.resolve('src/background/background.js'),
      content: path.resolve('src/content/content.js'),
      intercept: path.resolve('src/content/intercept.js'),
      catcher: path.resolve('src/content/catcher.js'),
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx)$/,
          use: [
            {
              loader: 'source-map-loader',
            },
            {
              loader: 'babel-loader',
              options: {
                presets: ['@babel/preset-env', '@babel/preset-react']
              }
            },
          ],
          exclude: /node_modules/,
        },
      ]
    },
    plugins: [
      new CleanWebpackPlugin({verbose: false}),
      new CopyPlugin({
        patterns: [{
          from: path.resolve(manifest),
          to: path.join(__dirname, outDir, 'manifest.json'),
          transform: content => {
            return Buffer.from(
              JSON.stringify({
                description: process.env.npm_package_description,
                version: process.env.npm_package_version,
                ...JSON.parse(content.toString())
              })
            );
          }
        }]
      }),
      new CopyPlugin({
        patterns: [
          {
            from: 'src/assets/img',
            to: path.join(__dirname, outDir),
            force: true,
          },
          {from: 'NOTICE.md', to: path.join(__dirname, outDir, 'NOTICE.md')},
          {from: 'node_modules/webextension-polyfill/LICENSE', to: path.join(__dirname, outDir, 'LICENSE-webextension-polyfill.txt')},
        ],
      })
    ],
    experiments: {
      topLevelAwait: true
    },
    resolve: {
      extensions: ['.js']
    },
    output: {
      filename: '[name].js',
      path: path.join(__dirname, outDir),
      clean: true,
      publicPath: '',
    },
    devtool: false
  };
};

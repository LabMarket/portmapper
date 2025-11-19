//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // VS Code extensions run in a Node.js-context
  entry: './extension.js', // O ponto de entrada da sua extensão
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  externals: {
    vscode: 'commonjs vscode', // O módulo 'vscode' é provido pelo VS Code em tempo de execução
  },
  resolve: {
    // A biblioteca ssh2 tem dependências que precisam dessas extensões para serem resolvidas.
    // A ausência disso faz o webpack procurar em locais padrão como 'src'.
    extensions: ['.js', '.json', '.node'],
    mainFields: ['main'], // Garante que o webpack use o campo "main" do package.json das dependências
  },
  module: {
    rules: [
      {
        test: /\.node$/,
        loader: 'node-loader',
        options: { name: '[name].[ext]' }
      }
    ],
  },
};
module.exports = config;

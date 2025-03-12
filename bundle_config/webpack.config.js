// webpack.config.js
const path = require('path');
const fs = require('fs');
const { merge } = require('webpack-merge')
// const baseConfig = require('./webpack.config.base')

const pjtPath = process.cwd();

function baseOption(){
    console.log("__dirname = " + __dirname)
    console.log("pjtPath = " + pjtPath)
    return {
        module: {
            rules: [
              {
                test: /\.(js|jsx|ts|tsx)$/,
                exclude: /src\/test/, // .\src\test 경로 제외
                // use: {
                //   loader: 'babel-loader',
                // },
              },
            ],
          },
        output: {
            path: path.resolve(pjtPath + "\\", 'dist'),
            pathinfo: false, // 코드 포맷 유지
            // library: 'MyLibrary',
            // libraryTarget: 'umd',
        },
        resolve: {
            modules: [path.resolve(pjtPath, 'src'), 'node_modules'],
        },
        node: {
            __dirname: false,
            __filename: false,
        },
        externals: { /* 제외파일 */
            deasync: 'commonjs deasync',
            // 'axios': 'commonjs axios',
            // 'lodash': 'commonjs lodash',
            // ... 다른 외부 모듈들
        },
        // devtool: 'inline-source-map', // 소스 맵 생성
        optimization: {
            splitChunks: { //추가된 부분 main.js에서 라이브러리르 분리하는 작업
                cacheGroups: {
                  commons: {
                    test: /[\\/]node_modules[\\/]/,
                    name: "bas-library",
                    chunks: "all"
                  }
                }
            },
            // minimize: false, // 코드 압축 비활성화
        },
    };
}

function getJsFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    // console.log("dir = " + dir);

    list.forEach((file) => {
        const filePath = path.join(dir, file);
        // console.log("filePath = " + filePath);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            // 하위 디렉터리인 경우 재귀적으로 탐색
            results = results.concat(getJsFiles(filePath));
        } else if (file.endsWith('.js')) {
            // .js 파일인 경우 결과 배열에 추가
            results.push("./" + filePath.replace(/\\/g, '/'));
        }
    });
    console.log("results = " + results);
    return results;
}

function cleanFile(){
    const regex = new RegExp("config|.+\.bat", "g");
    let distPath = pjtPath + "\\dist";
    // dist 폴더 내 모든 파일 삭제 (예외 파일 제외)
    fs.readdirSync(distPath).forEach(file => {
        if (!regex.test(file)) {
            console.log("file = " + file);
            fs.rmSync(path.join(distPath, file), { recursive: true, force: true });
        }
    });
}

/*
    hlng
*/
function makerHlngOptions(){
    let files = getJsFiles("./src/util");
    return {
        entry: {
            "bas-HlngConfluence":'./src/HlngConfluence.js',
            "bas-Util": getJsFiles('.\\src\\util'),
            // "bas-Util": files,
            // library: ["axios"]
        },
        output: {
          filename: '[name].js',
        },
        target: 'node', // node.js환경에서 실행됨
    };
}

module.exports = (env, argv) => {
    let config = merge({}, baseOption());
    // console.log("test = " + env.param1);
    if (argv.mode === 'development') {
    //   config.devtool = 'source-map';
    }else if (argv.mode === 'production') {
      //...
    }
    cleanFile();
    config = merge(config, makerHlngOptions());

    return config;
  };
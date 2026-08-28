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
    let distPath = pjtPath + "\\dist";
    if (!fs.existsSync(distPath)) return;

    // 지우면 안 되는 것: 설정 폴더와 실행 런처.
    //
    // ⚠️ 예전에는 new RegExp("config|.+\.bat", "g") 를 test() 로 돌렸는데,
    //    g 플래그가 붙은 정규식의 test() 는 lastIndex 를 전진시켜 호출마다
    //    결과가 달라진다. 그래서 보호 대상이 순서에 따라 삭제됐다 —
    //    실제로 dist/config 가 통째로 날아갔다. 상태 없는 판정으로 바꾼다.
    const keep = file => file === "config" || file.toLowerCase().endsWith(".bat");

    fs.readdirSync(distPath).forEach(file => {
        if (keep(file)) return;
        console.log("clean = " + file);
        fs.rmSync(path.join(distPath, file), { recursive: true, force: true });
    });
}

/*
    hlng
*/
function makerHlngOptions(){
    let files = getJsFiles("./src/util");
    return {
        entry: {
            "bas-index": './src/index.js',
            "bas-HlngConfluence":'./src/HlngConfluence.js',
            // 배포 파이프라인 CLI. 스테이지를 전부 정적 require 하므로 그대로 번들된다.
            // 실행: node bas-deploy.js --yaml=<경로> [--dry-run]
            "bas-deploy": './src/deploy/deploy-cli.js',
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
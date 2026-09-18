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

/*
    dist 는 배포 패키지 전체다 — 번들 + bundle_config/deploy 의 정적 파일(런처·스크립트·설정·LICENSE).
    통째로 지우고 다시 만든다. dist 에 손으로 넣은 파일은 다음 빌드에서 사라진다.

    예전에는 "지우면 안 되는 것"(config·.bat)을 골라 남겼는데, 그 목록에 없는
    LICENSE 가 빌드마다 지워졌다(2026-09-18). 남길 것을 고르는 대신 원본을 따로 두고 복사한다.

    ⚠️ webpack 의 output.clean 을 쓰지 않는다. emit 시점에 webpack 이 만들지 않은 파일을
       지우므로, 여기서 복사한 파일이 같이 사라진다.
*/
function cleanFile(){
    const distPath = path.join(pjtPath, "dist");
    fs.rmSync(distPath, { recursive: true, force: true });
    console.log("clean = " + distPath);
}

function copyStatic(){
    const src = path.join(pjtPath, "bundle_config", "deploy");
    const dest = path.join(pjtPath, "dist");
    fs.cpSync(src, dest, { recursive: true });
    console.log("copy = " + src + " -> " + dest);
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
    copyStatic();
    config = merge(config, makerHlngOptions());

    return config;
  };
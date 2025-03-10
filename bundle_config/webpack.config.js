// webpack.config.js
const path = require('path');
const { merge } = require('webpack-merge')
// const baseConfig = require('./webpack.config.base')

function baseOption(){
    console.log("__dirname = " + __dirname)
    return {
        output: {
            path: path.resolve(__dirname + "\\..", 'dist'),
            pathinfo: false, // 코드 포맷 유지
            // library: 'MyLibrary',
            // libraryTarget: 'umd',
        },
        externals: { /* 제외파일 */
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
                    name: "library",
                    chunks: "all"
                  }
                }
            },
            // minimize: false, // 코드 압축 비활성화
        },
    };
}

/*
    test
*/
function makerOptionTest(){
    return {
        entry: {
            main:'./src/Test.js',
            // library: ["axios"]
        },
        output: {
          filename: 'bas-[name].js',
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
  
    config = merge(config, makerOptionTest());

    return config;
  };
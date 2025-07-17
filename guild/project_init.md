# 프로젝트 초기화

>```
># 플젝 초기화 package.json 파일 생성됨
>$> npm init -y
>
># package 모듈설치
># --save package.json저정
># -dev dev참조
>npm install --save-dev pkg
>npm install --save lodash
>npm install --save deasync
>npm install --save request-promise-native
>npm install --save crypto
>npm uninstall stack-trace
>
># 개발
>npm install webpack webpack-cli --save-dev
>```

# 배포
```
# 번들처리시 deasync 제외됨
npm install deasync

```

# 배포명령어
npm install webpack webpack-cli --save-dev
npx webpack --config .\bundle_config\webpack.config.js


프로젝트 배포
실행시 배포경로 이동
패키지 설치
npm install --production
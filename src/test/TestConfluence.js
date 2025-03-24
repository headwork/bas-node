const _util = require('../util/common');
const _cflc = require('../util/confluence');

let _config = {
    API_TOKEN : ""
    , URL_API : "/wiki/rest/api/content/"
    , credentials : null
    , ROOT_PATH : null
    , COMMENT_PATH : null
    , DATA_PATH : null
    , TAG_DEPLOY : "TEST"
}
initConfig();
if(!_config.isRun) return;
// testCleanComment(); /* 댓글 삭제 */
updateRequestPage();

function updateRequestPage(){
    _config.TAG_DEPLOY = "PROD";
    _config.TAG_DEPLOY = "QA";



    let pageKey = null;
    // _cflc.updateRequestPage({..._config, pageId:"96993281"});
    // _cflc.updateRequestPage({..._config, pageId:"97812481"});
    // _cflc.updateRequestPage({..._config, pageId:"97615917"});
    pageKey = [""
        // , "97714178"    //고정
        , "103251969"    //고정
        // , "96993281"    //재직
    ];
    str = "{key:123}, {key:222}, {key:333}"
    // pageKey = _cflc.findContnetsKeys(str);
    // console.log(pageKey);
    // return ;
    pageKey.forEach(element => {
        if(element == "") return;
        _cflc.updateRequestPage({..._config, pageId:element});
    });  
}

/* 댓글 */
function testCleanComment(){
    _cflc.cleanPageComment({..._config
        , parentPageId : _config.PARENT_PAGE_ID.QA_PAGE_ID
        , pageId : "94928897"});
}

// testProssUpdate();  /** 요청내용 업데이트 */
/** 요청내용 업데이트 */
function testProssUpdate(){
    _config.TAG_DEPLOY = "QA";
    _config.TAG_DEPLOY = "PROD";
    let pageId = "94928897";
    // let pageId = "93028439";
    _cflc.updateRequestPage({ ..._config
        , parentPageId : _config.PARENT_PAGE_ID.QA_PAGE_ID
        , pageId:pageId
    });
    if(_config.TAG_DEPLOY == "QA"){

    }
    // updateRequestPageComment
    // _cflc.updateRequestPageComment({..._config, parentPageId : _config.PARENT_PAGE_ID.QA_PAGE_ID
    //     , pageId:pageId
    // });
}

function initConfig(){
    // 사용자 이름과 API 토큰 결합
    let tmep = _util.getConfig("hlngs.json");
    _config = _util.marge(_config, tmep);

    let credentials = `${_config.USERNAME}:${_config.API_TOKEN}`;
    _config.isRun = false;
    if(process.argv.length > 4){
        _config.API_TOKEN = process.argv[2];
        _config.ROOT_PATH = process.argv[3];
        _config.DATA_PATH = process.argv[4];
        _config.COMMENT_PATH = process.argv[5];
        _config.TAG_DEPLOY = process.argv[6]?? "TEST";

        if(_config.TAG_DEPLOY == "PROD"){
            _config.parentPageId = _config.PARENT_PAGE_ID.PROD_PAGE_ID;
        }else{
            _config.parentPageId = _config.PARENT_PAGE_ID.QA_PAGE_ID;
        }

        if(_config.TAG_DEPLOY == "TEST"){
            // 사용자 이름과 API 토큰 결합
            credentials = `${_config.USERNAME}:${_config.API_TOKEN}`;
            global.isDebug = true;
        }else if(_config.TAG_DEPLOY == "LOCAL"){
            // 사용자 이름과 API 토큰 결합
            credentials = `${_config.USERNAME}:${_config.API_TOKEN}`;
            global.isDebug = true;
        }else{
            credentials = _config.API_TOKEN
        }
        if(global.isDebug) console.log(`_config.PARENT_PAGE_ID = ${_config.PARENT_PAGE_ID}`);

        // Base64 인코딩
        _config.credentials = Buffer.from(credentials).toString('base64');
        _config.isRun = true;
    }else{
        console.log("설정오류");
        return "FAIL";
    }
    
    return "SUCCESS";
}

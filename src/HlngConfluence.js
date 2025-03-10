const _util = require('./util/common');
const _cflc = require('./util/confluence');

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
console.log(callConfluencePage());

/* 배포이력등록 */
function callConfluencePage(){
    let data = null;
    let result = "FAIL";
    try {
        data = _util.utilFile.fileLoad(_config.ROOT_PATH + "\\" + _config.DATA_PATH);
        /* parent page id변경 */
        let temp = JSON.parse(data);
        if(temp.ancestors != null && temp.ancestors.length > 0){
            temp.ancestors[0].id = _config.parentPageId;
        }
        if(temp.body != null && temp.body.storage != null && temp.body.storage.value != null){
            let bodyValue = temp.body.storage.value || "";
            let lines = bodyValue.split('<br/>');
            const filteredLines = lines.filter(line => !line.includes('Merge branch')); // "Merge branch"를 포함하지 않는 라인만 필터링
            temp.body.storage.value = filteredLines.join('<br/>');
        }

        if(_config.TAG_DEPLOY == "LOCAL" || _config.TAG_DEPLOY == "TEST"){
            temp.title = "test " + _util.utilDate.getYYYYMMDDHHMM();
        }
        
        // data = JSON.stringify(temp);
        // console.log(JSON.stringify(temp));
        let param = {..._config, data:temp};
        let res = _cflc.callRequest({...param, method:"POST", async:false, URL_ADD:""});
        console.log();
        // console.log("res.id = " + res.id);
        // let jsonData = JSON.parse(res);
        // if(true) return "";
        param.pageId = res.id;
        if(param.pageId == null){
            _cflc.errorPage(param);
        }else{
            console.log("pageId = " + param.pageId);
            _cflc.pageMoveFirst(param);
            callConfluenceComment();
            result = "SUCCESS";
        }
    }catch(error){
        console.log(JSON.stringify(error));
        console.error('API 호출 또는 JSON 파싱 오류:', error);
    };
    return result;
}

function callConfluenceComment(){
    let data = null;
    let result = "FAIL";
    try {
        /* comment등록 */
        data = _util.utilFile.fileLoad(_config.ROOT_PATH + "\\" + _config.COMMENT_PATH);
        /* parent page id변경 */
        let temp = JSON.parse(data);
        temp.container.id = _config.parentPageId;

        let param = {..._config, data:temp, URL_ADD:""};
        let res = _cflc.callRequest({...param, method:"POST", async:false});
        _cflc.cleanPageComment(param);
        result = "SUCCESS";
    }catch(error){
        console.error('API 호출 또는 JSON 파싱 오류:', error);
    };
    return result;
}

function initConfig(){
    // 사용자 이름과 API 토큰 결합
    let tmep = _util.getConfig("hlngs.json");
    _config = _util.marge(_config, tmep);

    let credentials = `${_config.USERNAME}:${_config.API_TOKEN}`;
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
    }else{
        console.log("설정오류");
        return "FAIL";
    }
    
    return "SUCCESS";
}

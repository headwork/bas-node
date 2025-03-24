const _util = require('./common');
const _logger = _util.utilLogger;

let utilConfluence = (()=>{
    const _that = {};

    _that.defOptions = (param)=>{
        param.uri = `${param.YOUR_DOMAIN}${param.URL_API}${param.URL_ADD??""}`;
        const options = {
            uri:param.uri || param.url,
            method: param.method || "GET", // HTTP 메서드
            async: param.async,
            headers: {
              'Authorization': `Basic ${param.credentials}`, // API 토큰 (필수)
              'Accept': 'application/json; charset=utf-8;' // JSON 응답 요청
            }
        }
        if(param.data != null){
            options.json = true;
            options.data = param.data;
        }
        return options;
    }
    _that.newComment = (param)=>{
        return {"type":"comment"
            ,"container":{
                  "id":param.pageId
                , "type":"page"
            }
            ,"body":{"storage":{
                  "value":param.value
                , "representation": "storage"
            }}
        };
    }
    _that.newPageBody = (param)=>{
        // result.id
        // result.body.storage.value
        // result.version.number
        return {
              id: param.pageId
            , type:"page"
            , title: param.title
            , body: { storage: { 
                          value: param.value
                        , representation: "storage" 
                    }}
            , version: { number: param.version + 1 }
        }
    }

    _that.callRequest = (param, callback, callbackError)=>{
        return _util.callRequest(_that.defOptions(param), callback, callbackError);
    }
    _that.isPageLabel = (param, checkLabel)=>{
        param.URL_ADD = `${param.pageId}/label`;
        let res = _util.callRequest(_that.defOptions({...param, method:"GET", async:false}));
        if(typeof(res) == "string"){
            res = JSON.parse(res);
        }
        return res.results.some(item => {return item.name == checkLabel;});
    }

    _that.updateRequestPageComment = function (param, value){
        param.data = _that.newComment({
            pageId:param.pageId
            , value: (value || `[${param.TAG_DEPLOY}]서버 배포했습니다.`)
        });
        param.URL_ADD = "";
        let opt = _that.defOptions({...param, method:"POST"});
        _util.callRequest(opt
            , (res)=>{}
            , (res)=>{
                console.error(`page[${param.pageId}] update error[${res.response.statusCode}]`);
        });
    }

    /* 라벨이 개발완료일때 처리안함 */
    _that.updateRequestPage = function (param){
        let result = null;
        let jsonData = null;
        let checkDone = false;
        try{
            let changeText = "90%";
            if(param.TAG_DEPLOY == "PROD") changeText = "100%";

            checkDone = _that.isPageLabel(param, "개발완료");
            if(global.isDebug) console.log("checkDone = " + checkDone);
            if(checkDone) return;

            /* 진행율 체크, 업데이트 */
            param.URL_ADD = `${param.pageId}?expand=body.storage,version`;
            result = _util.callRequest(_that.defOptions({...param, method:"GET", async:false}));
            result = JSON.parse(result);
            if(global.isDebug) console.log("title = " + result.title);
            if(!_that.changeProgress(result, changeText)) return;
            if(param.TAG_DEPLOY == "PROD") _that.changeDate(result, "완료일");

            param.URL_ADD = param.pageId;
            param.data = _that.newPageBody({
                pageId: result.id
                , title : result.title
                , value : result.body.storage.value
                , version : result.version.number
            });
            result = _util.callRequest(_that.defOptions({...param, method:"PUT"})
                , (res)=>{}
                , (res)=>{
                    console.error(`param.data = ${JSON.stringify(param.data)}`);
                    console.error(JSON.stringify(res));
                    console.error(`page[${param.pageId}] update error[${res.response.statusCode}]`);
            });

            if(param.TAG_DEPLOY == "QA"){
                _that.updateRequestPageComment({...param});
            }

            /* 라벨변경 */
            if(param.TAG_DEPLOY != "PROD") return;
            if(global.isDebug) console.log("label 추가 ");
            param.URL_ADD = `${param.pageId}/label`;
            param.data = [{"prefix":"global","name":"개발완료"}];
            result = _util.callRequest(_that.defOptions({...param, method:"POST"})
                , (res)=>{}
                , (res)=>{
                    console.error(`page[${param.pageId}] label add error[${res.response.statusCode}]`);
                });
            if(global.isDebug) console.log("label 삭제 ");
            param.URL_ADD = param.pageId + encodeURI("/label/개발중") ;
            delete param.data;
            result = _util.callRequest(_that.defOptions({...param, method:"DELETE"})
                , (res)=>{}
                , (res)=>{
                    console.error(`page[${param.pageId}] label delete error[${res.response.statusCode}]`);
                });
        }catch(e){
            console.error(e);
        }
    }

    _that.changeProgress = function (pageData, toVal){
        let content = pageData.body.storage.value;

        // 진행률이 90%가 아닐 경우 업데이트
        const regex = /(<th><p><strong>진행률<\/strong><\/p><\/th><td>)(<p>\d+%<\/p>|<p \/>)(<\/td>)/;
        // const regex = /(<th><p><strong>진행률<\/strong><\/p><\/th><td><p>)(\d+%)(<\/p><\/td>)/;
        const match = content.match(regex);
        if (match){
            if (match[2] == "<p />") {
                pageData.body.storage.value = content.replace(regex, `$1<p>${toVal}</p>$3`);
                return true;
            }
            const matchPer = match[2].match(/(\d+%)/);

            if (matchPer && matchPer[1] !== toVal){
                pageData.body.storage.value = content.replace(regex, `$1<p>${toVal}</p>$3`);
                return true;
            }
        }
    
        return false;
    }

    _that.changeDate = function (pageData, item){
        let content = pageData.body.storage.value;      
        let toVal = `<p><time datetime="${new Date().toISOString().split("T")[0]}" /><\/p>`
        const regex = new RegExp(`(<th><p><strong>${item}<\/strong><\/p><\/th><td>)(<p>.*?<\/p>|<p \/>)(<\/td>)`);
        pageData.body.storage.value = content.replace(regex, (match, p1, p2, p3) => {
            return `${p1}${toVal}${p3}`;
        });
    }

    /* 에러페이지 */
    _that.errorPage = (param)=>{
        let timestamp = _util.utilDate.getYYYYMMDDHHMM();
        let data = {
            "title": `[${param.TAG_DEPLOY}] API 에러 ${timestamp}`,
            "type": "page",
            "space": { "key": param.SPACE_KEY },
            "status": "current",
            "ancestors": [{ "id": param.parentPageId }],
            "body": { "storage": { "value": "--", "representation": "storage" } }
        }
        param.URL_ADD = "";
        let opt = _that.defOptions({...param, method:"POST", async:false});
        let result = _util.callRequest(opt);

        let jsonData = JSON.parse(result);
        param.pageId = jsonData.id;
        param.minCount = -1;
        _that.pageMoveFirst(param);
    }

    _that.pageMoveFirst = (param)=>{
        let result = null;
        param.URL_ADD = `${param.parentPageId}/child/page`;
        delete param.data;
        let opt = _that.defOptions({...param, method:"GET", async:false});
        res = _util.callRequest(opt);
        res = JSON.parse(res);
        if(res.results == null || res.results.length < 2) return;
        let movePageId = res.results[0].id;
        param.URL_ADD = `${param.pageId}/move/before/${movePageId}`;
        _util.callRequest(_that.defOptions({...param, method:"PUT"})
            , (res)=>{}
            , (res)=>{
                console.error(`page[${param.pageId}, ${movePageId}] move error[${res.response.status}]`);
        });

        _that.cleanPage(param, res.results);
    }

    _that.cleanPage = (param, list)=>{
        list = list.filter( item => item.id != param.pageId );

        /* clean  */
        let minCnt = param.minCount || 5;
        if(param.TAG_DEPLOY == "PROD"){
            minCnt = 20;
        }
        if(list.length <= minCnt) return;
        
        delete param.data;
        for (let index = (minCnt); index < list.length; index++) {
            const item = list[index];
            if(global.isDebug) console.log("page delete = " + item.id);

            param.URL_ADD = item.id;
            _util.callRequest(_that.defOptions({...param, method:"DELETE"})
                , (res)=>{}
                , (res)=>{
                    console.error(`page[${item.id}] delete error[${res.response.status}]`);
                });
        }
    }

    _that.cleanPageComment = (param)=>{
        let result = null;
        let jsonData = null;
        delete param.data;
        param.URL_ADD = `${param.parentPageId}/child/comment`;
        let opt = _that.defOptions({...param, method:"GET", async:false});
        result = _util.callRequest(opt);

        jsonData = JSON.parse(result);
        if(jsonData.results == null) return;

        let minCnt = param.minCount || 3;
        if(minCnt == -1) minCnt = 0;
        if(jsonData.results.length < minCnt) return;
        minCnt = (jsonData.results.length - minCnt);
        for (let index = 0; index < minCnt; index++) {
            const item = jsonData.results[index];
            if(global.isDebug) console.log("comment delete = " + item.id);
            param.URL_ADD = item.id;
            _util.callRequest(_that.defOptions({...param, method:"DELETE"})
                , (res)=>{}
                , (res)=>{
                    console.error(`page[${item.id}] comment delete error[${res.response.status}]`);
                });
        }
    }

    _that.findContnetsKeys = (strCont) => {
        const regex = new RegExp(`{key:(.*?)}`, "g");
        let pageKey = [];
        const matches = [...strCont.matchAll(regex)];
        matches.forEach((match, index) => {
            if(!pageKey.includes(match[1])) pageKey.push(match[1]);
            // console.log(`인덱스 ${index}: ${match} `);
        });
        return pageKey;;
    }

    return _that;
})();

module.exports = {
    ...utilConfluence
}
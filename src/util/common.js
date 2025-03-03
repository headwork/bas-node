const _request = require('request-promise-native');
const _deasync = require('deasync');
const _lodash = require('lodash');
const fs = require('fs');

function marge(){
    return _lodash.merge.apply(null, arguments);
}

function callSyncRequest(opts){
    let _that = {
        done : false
        , result : null
        , error : null
    }
    _that.req = _request(opts)
    .then((res)=>{_that.result = res; _that.done = true;})
    .catch((err)=>{_that.error = err; _that.done = true;});
    return _that;
}

/* 동기일때만 처리 */
function callRequests(opts){
    let opt = opts[0];
    let isAsync = opt.async;
    if(isAsync == null){
        isAsync = true;
    }
    return [];
}

function setRequestOptions(opts){
    // headers: { Authorization: `key=${fcmKey}` },
    // form: {
    //     name: 'Sachin Sahara',
    //     email: 'sachin@google.com'
    // }
    // formData: formData
}

function callRequest(opts){
    let isNotArray = !Array.isArray(opts);
    if(isNotArray) opts = [opts];

    opts.forEach(item => {
        if(global.isDebug) console.log("uri = " + item.uri);
        setRequestOptions(item);
    });

    let isAsync = opts[0].async;
    /* 비동기는 단건만 처리 */
    if(isAsync || isAsync == null){
        return _request(opts[0]);
    }

    let rtn = [];
    opts.forEach(item => {
        rtn.push(callSyncRequest(item));
    });

    while (true) {
        if(!rtn.some((item)=>item.done == false)) break;
        _deasync.runLoopOnce();
    }

    /* 단건일때 */
    if(isNotArray){
        let item = rtn[0];
        if (item.error != null) throw item.error;
        return item.result;
    }

    return rtn;
}

function fileSep(){
    if(global.sep == null){
        if((process.env.OS || "").toLowerCase().indexOf("window") > -1){
            global.sep = "\\";
        }else{
            global.sep = "/";
        }
    }
}

function initConfig(pathRoot){
    fileSep();
    let pathConfig = __dirname + global.sep + "config";
    if(pathRoot == null) {
        if(!fs.existsSync(pathConfig)) pathConfig = __dirname + global.sep + ".." + global.sep + "dist" + global.sep + "config";
    }else{
        pathConfig = pathRoot;
    }
    pathConfig += global.sep + "app.json";
    if(!fs.existsSync(pathConfig)){
        return ;
    }

    try {
        const data = fs.readFileSync(pathConfig, 'utf8'); // 'utf8' 인코딩 지정
        global = marge(global, JSON.parse(data));
    } catch (err) {
        console.error(err);
    }      
}

initConfig();

module.exports = {
    callRequest, marge,
}
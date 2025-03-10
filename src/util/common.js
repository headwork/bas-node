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
    if(opts.body == null && opts.data){
        opts.body = opts.data;
    }
        
    // headers: { Authorization: `key=${fcmKey}` },
    // form: {
    //     name: 'Sachin Sahara',
    //     email: 'sachin@google.com'
    // }
    // formData: formData
}

function callRequest(opts, callback, callbackError){
    let isNotArray = !Array.isArray(opts);
    if(isNotArray) opts = [opts];

    opts.forEach(item => {
        // if(global.isDebug) console.log("uri = " + item.uri);
        setRequestOptions(item);
    });

    let isAsync = opts[0].async??true;
    // if(global.isDebug) console.log("isAsync = " + isAsync);
    /* 비동기는 단건만 처리 */
    if(isAsync){
        if(callback){
            return _request(opts[0])
                .then((res)=>{
                    callback.call(opts[0], res);
                })
                .catch((err)=>{
                    utilLogger.debug("uri = " + item.uri);
                    (callbackError || callback).call(opts[0], err);
                });
        }else{
            return _request(opts[0]);
        }
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

function initConfig(fileName, pathRoot){
    fileSep();
    data = getConfig(fileName, pathRoot);
    if(data == null) return;
    global = marge(global, data);
}

function getConfig(fileName, pathRoot){
    let configFile = findConfigPath(pathRoot) + global.sep + fileName;
    if(global.isDebug) console.log(configFile);
    if(!fs.existsSync(configFile)){
        if(utilLogger.isDebug) utilLogger.debug("configFile " + configFile);
        return null;
    } 

    try {
        const data = fs.readFileSync(configFile, 'utf8'); // 'utf8' 인코딩 지정
        return JSON.parse(data);
    } catch (err) {
        utilLogger.error(err);
    }
    return null;
}

function findConfigPath(path){
    let pathConfig = path || (process.cwd() + global.sep + "config");
    if(!fs.existsSync(pathConfig)) pathConfig = process.cwd() + global.sep + ".." + global.sep + "dist" + global.sep + "config";
    if(!fs.existsSync(pathConfig)) pathConfig = process.cwd() + global.sep+ "dist" + global.sep + "config";
    return pathConfig;
}

initConfig("app.json");

let utilFile = (()=>{
    let _that = {};
    _that.fileLoad = function(filePath){
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            console.error('Error reading file:', err);
        }
        return null;
    }
    return _that;
})();

let utilDate = (()=>{
    let _that = {};
    _that.getYYYYMMDDHHMM = ()=>{
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0'); // 0부터 시작하므로 +1, 2자리로 맞춤
        return `${now.getFullYear()}${month}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    }

    _that.getYYYY_MM_DD = ()=>{
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0'); // 0부터 시작하므로 +1, 2자리로 맞춤
        return `${now.getFullYear()}-${month}-${pad2(now.getDate())}`;
    }

    function pad2(num){
        return String(num).padStart(2, '0')
    }
    return _that;
})();

let utilLogger = (()=>{
    const _logLevel = {
        DEBUG: 0,
        INFO: 1,
        NOTICE: 2,
        WARNING: 3,
        ERROR: 4,
        DISABLE: 99
    };
    const _checkLogLevel = Object.keys(_logLevel);
    let _level = _logLevel.DEBUG;
    function logPring(tag, msg, e){
        if(typeof(msg)){
            msg = JSON.stringify(msg, null, 2);
        }
        console.log(`[${tag} ${(new Date()).toISOString().replace(/T/, " ").substring(0, 19)}] : ` + (msg + logStack(e.stack)));
    }
    let _that ={
        ..._logLevel,
        get isDebug() { return _level <= _logLevel.DEBUG;},
        get isInfo() { return _level <= _logLevel.INFO;},
        get isError() { return _level <= _logLevel.ERROR;},
        log : function (msg){
            let e = new Error("");
            console.log(msg + logStack(e.stack));
        },
        debug : function (msg){
            if(_level > _logLevel.DEBUG) return;
            logPring(_checkLogLevel[_logLevel.DEBUG], msg, new Error(""));
        },
        info : function (msg){
            if(_level > _logLevel.INFO) return;
            logPring(_checkLogLevel[_logLevel.INFO], msg, new Error(""));
        },
        error : function (e){
            if(_level > _logLevel.ERROR) return;
            if(typeof(e) == "string"){
                console.error(`[ERROR ${(new Date()).toISOString().replace(/T/, " ").substring(0, 19)}] : ` + (e + logStack((new Error("")).stack)));
            }else if(e.stack){
                console.error(`[ERROR ${(new Date()).toISOString().replace(/T/, " ").substring(0, 19)}] : ` + (e.stack));
            }else{
                console.error(`[ERROR ${(new Date()).toISOString().replace(/T/, " ").substring(0, 19)}] : ` + (JSON.stringify(e, null, 2)));
            }
        }
    };

    function logStack(stack){
        if (!stack) return [];

        const lines = stack.split('\n'); // 첫 줄은 오류 메시지이므로 제외
        let msg = "";
        let cnt = 0;
        lines.slice(2).some(line => {
            if(line.indexOf("anonymous") > -1 || line.indexOf("Module._compile") > -1) return true;
            const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
            if (match) {
                msg += "\n" + line; ++cnt;
            }
            return cnt>2;
        });

        return msg;
    }

    function parseStack(stack){
        if (!stack) return [];

        const lines = stack.split('\n'); // 첫 줄은 오류 메시지이므로 제외
        const stackFrames = lines.slice(1).map(line => {
            const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
            if (match) {
                return {
                    functionName: match[1],
                    filePath: match[2],
                    lineNumber: parseInt(match[3]),
                    columnNumber: parseInt(match[4])
                };
            }
            return null;
        }).filter(frame => frame); // null 제거

        return stackFrames;
    }

    Object.defineProperty(_that, "level", {
        get() { 
            return _checkLogLevel[_level];
        },
        set(level) {
            level = level.toUpperCase();
            if(typeof(level) == number){
                _level = _checkLogLevel[level] || _level;
            }else if(_checkLogLevel.some(item=>item==level)){
                _level = _logLevel[level];
            }else{
                console.error("utilLogger 설정오류 level = " + level);
            }
        }
    });
    return _that;
})();

module.exports = {
    callRequest, marge, getConfig,
    utilFile,
    utilDate,
    utilLogger
}
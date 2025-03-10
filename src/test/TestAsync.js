const axios = require('axios');
const http = require('http');
const _util = require('../util/common');
const _request = require('request-promise-native');
const deasync = require('deasync');

const strUrl = "http://localhost:8090/dbm/api/example";

function test(){
  callHttp({async:false});
}


// test3();
console.log("__dirname = " + __dirname);
// console.log(JSON.stringify(process.env));
console.log("end");

function test3(param){
  global.isDebug = false;
  let opts = {
    uri : strUrl
  }

  let msg = "비동기1 ";
  _util.callRequest(opts).then((res)=>{
    console.log("비동기1 res = " + res);
  })
  .catch((err)=>{
    console.log("비동기1 err = " + err); 
  });

  _util.callRequest(opts).then((res)=>{
    console.log("비동기3 res = " + res);
  })
  .catch((err)=>{
    console.log("비동기3 err = " + err); 
  });

  opts.async = false;
  let result = _util.callRequest(opts);
  console.log("동기1 result = " + result);

  opts.async = true;
  _util.callRequest(opts).then((res)=>{
    console.log("비동기2 res = " + res);
  })
  .catch((err)=>{
    console.log("비동기2 err = " + err); 
  });

}
function test2(param){
  callAxios({}).then((res)=>{
    console.log("비동기 res1 = " + res);
  });
  callAxios({async:false});
  callAxios({}).then((res)=>{
    console.log("비동기 res2 = " + res);
  });
}
function callAxios(param){
    if(param.async == null){
      param.async = true;
    }
    // param.async
    if(!param.async){
      let done = false;
      let result = null;
      let error = null;
      axios.get(strUrl)
      .then((res)=>{result = res; done = true;})
      .catch((err)=>{error = err; done = true;});
      while (!done) {
        deasync.runLoopOnce();
      }
      if (error) {
        throw error;
      }
      console.log("동기 = " + JSON.stringify(result.data));
      return result;
    }else{
      return axios.get(strUrl);
    }
}

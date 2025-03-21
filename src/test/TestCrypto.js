const crypto = require('crypto');
const _util = (()=>{

  const _that = {
    crypto:{
        getKey:(param)=>{if(param.key == null) param.key = crypto.randomBytes(32);}
      , convertBufferToString : (_val)=> (typeof(_val) != "string") ? _val.toString('hex') : _val
      , convertStringToBuffer : (_val)=> (typeof(_val) == "string") ? Buffer.from(_val, 'hex') : _val
      , initParam:(param)=>{
        if(param.key == null){
          param.key = crypto.randomBytes(32);
        }else if(typeof(param.key) == "string"){
          param.key = _that.crypto.convertStringToBuffer(param.key);
        }
        if(param.iv == null){
          param.iv = crypto.randomBytes(16); // 초기화 벡터 생성
        }else if(typeof(param.iv) == "string"){
          param.iv = _that.crypto.convertStringToBuffer(param.iv);
        }
      }
    }
    , cryptoAES256CBC:{
      encrypt:(param)=>{
        _that.crypto.initParam(param);
        const cipher = crypto.createCipheriv('aes-256-cbc', param.key, param.iv);
        let encrypted = cipher.update(param.text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        param.encrypted = param.key.toString('hex') + ":" + param.iv.toString('hex') + ':' + encrypted;   // KEY, IV, 암호화된 텍스트 결합
        return param.encrypted;
      }
      , decrypt:(encryptedText, param)=>{
        const textParts = encryptedText.split(':');
        let key = null;
        let iv = null;
        if(textParts.length == 3){
          key = _that.crypto.convertStringToBuffer(textParts.shift());
          iv = _that.crypto.convertStringToBuffer(textParts.shift());
        }else{
          if(param == null) return null;
          _that.crypto.initParam(param);
          key = param.key;
          iv = param.iv;
        }
        const encrypted = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    }
  };
  return _that;
})();
let param = {text:"test"};
_util.cryptoAES256CBC.encrypt(param);
console.log('param.encrypted = ', param.encrypted);
param.decrypted = _util.cryptoAES256CBC.decrypt(param.encrypted);
console.log('param.decrypted = ', param.decrypted);

// AES-256-CBC 암호화 함수
function encrypt(text, key) {
    const iv = crypto.randomBytes(16); // 초기화 벡터 생성
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted; // IV와 암호화된 텍스트 결합
  }
  
  // AES-256-CBC 복호화 함수
  function decrypt(encryptedText, key) {
    const textParts = encryptedText.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encrypted = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
  
  // 예시
  let key = crypto.randomBytes(32); // 256비트 키 생성 (안전한 키 생성 방법 사용 권장)
  let strKey = key.toString('hex');
  console.log('key:', strKey);
  const plaintext = 'Hello, world!';
  const encrypted = encrypt(plaintext, Buffer.from(strKey, 'hex'));
//   key = crypto.randomBytes(32); // 256비트 키 생성 (안전한 키 생성 방법 사용 권장)
  const decrypted = decrypt(encrypted, Buffer.from(strKey, 'hex'));
  
  console.log('Encrypted:', encrypted);
  console.log('Decrypted:', decrypted);
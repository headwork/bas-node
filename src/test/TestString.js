const _util = require('../util/common');
const _cflc = require('../util/confluence');
const _logger = _util.utilLogger;

let map = {"a":1, b:2, c:false};
// console.log(map.c??true);
// testRegex("예정일");
// testRegex("완료일");

// testDate();

// testError1();
function testError1(){
    // _logger.debug("test");
    testError2();
    // testError2();
}

function testError2(){
    _logger.debug("test");
    // const error = new Error('testError2에서 오류 발생');
    // console.error(error.stack);
}


function testDate(){
    let temp = new Date().toISOString().split("T")[0];
    console.log("temp = " + temp);
}

function testRegex(completionDateText){
    let htmlString = `
    <th><p><strong>진행률</strong></p></th><td><p>50%</p></td>
    <th><p><strong>예정일</strong></p></th><td><p>2025-12-31</p></td>
    <th><p><strong>완료일</strong></p></th><td><p /></td>
    <th><p><strong>완료일1</strong></p></th><td><p /></td>
    <th><p><strong>완료일2</strong></p></th><td><p /></td>
    `
    const progressRegex = new RegExp(`(<th><p><strong>${completionDateText}<\/strong><\/p><\/th><td>)(<p>.*?<\/p>|<p \/>)(<\/td>)`);
    // Replace the progress percentage with the new progress text
    htmlString = htmlString.replace(progressRegex, (match, p1, p2, p3) => {
        return `${p1}<p>${1234}<\/p>${p3}`;
    });

    console.log(htmlString);
}

testRegex2();
function testRegex2(){
    let htmlString = `
    테스트1
    {key:97714178}
    {key:97714175}
    {key:97714178}
    테스트2
    `
    const regex = new RegExp(`{key:(.*?)}`, "g");
    let pageKey = [];
    // const matches = htmlString.match(regex);
    const matches = [...htmlString.matchAll(regex)];
    // if(matches.)
    // const uniqueKeys = [...new Set(matches)];
    // matches.forEach((match, index) => {
    //     if(!pageKey.includes(match[1])) pageKey.push(match[1]);
    //     console.log(`인덱스 ${index}: ${match} `);
    // });
    pageKey = _cflc.findContnetsKeys(htmlString);

    console.log(pageKey);
}
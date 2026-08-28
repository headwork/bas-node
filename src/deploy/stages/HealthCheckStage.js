const BaseStage = require('./BaseStage');
const axios = require('axios');

class HealthCheckStage extends BaseStage {
  async execute(stageConfig, basePath) {
    const url = stageConfig.url;
    const maxRetries = stageConfig.retry || 10;
    const intervalSec = stageConfig.interval_sec || 5;

    // 본문 대신 상태코드만으로 판정할 수 있어야 한다.
    // 정적 파일만 서비스하는 사이트는 루트에서 빈 응답을 주기 때문이다.
    //   expect_status: 200        -> 상태코드만 확인
    //   expect_body: "Healthy"    -> 본문 포함 여부까지 확인
    // 둘 다 없으면 기존 동작(본문에 'Healthy' 포함)을 유지한다.
    const expectStatus = stageConfig.expect_status || null;
    const expectBody = stageConfig.expect_body !== undefined
      ? stageConfig.expect_body
      : (expectStatus ? null : 'Healthy');

    // 리다이렉트를 따라가지 않는 선택지. 기동 확인만 하려는 경우에 쓴다.
    //   Razor 런타임 컴파일이 켜진 앱은 첫 페이지 렌더에 수십 초가 걸린다.
    //   루트의 302 만 확인하면 몇 초 안에 "앱이 떴다"를 판정할 수 있다.
    const followRedirects = stageConfig.follow_redirects !== false;

    if (!url) {
      throw new Error("HealthCheckStage requires 'url' parameter.");
    }

    console.log(`[HealthCheckStage] Starting health check for ${url}`);
    console.log(`[HealthCheckStage] Expecting ${expectBody ? `body: '${expectBody}'` : `status: ${expectStatus || 200}`}` +
      `, Retries: ${maxRetries}, Interval: ${intervalSec}s`);

    // Give service some initial time to start
    await this.sleep(intervalSec * 1000);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[HealthCheckStage] Attempt ${attempt}/${maxRetries}...`);
      try {
        const requestOptions = {
          timeout: stageConfig.timeout_ms || 5000,
          // Ignore self-signed certs if necessary
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        };
        if (!followRedirects) {
          requestOptions.maxRedirects = 0;
          // 3xx 를 예외로 던지지 않고 그대로 받아야 상태코드를 판정할 수 있다.
          requestOptions.validateStatus = () => true;
        }

        const response = await axios.get(url, requestOptions);

        const wantStatus = expectStatus || 200;
        if (response.status === wantStatus) {
           if (!expectBody) {
             console.log(`[HealthCheckStage] Health check passed! HTTP ${response.status}`);
             return; // Success - 상태코드만 확인
           }
           const bodyStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
           if (bodyStr.includes(expectBody)) {
             console.log(`[HealthCheckStage] Health check passed! Received expected body.`);
             return; // Success
           } else {
             console.log(`[HealthCheckStage] Body mismatch. Expected '${expectBody}', got part of: ${bodyStr.substring(0, 50)}`);
           }
        } else {
           console.log(`[HealthCheckStage] HTTP Status: ${response.status} (expected ${wantStatus})`);
        }
      } catch (err) {
        console.log(`[HealthCheckStage] Request failed: ${err.message}`);
      }

      if (attempt < maxRetries) {
        await this.sleep(intervalSec * 1000);
      }
    }

    throw new Error(`Health check failed after ${maxRetries} attempts.`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = HealthCheckStage;

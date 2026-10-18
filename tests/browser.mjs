import {chromium as browserType} from 'playwright';
// All browser checks keep Chromium's sandbox enabled. Container installs use system Chromium.
export const chromium={launch:options=>browserType.launch({...options,chromiumSandbox:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})})};

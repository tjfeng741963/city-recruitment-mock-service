const configured = Symbol('rea-dom-ready-navigation');

/** Compatibility shim for pinned wechaty-puppet-wechat 1.18.4.
 * Its login JSONP poll holds the page load event open indefinitely in current
 * Chrome. Angular readiness is still checked by the SDK's original onLoad;
 * only navigation and the event that triggers that check use DOM readiness.
 * No node_modules files, authentication, cookies or protocol headers change.
 */
export function configureWebNavigation(bridge) {
  if (!bridge || typeof bridge.initBrowser !== 'function') throw new Error('Unsupported Wechaty Web bridge');
  if (bridge[configured]) return bridge;
  bridge[configured] = true;
  const launch = bridge.initBrowser.bind(bridge);
  bridge.initBrowser = async (...args) => {
    const browser = await launch(...args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs);
      const goto = page.goto.bind(page);
      const reload = page.reload.bind(page);
      const on = page.on.bind(page);
      page.goto = (url, options) => goto(url, { waitUntil: 'domcontentloaded', ...options });
      page.reload = options => reload({ waitUntil: 'domcontentloaded', ...options });
      // This browser belongs only to the SDK, whose initPage subscribes here.
      page.on = (event, listener) => on(event === 'load' ? 'domcontentloaded' : event, listener);
      return page;
    };
    return browser;
  };
  return bridge;
}

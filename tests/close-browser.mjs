import { connect } from './cdp.mjs';
const browser = await connect();
try { await browser.call('Browser.close'); } finally { browser.close(); }

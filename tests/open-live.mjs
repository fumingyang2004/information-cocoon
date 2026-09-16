import { connect } from './cdp.mjs';
const browser = await connect();
try {
  let { extensions } = await browser.call('Extensions.getExtensions');
  let ext = extensions.find(e => e.path.toLowerCase() === 'c:\\lab0916\\juya');
  if (!ext) ext = await browser.call('Extensions.loadUnpacked', { path: 'C:\\Lab0916\\Juya' });
  const { targetId } = await browser.call('Target.createTarget', { url: 'https://www.bilibili.com/video/BV1mZes6uEYu/' });
  console.log({ ext, targetId });
  await new Promise(r => setTimeout(r, 12000));
  const { targetInfos } = await browser.call('Target.getTargets', { filter: [{}] });
  const tab = targetInfos.find(t => t.type === 'tab' && t.url.includes('BV1mZes6uEYu'));
  console.log(await browser.call('Extensions.triggerAction', { id: ext.id, targetId: tab.targetId }));
} finally { browser.close(); }

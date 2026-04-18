const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 12 Pro size
    isMobile: true
  });
  const page = await context.newPage();

  // The server is running on port 3000
  await page.goto('http://localhost:3000');

  // Wait for the app to load
  await page.waitForSelector('#app');

  // Take screenshot of Terminal tab (Empty state)
  await page.screenshot({ path: 'terminal_mobile.png' });

  // Open resource monitor to check mobile layout
  await page.click('#res-mon-btn');
  await page.waitForTimeout(500); // Animation
  await page.screenshot({ path: 'resource_monitor_mobile.png' });

  // Switch to Files tab
  await page.click('[data-tab="files"]');
  await page.waitForSelector('#files-list');
  await page.waitForTimeout(1000); // Load files
  await page.screenshot({ path: 'files_mobile.png' });

  // Switch to Ports tab
  await page.click('[data-tab="ports"]');
  await page.waitForSelector('#ports-list');
  await page.screenshot({ path: 'ports_mobile.png' });

  await browser.close();
})();

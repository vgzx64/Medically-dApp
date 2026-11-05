/**
 * Take the screenshots of the dApp for the report.
 *
 * The script drives a real Chromium (headless) against the built client and walks
 * the control panel section by section (#/overview, #/consents/..., #/events,
 * #/monitoring):
 *   1. the initial state (not connected),
 *   2. the connected state with the dev wallet,
 *   3. the patient signing a consent and the registrar registering it,
 *   4. the resulting event list,
 *   5. the monitoring panel with the raised alerts.
 *
 * Usage:
 *   node tools/screenshots.mjs --url http://127.0.0.1:4173 \
 *     --contract 0x... --out artifacts/screenshots
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../client/node_modules/playwright/index.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const options = {
  url: arg('url', 'http://127.0.0.1:4173'),
  contract: arg('contract', ''),
  out: arg('out', 'artifacts/screenshots'),
  executablePath: arg('chromium', process.env.CHROMIUM_PATH || ''),
  // --strict makes any browser error fail the run (used by the CI job).
  strict: args.includes('--strict'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  mkdirSync(options.out, { recursive: true });

  const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (options.executablePath) launchOptions.executablePath = options.executablePath;

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });

  // The runtime config is a localStorage override (see client/src/lib/config.ts),
  // so the script works both against a build that was compiled with VITE_* and
  // against a plain `vite dev` server.
  if (options.contract) {
    const runtimeConfig = {
      rpcUrl: 'http://127.0.0.1:8545',
      contractAddress: options.contract,
      chainId: 31337,
      walletMode: 'dev',
      devPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      registrarAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    };
    await context.addInitScript(
      `window.localStorage.setItem('pcr.config', ${JSON.stringify(JSON.stringify(runtimeConfig))});`,
    );
  }
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const shot = async (name) => {
    const path = join(options.out, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`saved ${path}`);
  };

  // The section lives in the URL hash, so the script drives the navigation directly.
  const openSection = async (hash) => {
    await page.evaluate((value) => {
      globalThis.location.hash = value;
    }, hash);
    await sleep(900);
  };

  console.log(`Opening ${options.url}`);
  await page.goto(`${options.url}/#/overview`, { waitUntil: 'networkidle', timeout: 30_000 });
  await sleep(800);
  await shot('01-overview-disconnected');

  // --- connect the dev wallet ---------------------------------------
  const devButton = page.getByRole('button', { name: /dev wallet/i });
  if (await devButton.count()) {
    await devButton.first().click();
    await sleep(2500);
    await shot('02-overview-connected');
  } else {
    console.warn('The dev wallet button was not found - skipping the connected screenshots');
  }

  // --- patient signs, registrar submits ------------------------------
  // The contract checks ECDSA.recover(digest) == patient and hashes msg.sender as
  // the issuer, so signing and submitting are two panels: the patient produces a
  // signed consent file, the registrar registers it.
  await openSection('#/consents/sign');
  const signButton = page.getByRole('button', { name: /^sign consent$/i });
  if (await signButton.count()) {
    await signButton.first().click();
    const signedJson = page.locator('#signed-json');
    await signedJson.waitFor({ timeout: 20_000 });
    // Read the file before leaving the tab: the element goes away with the panel.
    const signedConsent = await signedJson.inputValue();
    await shot('03-consent-signed');

    await openSection('#/consents/register');
    await page.locator('#consent-json').fill(signedConsent);
    await sleep(1500);
    const registerButton = page.getByRole('button', { name: /register signed consent/i });
    if (await registerButton.count()) {
      await registerButton.first().click();
      await sleep(3000);
      await shot('03-consent-registered');
    }
  } else {
    console.warn('The sign button was not found - skipping the registration screenshots');
  }

  // --- event list ----------------------------------------------------
  await openSection('#/events');
  await shot('04-events');

  // --- monitoring panel ---------------------------------------------
  await openSection('#/monitoring');
  const monitorTab = page.locator('#tab');
  if (await monitorTab.count()) {
    await monitorTab.selectOption('telemetry');
    await sleep(500);
    await shot('05-monitoring-telemetry');
  }

  // --- rule R2 fires in the UI -------------------------------------
  // A second session without any role repeats a forbidden revoke; every attempt
  // is rejected on chain, and after the 5th operational failure rule R2 raises
  // an alert inside the dApp (see client/src/lib/rules.ts).
  const outsider = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const outsiderConfig = {
    rpcUrl: 'http://127.0.0.1:8545',
    contractAddress: options.contract || undefined,
    chainId: 31337,
    walletMode: 'dev',
    // Public Anvil test key #2 - it holds no role in the registry.
    devPrivateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    registrarAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  };
  await outsider.addInitScript(
    `window.localStorage.setItem('pcr.config', ${JSON.stringify(JSON.stringify(outsiderConfig))});`,
  );
  const outsiderPage = await outsider.newPage();
  outsiderPage.on('pageerror', (e) => errors.push(String(e)));
  outsiderPage.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await outsiderPage.goto(`${options.url}/#/consents/revoke`, { waitUntil: 'networkidle', timeout: 30_000 });
  await outsiderPage.getByRole('button', { name: /dev wallet/i }).first().click();
  await outsiderPage.waitForTimeout(2500);

  // A consent id that does not exist: revokeConsent reverts with ConsentNotFound.
  await outsiderPage.locator('#revoke-id').fill(`0x${'00'.repeat(31)}01`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await outsiderPage.locator('button:has-text("Revoke")').first().click();
    await outsiderPage.waitForTimeout(700);
  }

  await outsiderPage.evaluate(() => {
    globalThis.location.hash = '#/monitoring';
  });
  await outsiderPage.waitForTimeout(900);
  const outsiderTab = outsiderPage.locator('#tab');
  if (await outsiderTab.count()) {
    await outsiderTab.selectOption('alerts');
    await outsiderPage.waitForTimeout(500);
  }
  const alertShot = join(options.out, '06-monitoring-alerts.png');
  await outsiderPage.screenshot({ path: alertShot, fullPage: true });
  console.log(`saved ${alertShot}`);
  await outsider.close();

  await browser.close();

  if (errors.length) {
    console.log('\nBrowser errors:');
    for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
    if (options.strict) {
      console.log(`\nFAIL: ${errors.length} browser error(s) with --strict`);
      process.exitCode = 1;
    }
  } else {
    console.log('\nNo browser errors.');
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

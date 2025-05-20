const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const child_process = require('node:child_process');

const download = require('./download');
const config = require('./config.json');

const fsExists = util.promisify(fs.exists);
const mkdir = util.promisify(fs.mkdir);
const exec = util.promisify(child_process.exec);

const forceInstall = process.argv.includes('--force');
if (forceInstall) {
  console.log('--force, ignoring caches');
}

const BIN_PATH = path.join(__dirname, '../bin');

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled rejection: ', promise, 'reason:', reason);
});

async function getTarget() {
  const arch = process.env.npm_config_arch || os.arch();

  switch (os.platform()) {
    case 'darwin':
      return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    case 'win32':
      return arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : 'i686-pc-windows-msvc';
    case 'linux':
      // Check for specific environment variable to determine if we should use gnu or musl for arm64
      if (arch === 'arm64') {
        return process.env.VSCODE_RIPGREP_LIBC === 'gnu'
          ? 'aarch64-unknown-linux-gnu'
          : 'aarch64-unknown-linux-musl';
      }

      return arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : arch === 'arm'
        ? 'arm-unknown-linux-gnueabihf'
        : arch === 'armv7l'
        ? 'arm-unknown-linux-gnueabihf'
        : arch === 'ppc64'
        ? 'powerpc64le-unknown-linux-gnu'
        : arch === 's390x'
        ? 's390x-unknown-linux-gnu'
        : 'i686-unknown-linux-musl';
    default:
      throw new Error(`Unknown platform: ${os.platform()}`);
  }
}

/**
 * Sleep for a specified number of milliseconds
 * @param {number} ms Time to sleep in milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn Function to retry
 * @param {number} maxRetries Maximum number of retries
 * @returns {Promise<any>}
 */
async function retry(fn, maxRetries = 5) {
  let retries = 0;
  let lastError;

  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      retries++;

      if (retries >= maxRetries) {
        break;
      }

      const delay = 2 ** retries * 1000;
      console.error(err);
      console.log(
        `Download attempt ${retries} failed, retrying in ${
          delay / 1000
        } seconds...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

async function main() {
  const binExists = await fsExists(BIN_PATH);
  if (!forceInstall && binExists) {
    console.log('bin/ folder already exists, exiting');
    process.exit(0);
  }

  if (!binExists) {
    await mkdir(BIN_PATH);
  }

  const target = await getTarget();
  const opts = {
    target,
    destDir: BIN_PATH,
    force: forceInstall,
  };

  try {
    await retry(() => download(opts));
  } catch (err) {
    console.error(
      `Downloading ripgrep failed after multiple retries: ${err.stack}`
    );
    process.exit(1);
  }
}

main();

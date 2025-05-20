const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const util = require('node:util');
const url = require('node:url');
const stream = require('node:stream');
const child_process = require('node:child_process');
const proxy_from_env = require('proxy-from-env');
const yauzl = require('yauzl'); // use yauzl ^2.9.2 because vscode already ships with it.
const packageVersion = require('../package.json').version;
const tmpDir = path.join(os.tmpdir(), `vscode-ripgrep-cache-${packageVersion}`);
const config = require('./config.json');

const fsUnlink = util.promisify(fs.unlink);
const fsExists = util.promisify(fs.exists);
const fsMkdir = util.promisify(fs.mkdir);

const isWindows = os.platform() === 'win32';
const pipelineAsync = util.promisify(stream.pipeline);

// No longer need isGithubUrl function as we're not using GitHub API

/**
 * @param {string} _url
 * @param {fs.PathLike} dest
 * @param {any} opts
 */
function download(_url, dest, opts) {
  const proxy = proxy_from_env.getProxyForUrl(url.parse(_url));
  if (proxy !== '') {
    const HttpsProxyAgent = require('https-proxy-agent');
    opts = {
      ...opts,
      agent: new HttpsProxyAgent.HttpsProxyAgent(proxy),
      proxy,
    };
  }

  return new Promise((resolve, reject) => {
    console.log(`Download options: ${JSON.stringify(opts)}`);
    const outFile = fs.createWriteStream(dest);
    const mergedOpts = {
      ...url.parse(_url),
      ...opts,
    };
    https
      .get(mergedOpts, (response) => {
        console.log(`statusCode: ${response.statusCode}`);
        if (response.statusCode === 302) {
          response.resume();
          console.log(`Following redirect to: ${response.headers.location}`);
          return download(response.headers.location, dest, opts).then(
            resolve,
            reject
          );
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with ${response.statusCode}`));
          return;
        }

        response.pipe(outFile);
        outFile.on('finish', () => {
          resolve();
        });
      })
      .on('error', async (err) => {
        await fsUnlink(dest);
        reject(err);
      });
  });
}

// No longer need get function as we're not using GitHub API

/**
 * @param {{ force: boolean; token: string; target: string; }} opts
 * @param {string} assetName
 * @param {string} downloadFolder
 */
async function getAssetFromConfig(opts, assetName, downloadFolder) {
  const assetDownloadPath = path.join(downloadFolder, assetName);

  // We can just use the cached binary
  if (!opts.force && (await fsExists(assetDownloadPath))) {
    console.log(`Using cached download: ${assetDownloadPath}`);
    return assetDownloadPath;
  }

  // Get platform configuration
  const platform = config.platforms[opts.target];
  if (!platform) {
    throw new Error(`Platform not found in config: ${opts.target}`);
  }

  const downloadOpts = {
    headers: {
      'user-agent': 'vscode-ripgrep',
    },
  };

  console.log(`Using download URL from config for ${opts.target}`);
  console.log(`Downloading from ${platform.url}`);
  console.log(`Downloading to ${assetDownloadPath}`);

  await download(platform.url, assetDownloadPath, downloadOpts);
  return assetDownloadPath;
}

/**
 * @param {string} zipPath
 * @param {string} destinationDir
 */
function unzipWindows(zipPath, destinationDir) {
  // code from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
  return new Promise((resolve, reject) => {
    try {
      // Create folder if not exists
      fs.promises.mkdir(path.dirname(destinationDir), { recursive: true });

      // Same as example we open the zip.
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
        if (err) {
          zipFile.close();
          reject(err);
          return;
        }

        // This is the key. We start by reading the first entry.
        zipFile.readEntry();

        // Now for every entry, we will write a file or dir
        // to disk. Then call zipFile.readEntry() again to
        // trigger the next cycle.
        zipFile.on('entry', (entry) => {
          try {
            // Directories
            if (/\/$/.test(entry.fileName)) {
              // Create the directory then read the next entry.
              fs.promises.mkdir(path.join(destinationDir, entry.fileName), {
                recursive: true,
              });
              zipFile.readEntry();
            }
            // Files
            else {
              // Write the file to disk.
              zipFile.openReadStream(entry, (readErr, readStream) => {
                if (readErr) {
                  zipFile.close();
                  reject(readErr);
                  return;
                }

                const file = fs.createWriteStream(
                  path.join(destinationDir, entry.fileName)
                );
                readStream.pipe(file);
                file.on('finish', () => {
                  // Wait until the file is finished writing, then read the next entry.
                  // @ts-ignore: Typing for close() is wrong.
                  file.close(() => {
                    zipFile.readEntry();
                  });

                  file.on('error', (err) => {
                    zipFile.close();
                    reject(err);
                  });
                });
              });
            }
          } catch (e) {
            zipFile.close();
            reject(e);
          }
        });
        zipFile.on('end', () => {
          resolve();
        });
        zipFile.on('error', (err) => {
          zipFile.close();
          reject(err);
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

// No longer need sanitizePathForPowershell function

function untar(zipPath, destinationDir) {
  return new Promise((resolve, reject) => {
    const unzipProc = child_process.spawn(
      'tar',
      ['xvf', zipPath, '-C', destinationDir],
      { stdio: 'inherit' }
    );
    unzipProc.on('error', (err) => {
      reject(err);
    });
    unzipProc.on('close', (code) => {
      console.log(`tar xvf exited with ${code}`);
      if (code !== 0) {
        reject(new Error(`tar xvf exited with ${code}`));
        return;
      }

      resolve();
    });
  });
}

/**
 * @param {string} zipPath
 * @param {string} destinationDir
 */
async function unzipRipgrep(zipPath, destinationDir) {
  if (isWindows) {
    await unzipWindows(zipPath, destinationDir);
  } else {
    await untar(zipPath, destinationDir);
  }

  const expectedName = path.join(destinationDir, 'rg');
  if (await fsExists(expectedName)) {
    return expectedName;
  }

  if (await fsExists(`${expectedName}.exe`)) {
    return `${expectedName}.exe`;
  }

  throw new Error(
    `Expecting rg or rg.exe unzipped into ${destinationDir}, didn't find one.`
  );
}

module.exports = async (opts) => {
  if (!opts.target) {
    return Promise.reject(new Error('Missing target'));
  }

  // Get platform configuration
  const platform = config.platforms[opts.target];
  if (!platform) {
    return Promise.reject(
      new Error(`Platform not found in config: ${opts.target}`)
    );
  }

  const extension = platform.extension;
  const assetName = `ripgrep-${config.version}-${opts.target}${extension}`;

  if (!(await fsExists(tmpDir))) {
    await fsMkdir(tmpDir);
  }

  const assetDownloadPath = path.join(tmpDir, assetName);
  try {
    await getAssetFromConfig(opts, assetName, tmpDir);
  } catch (e) {
    console.log('Deleting invalid download cache');
    try {
      await fsUnlink(assetDownloadPath);
    } catch (e) {}

    throw e;
  }

  console.log(`Unzipping to ${opts.destDir}`);
  try {
    const destinationPath = await unzipRipgrep(assetDownloadPath, opts.destDir);
    if (!isWindows) {
      await util.promisify(fs.chmod)(destinationPath, '755');
    }
  } catch (e) {
    console.log('Deleting invalid download');

    try {
      await fsUnlink(assetDownloadPath);
    } catch (e) {}

    throw e;
  }
};

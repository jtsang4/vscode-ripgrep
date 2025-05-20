const path = require('node:path');

module.exports.rgPath = path.join(
  __dirname,
  `../bin/rg${process.platform === 'win32' ? '.exe' : ''}`
);

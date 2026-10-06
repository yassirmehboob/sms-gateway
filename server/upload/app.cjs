'use strict';
process.chdir(__dirname);
if (typeof PhusionPassenger !== 'undefined') process.env.DEPLOYMENT_MODE = 'passenger';
import('./dist/index.js').catch(error => {
  console.error('Gateway startup failed:', error);
  process.exit(1);
});

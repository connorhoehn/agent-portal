const root = '/Users/connorhoehn/Projects/aws-agentcore/middleware';
const config = require(root + '/jest.config.cjs');
module.exports = { ...config, rootDir: root, setupFilesAfterEnv: [] };

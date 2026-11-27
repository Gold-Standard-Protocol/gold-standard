/* eslint-disable */
module.exports = async function () {
  const child = globalThis.__API_CHILD__;
  if (child && !child.killed) child.kill('SIGTERM');
};

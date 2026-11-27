import { StartExecutorSchema } from './schema';
import { ChildProcess, exec } from 'child_process';
// Default import, not a namespace import. chalk@4 is CommonJS and its module.exports
// IS the callable chalk instance, with bgGreen/bgBlue hung off it as non-own
// properties. Under esModuleInterop, __importStar does not carry those across, so
// `import * as chalk` yields an object where chalk.bgGreen is undefined at runtime
// while still type-checking cleanly.
import chalk from 'chalk';

const LARGE_BUFFER = 1024 * 1000000;

export default async function runExecutor(options: StartExecutorSchema) {
  const prefixSize =
    Math.max(options.backendProject.length, options.frontendProject.length) + 3;
  await startBackendServer(options, prefixSize);
  return { success: true };
}

async function startBackendServer(
  options: StartExecutorSchema,
  targetPadSize: number
) {
  let frontendServerStarted = false;
  return new Promise(() => {
    const childProcess = exec(`npx nx serve ${options.backendProject}`, {
      maxBuffer: LARGE_BUFFER,
    });
    process.on('exit', () => childProcess.kill());
    process.on('SIGTERM', () => childProcess.kill());
    prefixTerminalOutput(
      childProcess,
      chalk.bgGreen(padTargetName(options.backendProject, targetPadSize))
    );
    childProcess.stdout?.on('data', (data) => {
      if (
        !frontendServerStarted &&
        data.includes('Listening')
      ) {
        startFrontendServer(options.frontendProject, targetPadSize);
        frontendServerStarted = true;
      }
    });
  });
}

async function startFrontendServer(
  frontendProject: string,
  targetPadSize: number
) {
  return new Promise(() => {
    const childProcess = exec(`npx nx serve ${frontendProject}`, {
      maxBuffer: LARGE_BUFFER,
    });
    process.on('exit', () => childProcess.kill());
    process.on('SIGTERM', () => childProcess.kill());
    prefixTerminalOutput(
      childProcess,
      chalk.bgBlue(padTargetName(frontendProject, targetPadSize))
    );
  });
}

function prefixTerminalOutput(cp: ChildProcess, prefix: string) {
  function logWithPrefix(data: string) {
    if (!data) {
      return;
    }
    console.log(
      data
        .split('\n')
        .map((line) => `${prefix} ${line}`)
        .join('\n')
    );
  }
  cp.stdout?.on('data', logWithPrefix);
  cp.stdout?.on('error', logWithPrefix);
  cp.stderr?.on('data', logWithPrefix);
  cp.stderr?.on('error', logWithPrefix);
}

function padTargetName(name: string, targetSize: number) {
  const builder = [`${name}`];
  builder.push(' '.repeat(Math.floor((targetSize - name.length) / 2)));
  builder.unshift(' '.repeat(Math.ceil((targetSize - name.length) / 2)));
  builder.push(' ');
  return builder.join('');
}
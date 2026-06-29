import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content);
}

function replaceOrThrow(content, search, replacement, file) {
  if (!content.includes(search)) {
    throw new Error(`Patch target not found in ${file}: ${search.slice(0, 120)}`);
  }
  return content.replace(search, replacement);
}

function patchMain() {
  const file = 'src/main.ts';
  const desired = `/**
 * Scrypted plugin entry point. Scrypted instantiates the default export as the
 * plugin device.
 *
 * The same bundled file is also used as the child-process entry point for the
 * legacy crypto fallback. Avoid importing the Scrypted SDK/plugin graph in that
 * mode: the child is a plain Node process with only IPC and EUFY_CHILD_CONFIG.
 */
let pluginDefault: unknown;

if (process.env.EUFY_CHILD_CONFIG && process.send) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runChildWrapper } = require('./fallback/child-wrapper');
  runChildWrapper();
  pluginDefault = class EufySecurityChildProcessPlaceholder {};
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pluginDefault = require('./plugin').EufySecurityPlugin;
}

export default pluginDefault;
`;

  const current = read(file);
  if (current === desired) return;
  write(file, desired);
  console.log(`patched ${file}`);
}

function patchChildWrapper() {
  const file = 'src/fallback/child-wrapper.ts';
  let content = read(file);

  if (!content.includes('export function runChildWrapper(): void')) {
    content = replaceOrThrow(
      content,
      'function main(): void {',
      'export function runChildWrapper(): void {',
      file,
    );
  }

  if (content.includes('\nmain();\n')) {
    content = replaceOrThrow(
      content,
      '\nmain();\n',
      '\nif (require.main === module) {\n  runChildWrapper();\n}\n',
      file,
    );
  }

  write(file, content);
  console.log(`patched ${file}`);
}

function patchEufyClient() {
  const file = 'src/eufy-client.ts';
  let content = read(file);

  content = content.replace(
    'const childPath = path.join(__dirname, "fallback", "child-wrapper.js");',
    'const childPath = __filename;',
  );

  const oldCreate = `/**
 * Build a connected {@link IEufyClient}. Tries the in-process direct client
 * first; on a crypto-padding failure ({@link EufyCryptoError}) it transparently
 * falls back to the legacy-crypto child process.
 */
export async function createEufyClient(
  config: EufyPluginConfig,
): Promise<IEufyClient> {
  const log = new Logger("EufyFactory");
  try {
    const client = new DirectEufyClient(config);
    await client.connect();
    log.info("connected via in-process direct client");
    return client;
  } catch (err) {
    if (err instanceof EufyCryptoError) {
      log.warn("PKCS1 not supported natively, using child process fallback");
      const fallback = new ChildProcessEufyClient(config);
      await fallback.connect();
      log.info("connected via legacy-crypto child process");
      return fallback;
    }
    throw err;
  }
}
`;

  const newCreate = `const DISCOVERY_PROBE_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(\`\${label} timed out after \${timeoutMs}ms\`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeClient(client: IEufyClient, label: string): Promise<void> {
  await withTimeout(client.getStations(), DISCOVERY_PROBE_TIMEOUT_MS, \`\${label} getStations()\`);
}

/**
 * Build a connected {@link IEufyClient}. Tries the in-process direct client
 * first, but treats a hung discovery probe the same as a startup failure.
 *
 * On some HomeBase/account combinations the direct client emits a successful
 * connect event but then hangs forever on getStations()/getDevices(). In that
 * case Scrypted never discovers any camera. Fall back to the child-process path
 * when the direct discovery probe times out, not only on crypto errors.
 */
export async function createEufyClient(
  config: EufyPluginConfig,
): Promise<IEufyClient> {
  const log = new Logger("EufyFactory");
  let direct: DirectEufyClient | undefined;

  try {
    direct = new DirectEufyClient(config);
    await direct.connect();
    await probeClient(direct, "direct client");
    log.info("connected via in-process direct client");
    return direct;
  } catch (err) {
    await direct?.disconnect().catch(() => undefined);

    if (err instanceof EufyCryptoError) {
      log.warn("PKCS1 not supported natively, using child process fallback");
    } else {
      log.warn("direct client failed or hung during discovery; using child process fallback", err);
    }

    const fallback = new ChildProcessEufyClient(config);
    try {
      await fallback.connect();
      await probeClient(fallback, "child process client");
      log.info("connected via legacy-crypto child process");
      return fallback;
    } catch (fallbackErr) {
      await fallback.disconnect().catch(() => undefined);
      throw fallbackErr;
    }
  }
}
`;

  if (!content.includes(newCreate)) {
    content = replaceOrThrow(content, oldCreate, newCreate, file);
  }

  write(file, content);
  console.log(`patched ${file}`);
}

patchMain();
patchChildWrapper();
patchEufyClient();

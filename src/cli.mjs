import { parseArgs } from 'node:util';
import {
  cmdBrief,
  cmdCheck,
  cmdDoctor,
  cmdGate,
  cmdInit,
  cmdVerdict,
} from './commands.mjs';
import { cmdInstall, cmdUninstall, PROVIDER_NAMES } from './install.mjs';
import { UserError, VERSION } from './lib.mjs';

const HELP = `hardproof ${VERSION} — evidence-gated verification for coding agents

Usage:
  hardproof init --goal <text> --check <command> [--kind bug|feature|refactor] [--request <text>] [--cause <text>] [--check ...] [--scope <glob>]... [--timeout <s>] [--allow-dirty] [--force]
  hardproof check [--json] [--allow-scope-breach]
  hardproof verdict pass|fail --summary <text> [--finding <text>]... [--test-review <text>] [--verifier <name>]
  hardproof brief
  hardproof gate [--json] [--allow-scope-breach]
  hardproof install <${PROVIDER_NAMES.join('|')}> [--global|--project] [--dir <path>] [--force] [--dry-run]
  hardproof uninstall <provider> [--global|--project] [--dir <path>] [--force]
  hardproof doctor [--strict]

Run from inside a git repository. State lives in .proof/ and is excluded from git.
`;

function parse(options, args) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UserError(error.message);
  }
}

function rejectBoth(options) {
  if (options.global && options.project) {
    throw new UserError('--global and --project are mutually exclusive.');
  }
}

export async function main(argv) {
  const [command, ...rest] = argv;

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(HELP);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      console.log(VERSION);
      return 0;
    }

    if (command === 'init') {
      const { values } = parse(
        {
          goal: { type: 'string' },
          kind: { type: 'string' },
          request: { type: 'string' },
          cause: { type: 'string' },
          check: { type: 'string', multiple: true },
          scope: { type: 'string', multiple: true },
          timeout: { type: 'string' },
          'allow-dirty': { type: 'boolean', default: false },
          force: { type: 'boolean', default: false },
        },
        rest,
      );
      return await cmdInit({
        ...values,
        allowDirty: values['allow-dirty'],
      });
    }

    if (command === 'check') {
      const { values } = parse(
        {
          json: { type: 'boolean', default: false },
          'allow-scope-breach': { type: 'boolean', default: false },
        },
        rest,
      );
      return await cmdCheck({
        json: values.json,
        allowScopeBreach: values['allow-scope-breach'],
      });
    }

    if (command === 'verdict') {
      const { values, positionals } = parse(
        {
          summary: { type: 'string' },
          finding: { type: 'string', multiple: true },
          'test-review': { type: 'string' },
          verifier: { type: 'string' },
        },
        rest,
      );
      return cmdVerdict(positionals, {
        ...values,
        testReview: values['test-review'],
      });
    }

    if (command === 'brief') {
      parse({}, rest);
      return cmdBrief();
    }

    if (command === 'gate') {
      const { values } = parse(
        {
          json: { type: 'boolean', default: false },
          'allow-scope-breach': { type: 'boolean', default: false },
        },
        rest,
      );
      return await cmdGate({
        json: values.json,
        allowScopeBreach: values['allow-scope-breach'],
      });
    }

    if (command === 'install' || command === 'uninstall') {
      const { values, positionals } = parse(
        {
          global: { type: 'boolean', default: false },
          project: { type: 'boolean', default: false },
          dir: { type: 'string' },
          force: { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
        },
        rest,
      );
      rejectBoth(values);
      const options = {
        project: values.project,
        dir: values.dir,
        force: values.force,
        dryRun: values['dry-run'],
      };
      return command === 'install'
        ? cmdInstall(positionals[0], options)
        : cmdUninstall(positionals[0], options);
    }

    if (command === 'doctor') {
      const { values } = parse(
        { strict: { type: 'boolean', default: false } },
        rest,
      );
      return cmdDoctor(values);
    }

    throw new UserError(`unknown command "${command}". Run hardproof help.`);
  } catch (error) {
    if (error instanceof UserError) {
      console.error(`hardproof: ${error.message}`);
      return 1;
    }
    console.error(error.stack ?? String(error));
    return 1;
  }
}

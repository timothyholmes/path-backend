import { Client } from 'pg';
import { getDatabaseConfig } from '../client';
import { Seeder } from './generators';
import { Rng } from './rng';
import { Scenario, SeedSummary } from './types';
import { empty } from './scenarios/empty';
import { newUser } from './scenarios/newUser';
import { activeFree } from './scenarios/activeFree';
import { premiumPowerUser } from './scenarios/premiumPowerUser';
import { edgeCases } from './scenarios/edgeCases';

export const SCENARIOS: Record<string, Scenario> = {
  [empty.name]: empty,
  [newUser.name]: newUser,
  [activeFree.name]: activeFree,
  [premiumPowerUser.name]: premiumPowerUser,
  [edgeCases.name]: edgeCases,
};

/** Tables reported in the summary, so tests can assert on exact row counts. */
const COUNTED_TABLES = [
  'profiles',
  'virtues',
  'routines',
  'routine_virtues',
  'routine_completions',
  'goals',
  'goal_virtues',
  'goal_backlog',
  'sessions',
  'session_virtues',
  'session_instances',
  'field_log_templates',
  'field_logs',
  'field_log_virtues',
  'retrospectives',
  'xp_ledger',
  'daily_activity',
] as const;

async function tableCounts(client: Client): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const table of COUNTED_TABLES) {
    const { rows } = await client.query<{ count: string }>(`select count(*) from public.${table}`);
    counts[table] = Number(rows[0].count);
  }

  return counts;
}

export interface SeedOptions {
  client: Client;
  scenario: string;
  /** The date the scenario treats as "today". Defaults to now. */
  asOf?: Date;
  /** Overrides the PRNG seed; defaults to the scenario name, keeping runs stable. */
  rngSeed?: string;
}

export async function seed(options: SeedOptions): Promise<SeedSummary> {
  const scenario = SCENARIOS[options.scenario];

  if (!scenario) {
    throw new Error(
      `Unknown scenario "${options.scenario}". Available: ${Object.keys(SCENARIOS).join(', ')}`,
    );
  }

  const seeder = new Seeder(options.client);
  const context = {
    client: options.client,
    seeder,
    rng: new Rng(options.rngSeed ?? scenario.name),
    asOf: options.asOf ?? new Date(),
  };

  // One transaction for the whole scenario: a scenario that fails part way
  // through leaves no partial user behind.
  await options.client.query('begin');
  let users;
  try {
    users = await scenario.run(context);
    await options.client.query('commit');
  } catch (error) {
    await options.client.query('rollback');
    throw error;
  }

  return {
    scenario: scenario.name,
    users,
    counts: await tableCounts(options.client),
  };
}

function parseArgs(argv: string[]): { scenario: string; asOf?: Date } {
  let scenario = 'active-free';
  let asOf: Date | undefined;

  for (const arg of argv) {
    const scenarioMatch = /^--scenario=(.+)$/.exec(arg);
    if (scenarioMatch) {
      scenario = scenarioMatch[1];
      continue;
    }

    const asOfMatch = /^--as-of=(.+)$/.exec(arg);
    if (asOfMatch) {
      asOf = new Date(asOfMatch[1]);
      if (Number.isNaN(asOf.getTime())) {
        throw new Error(`--as-of must be a valid date, got "${asOfMatch[1]}"`);
      }
    }
  }

  return { scenario, asOf };
}

export async function main(): Promise<void> {
  const { scenario, asOf } = parseArgs(process.argv.slice(2));
  const { url, statementTimeoutMs } = getDatabaseConfig();
  const client = new Client({ connectionString: url, statement_timeout: statementTimeoutMs });

  await client.connect();

  try {
    const summary = await seed({ client, scenario, asOf });

    console.log(`[seed] scenario: ${summary.scenario}`);
    for (const user of summary.users) {
      console.log(`[seed]   user ${user.email} (${user.tier}) ${user.id}`);
    }
    for (const [table, count] of Object.entries(summary.counts)) {
      if (count > 0) console.log(`[seed]   ${table}: ${count}`);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(`[seed] ${error.message}`);
    process.exit(1);
  });
}
